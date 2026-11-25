import {
  TELEGRAPH_PAGE_SIZE,
  type TelegraphFeed,
  type TelegraphHistoryPage,
  type TelegraphHistoryResult,
  type TelegraphIssue,
  type TelegraphItem,
} from '../../src/shared/telegraph'
import { TelegraphError, type TelegraphClientAPI } from './client'
import type { TelegraphHistoryCache } from './history-cache'

const FRESH_FOR = 30000
const MIN_REQUEST_INTERVAL = 5000
const IDLE_FOR = 15 * 60 * 1000

function compact(items: TelegraphItem[]) {
  const byId = new Map<number, TelegraphItem>()
  for (const item of items) {
    const previous = byId.get(item.id)
    if (!previous || item.modifiedAt >= previous.modifiedAt) byId.set(item.id, item)
  }
  return [...byId.values()].sort((a, b) => b.publishedAt - a.publishedAt || b.id - a.id)
}

function issueFrom(error: unknown): TelegraphIssue {
  if (error instanceof TelegraphError) return { kind: error.kind, message: error.message }
  return { kind: 'network', message: '暂时无法连接财联社，请稍后重试。' }
}

export class TelegraphService {
  private items: TelegraphItem[] = []
  private historyCursor: number | null = null
  private revision = 0
  private updatedAt: number | null = null
  private stale = false
  private issue: TelegraphIssue | null = null
  private retryAt = 0
  private rateLimitedUntil = 0
  private nextRequestAt = 0
  private lastRead = 0
  private latestRequest?: Promise<TelegraphFeed>
  private historyRequest?: { cursor: number; work: Promise<TelegraphHistoryResult> }
  private maintenance?: ReturnType<typeof setInterval>
  private abort = new AbortController()

  constructor(
    private client: TelegraphClientAPI,
    private changed: () => void,
    private now = Date.now,
    private cache?: TelegraphHistoryCache,
  ) {}

  startMaintenance() {
    void this.cache?.cleanup()
    let minutes = 0
    this.maintenance = setInterval(() => {
      this.expireHead()
      this.cache?.expireMemory()
      if (++minutes % 60 === 0) void this.cache?.cleanup()
    }, 60000).unref()
  }

  private expireHead() {
    if (this.latestRequest || this.now() - this.lastRead < IDLE_FOR) return
    this.items = []
    this.historyCursor = null
    this.updatedAt = null
  }

  private feed(): TelegraphFeed {
    return {
      revision: this.revision,
      items: this.items,
      updatedAt: this.updatedAt,
      stale: this.stale,
      error: this.issue,
      historyCursor: this.historyCursor,
    }
  }

  private noteRateLimit(error: unknown) {
    if (error instanceof TelegraphError && error.kind === 'rate_limit')
      this.rateLimitedUntil = this.now() + error.retryAfter
  }

  async getFeed(force = false): Promise<TelegraphFeed> {
    this.expireHead()
    const time = (this.lastRead = this.now())
    if (this.latestRequest) return this.latestRequest
    if (time < Math.max(this.retryAt, this.rateLimitedUntil, this.nextRequestAt)) return this.feed()
    if (!force && this.updatedAt !== null && !this.stale && time - this.updatedAt < FRESH_FOR)
      return this.feed()

    this.nextRequestAt = time + MIN_REQUEST_INTERVAL
    const newest = this.items[0]?.publishedAt
    const work = (async () => {
      try {
        const incoming = await this.client.page(
          newest ? newest / 1000 : Math.floor(time / 1000),
          newest ? 0 : 1,
          TELEGRAPH_PAGE_SIZE,
          this.abort.signal,
        )
        if (this.abort.signal.aborted) return this.feed()
        const merged = compact([...this.items, ...incoming.items])
        this.items = merged.slice(0, TELEGRAPH_PAGE_SIZE)
        if (merged.length > TELEGRAPH_PAGE_SIZE)
          this.historyCursor = this.items.at(-1)!.publishedAt / 1000
        else if (!newest) this.historyCursor = incoming.nextCursor
        this.updatedAt = this.now()
        this.stale = false
        this.issue = null
        this.retryAt = 0
      } catch (error) {
        if (this.abort.signal.aborted) return this.feed()
        this.issue = issueFrom(error)
        this.stale = true
        this.noteRateLimit(error)
        this.retryAt =
          this.now() +
          (error instanceof TelegraphError && error.retryAfter ? error.retryAfter : 30000)
      }
      this.revision++
      this.changed()
      return this.feed()
    })()
    this.latestRequest = work
    try {
      return await work
    } finally {
      this.latestRequest = undefined
    }
  }

  async loadOlder(cursor: number): Promise<TelegraphHistoryResult> {
    for (;;) {
      if (this.cache) {
        const stored = await this.cache.get(cursor)
        if (stored) return { page: stored }
      }
      const running = this.historyRequest
      if (!running) break
      if (running.cursor === cursor) return running.work
      await running.work
    }
    if (this.now() < this.rateLimitedUntil)
      return { error: { kind: 'rate_limit', message: '财联社请求较频繁，请稍后重试。' } }

    const work = this.fetchHistory(cursor)
    this.historyRequest = { cursor, work }
    try {
      return await work
    } finally {
      this.historyRequest = undefined
    }
  }

  private async fetchHistory(cursor: number): Promise<TelegraphHistoryResult> {
    try {
      const result = await this.client.page(cursor, 1, TELEGRAPH_PAGE_SIZE, this.abort.signal)
      const page: TelegraphHistoryPage = {
        cursor,
        nextCursor: result.nextCursor,
        items: compact(result.items).slice(0, TELEGRAPH_PAGE_SIZE),
      }
      if (!this.abort.signal.aborted && page.nextCursor !== null) await this.cache?.put(page)
      return { page }
    } catch (error) {
      this.noteRateLimit(error)
      return { error: issueFrom(error) }
    }
  }

  resume() {
    this.expireHead()
    this.retryAt = 0
    this.nextRequestAt = 0
    this.stale = true
    this.revision++
    this.changed()
  }

  dispose() {
    clearInterval(this.maintenance)
    this.abort.abort()
  }
}
