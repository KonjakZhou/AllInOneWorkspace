import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import type { IdeaNote, ManualIdea } from '../../src/shared/trading-ideas'
import { IdeaArchive } from './archive'
import { manualContent } from './content'
import { fetchPaperSummary, SourceError, type Collector, type Validators } from './sources'

const DAY = 86400000
const TWO_HOURS = 7200000
const MIN_INTERVAL = 60000
const FAILURE_RETRY = 15 * 60000

// 06:00 in Shanghai is 22:00 UTC on the previous date.
export function latestCollectionSlot(time: number) {
  return Math.floor((time + TWO_HOURS) / DAY) * DAY - TWO_HOURS
}

export class IdeaService {
  private database?: IdeaArchive
  private clock?: ReturnType<typeof setTimeout>
  private snapshotTimer?: ReturnType<typeof setTimeout>
  private inFlight?: Promise<void>
  private backupIssue = ''
  private readonly abort = new AbortController()
  private readonly summaryRequests = new Map<string, Promise<void>>()
  private readonly summaryCooldown = new Map<string, number>()
  private readonly summaryQueues = new Map<string, Promise<void>>()
  private readonly checkedSummaries = new Map<string, number>()

  constructor(
    private directory: string,
    private sources: Collector[],
    private changed: () => void,
    private now = Date.now,
  ) {}

  get archive() {
    return (this.database ??= new IdeaArchive(this.directory))
  }

  start() {
    if (existsSync(join(this.directory, 'archive.sqlite'))) this.resume()
  }

  enable() {
    if (this.archive.setting('enabled') === '1') return
    this.archive.set('enabled', '1')
    this.resume()
  }

  resume() {
    try {
      if (!this.database && !existsSync(join(this.directory, 'archive.sqlite'))) return
      if (this.archive.setting('enabled') !== '1') return
      void this.run(false).catch(() => this.changed())
    } catch {
      this.changed()
    }
  }

  refresh() {
    if (this.archive.setting('enabled') !== '1') this.archive.set('enabled', '1')
    return this.run(true)
  }

  private run(force: boolean) {
    if (this.inFlight) return this.inFlight
    if (this.abort.signal.aborted) return Promise.resolve()
    clearTimeout(this.clock)
    const time = this.now()
    const slot = latestCollectionSlot(time)
    const due = this.sources.filter((source) => {
      const retryAt = Number(this.archive.setting('retry:' + source.id) ?? 0)
      const attempted = Number(this.archive.setting('slot:' + source.id) ?? 0)
      return time >= retryAt && (force || attempted < slot)
    })
    if (!due.length) {
      this.schedule()
      return Promise.resolve()
    }
    const work = Promise.resolve().then(async () => {
      try {
        for (const source of due) {
          if (this.abort.signal.aborted) break
          await this.collect(source, slot)
        }
        if (!this.abort.signal.aborted) this.backup()
      } finally {
        this.inFlight = undefined
        if (!this.abort.signal.aborted) {
          this.schedule()
          this.changed()
        }
      }
    })
    this.inFlight = work
    this.changed()
    return work
  }

  private schedule() {
    clearTimeout(this.clock)
    const time = this.now()
    const slot = latestCollectionSlot(time)
    let next = slot + DAY
    for (const source of this.sources) {
      if (Number(this.archive.setting('slot:' + source.id) ?? 0) >= slot) continue
      next = Math.min(next, Number(this.archive.setting('retry:' + source.id) ?? time))
    }
    this.clock = setTimeout(() => this.resume(), Math.max(1000, next - time)).unref()
  }

  private async collect(source: Collector, slot: number) {
    const retryKey = 'retry:' + source.id
    const slotKey = 'slot:' + source.id
    const previous = this.archive.lastSource(source.id)
    const validatorKey =
      'validators:' + source.id + (source.validatorVersion ? ':' + source.validatorVersion : '')
    const validators = JSON.parse(this.archive.setting(validatorKey) ?? '{}') as Validators
    try {
      const result = await source.read(this.abort.signal, validators)
      if (this.abort.signal.aborted) return
      const completed = this.now()
      this.archive.recordCollection(
        result.items,
        {
          id: source.id,
          label: source.label,
          outcome: '无新增',
          attemptedAt: completed,
          lastSuccess: result.partial ? (previous?.lastSuccess ?? null) : completed,
          details: result.details ?? '',
          added: 0,
        },
        source.rank,
        result.partial,
      )
      if (result.validators) this.archive.set(validatorKey, JSON.stringify(result.validators))
      this.archive.set(
        retryKey,
        String(completed + (result.partial ? FAILURE_RETRY : MIN_INTERVAL)),
      )
      if (!result.partial) this.archive.set(slotKey, String(slot))
    } catch (error) {
      if (this.abort.signal.aborted) return
      const completed = this.now()
      const retry = error instanceof SourceError ? error.retryAfter : 0
      this.archive.recordFailure({
        id: source.id,
        label: source.label,
        outcome: '失败',
        attemptedAt: completed,
        lastSuccess: previous?.lastSuccess ?? null,
        added: 0,
        details: error instanceof SourceError ? error.message : '暂时无法读取来源',
      })
      this.archive.set(retryKey, String(completed + Math.max(retry, FAILURE_RETRY)))
    } finally {
      if (!this.abort.signal.aborted) this.changed()
    }
  }

  overview(accountId: string) {
    const times = this.sources.map((source) => this.archive.lastSource(source.id)?.lastSuccess ?? 0)
    return {
      ...this.archive.overview(accountId, this.now()),
      updatedAt: Math.max(0, ...times) || null,
    }
  }

  detail(accountId: string, id: string) {
    const item = this.archive.detail(accountId, id)
    if (item?.category === '论文') this.completeSummary(id)
    return item
  }

  private completeSummary(id: string) {
    if (this.summaryRequests.has(id) || this.abort.signal.aborted) return
    if ((this.checkedSummaries.get(id) ?? 0) > this.now()) return
    const paper = this.archive.legacyPaper(id)
    if (!paper) return
    const host = new URL(paper.url).hostname
    const previous = this.summaryQueues.get(host) ?? Promise.resolve()
    const request = previous
      .then(async () => {
        const delay = (this.summaryCooldown.get(host) ?? 0) - this.now()
        // A long requested backoff applies to later visits to the paper as well.
        if (delay > 3000) return
        if (delay > 0) await wait(delay, undefined, { signal: this.abort.signal })
        this.abort.signal.throwIfAborted()
        const current = this.archive.legacyPaper(id)
        if (current?.url !== paper.url || current.summary !== paper.summary) return
        this.summaryCooldown.set(host, this.now() + 3000)
        const summary = await fetchPaperSummary(paper.url, this.abort.signal)
        if (this.abort.signal.aborted) return
        if (this.archive.extendPaper(id, paper, summary)) this.saved()
        else {
          for (const [key, until] of this.checkedSummaries)
            if (until <= this.now()) this.checkedSummaries.delete(key)
          this.checkedSummaries.set(id, this.now() + DAY)
        }
      })
      .catch((error: unknown) => {
        if (this.abort.signal.aborted) return
        const retryAfter = error instanceof SourceError ? error.retryAfter : 0
        this.summaryCooldown.set(host, this.now() + Math.max(30000, retryAfter))
      })
      .finally(() => {
        this.summaryRequests.delete(id)
        if (this.summaryQueues.get(host) === request) this.summaryQueues.delete(host)
      })
    this.summaryRequests.set(id, request)
    this.summaryQueues.set(host, request)
  }

  status() {
    return {
      running: Boolean(this.inFlight),
      sources: this.sources.map(
        (source) =>
          this.archive.lastSource(source.id) ?? {
            id: source.id,
            label: source.label,
            outcome: '未运行' as const,
            attemptedAt: null,
            lastSuccess: null,
            details: '',
            added: 0,
          },
      ),
      history: this.archive
        .sourceHistory()
        .filter((record) => this.sources.some((source) => source.id === record.id)),
      backupIssue: this.backupIssue,
    }
  }

  add(accountId: string, input: ManualIdea) {
    const id = this.archive.addManual(accountId, manualContent(input), this.now())
    this.saved()
    return id
  }

  saveNote(accountId: string, id: string, note: IdeaNote) {
    this.archive.saveNote(accountId, id, note, this.now())
    this.saved()
  }

  private saved() {
    this.changed()
    clearTimeout(this.snapshotTimer)
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined
      this.backup()
      this.changed()
    }, 1000).unref()
  }

  removeAccount(accountId: string) {
    if (!this.database && !existsSync(join(this.directory, 'archive.sqlite'))) return
    this.archive.removeAccount(accountId)
    this.backup()
    this.changed()
  }

  private backup() {
    try {
      this.archive.backup()
      this.backupIssue = ''
    } catch {
      this.backupIssue = '资料库备份失败，可检查磁盘空间和目录权限'
    }
  }

  dispose() {
    const unsavedSnapshot = Boolean(this.snapshotTimer)
    clearTimeout(this.clock)
    clearTimeout(this.snapshotTimer)
    this.abort.abort()
    if (unsavedSnapshot) this.backup()
    this.database?.close()
    this.database = undefined
  }
}
