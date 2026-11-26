import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import {
  chinaDay,
  IDEA_PAGE_SIZE,
  emptyIdeaNote,
  type Idea,
  type IdeaContent,
  type IdeaCardItem,
  type IdeaDetail,
  type IdeaNote,
  type IdeaOrigin,
  type IdeaQuery,
  type SourceStatus,
} from '../../src/shared/trading-ideas'
import {
  canonicalKey,
  publicationDay,
  paperSummaryUrl,
  isAbstractExtension,
  needsPaperSummary,
  type CollectedIdea,
} from './content'
import { isStrategyIdea } from './strategy'

type ItemRow = {
  id: string
  content: string
  first_seen: number
  note?: string | null
}
type StoredEntry = ItemRow & { rank: number; version: number | null; strategy: number }

const visibleEntries = "e.scope = ? OR (e.scope = '' AND e.strategy = 1)"

function idea(row: ItemRow): Idea {
  return {
    ...(JSON.parse(row.content) as IdeaContent),
    id: row.id,
    firstSeen: row.first_seen,
    personal: row.note ? (JSON.parse(row.note) as IdeaNote) : { ...emptyIdeaNote },
  }
}

export class IdeaArchive {
  private readonly db: DatabaseSync
  private readonly file: string

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.file = join(directory, 'archive.sqlite')
    this.db = new DatabaseSync(this.file)
    try {
      chmodSync(this.file, 0o600)
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
      const { user_version: version } = this.db.prepare('PRAGMA user_version').get()!
      if (version === 0) this.createTables()
      if (version === 1) this.filterLegacyEntries()
      if (version !== 0 && version !== 1 && version !== 2)
        throw new Error('交易灵感资料库的版本不受支持')
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private createTables() {
    this.db.exec(`
      BEGIN;
      CREATE TABLE entries (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, key TEXT NOT NULL, content TEXT NOT NULL,
        first_seen INTEGER NOT NULL, collected_day TEXT NOT NULL, published_day TEXT,
        category TEXT NOT NULL, rank INTEGER NOT NULL, version INTEGER, strategy INTEGER NOT NULL,
        UNIQUE(scope, key)
      );
      CREATE INDEX entries_collected ON entries(scope, collected_day, first_seen);
      CREATE INDEX entries_published ON entries(scope, published_day, first_seen);
      CREATE TABLE origins (
        entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        source TEXT NOT NULL, url TEXT NOT NULL, PRIMARY KEY(entry_id, source, url)
      );
      CREATE TABLE revisions (
        id INTEGER PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        captured_at INTEGER NOT NULL, content TEXT NOT NULL
      );
      CREATE TABLE annotations (
        account_id TEXT NOT NULL, entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        data TEXT NOT NULL, PRIMARY KEY(account_id, entry_id)
      );
      CREATE TABLE evidence_history (
        id INTEGER PRIMARY KEY, account_id TEXT NOT NULL,
        entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        captured_at INTEGER NOT NULL, evidence TEXT
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE source_runs (
        id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, attempted_at INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      CREATE INDEX source_run_time ON source_runs(source_id, id DESC);
      PRAGMA user_version = 2;
      COMMIT;
    `)
  }

  private filterLegacyEntries() {
    this.transaction(() => {
      this.db.exec('ALTER TABLE entries ADD COLUMN strategy INTEGER NOT NULL DEFAULT 0')
      const read = this.db.prepare(
        "SELECT id, content FROM entries WHERE scope = '' ORDER BY id LIMIT 500",
      )
      const next = this.db.prepare(
        "SELECT id, content FROM entries WHERE scope = '' AND id > ? ORDER BY id LIMIT 500",
      )
      const update = this.db.prepare('UPDATE entries SET strategy = 1 WHERE id = ?')
      let batch = read.all()
      while (batch.length) {
        for (const row of batch) {
          if (isStrategyIdea(JSON.parse(row.content as string) as IdeaContent)) update.run(row.id!)
        }
        batch = next.all(batch.at(-1)!.id!)
      }
      this.db.exec('PRAGMA user_version = 2')
    })
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = operation()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  setting(key: string): string | undefined {
    return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value as
      string | undefined
  }

  set(key: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value)
  }

  sourceHistory(limit = 180) {
    return this.db
      .prepare('SELECT status FROM source_runs ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((row) => JSON.parse(row.status as string) as SourceStatus)
  }

  lastSource(id: string): SourceStatus | undefined {
    const row = this.db
      .prepare('SELECT status FROM source_runs WHERE source_id = ? ORDER BY id DESC LIMIT 1')
      .get(id)
    return row && (JSON.parse(row.status as string) as SourceStatus)
  }

  recordFailure(status: SourceStatus) {
    this.recordRun(status)
  }

  recordCollection(items: CollectedIdea[], status: SourceStatus, rank: number, partial = false) {
    return this.transaction(() => {
      let added = 0
      for (const item of items)
        if (
          isStrategyIdea(item) &&
          this.upsert('', status.label, item, status.attemptedAt!, rank).added
        )
          added++
      this.recordRun({
        ...status,
        added,
        outcome: partial ? '失败' : added > 0 ? '有新增' : '无新增',
      })
      return added
    })
  }

  private recordRun(status: SourceStatus) {
    this.db
      .prepare('INSERT INTO source_runs (source_id, attempted_at, status) VALUES (?, ?, ?)')
      .run(status.id, status.attemptedAt, JSON.stringify(status))
    this.db
      .prepare('DELETE FROM source_runs WHERE attempted_at < ?')
      .run(status.attemptedAt! - 90 * 86400000)
  }

  addManual(accountId: string, content: CollectedIdea, time: number) {
    return this.transaction(() => {
      const shared = this.db
        .prepare("SELECT id FROM entries WHERE scope = '' AND strategy = 1 AND key = ?")
        .get(canonicalKey(content.url))
      if (shared) {
        const id = shared.id as string
        if (content.summary) {
          const current = this.detail(accountId, id)!.personal
          const note = [current.note, content.summary].filter(Boolean).join('\n\n').slice(0, 4000)
          this.writeNote(accountId, id, { ...current, note }, time)
        }
        return id
      }
      return this.upsert(accountId, '手动收录', content, time, 0).id
    })
  }

  private upsert(
    scope: string,
    source: string,
    incoming: CollectedIdea,
    time: number,
    rank: number,
  ) {
    const { key, sourceVersion, ...entry } = incoming
    const previous = this.db
      .prepare(
        'SELECT id, content, first_seen, rank, version, strategy FROM entries WHERE scope = ? AND key = ?',
      )
      .get(scope, key) as StoredEntry | undefined
    const id = previous?.id ?? randomUUID()
    if (!previous) {
      this.db
        .prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
        .run(
          id,
          scope,
          key,
          JSON.stringify(entry),
          time,
          chinaDay(time),
          publicationDay(entry.publication),
          entry.category,
          rank,
          sourceVersion ?? null,
        )
    } else if (
      rank >= previous.rank &&
      (rank > previous.rank ||
        previous.version === null ||
        (sourceVersion ?? 0) >= previous.version)
    ) {
      const old = JSON.parse(previous.content) as IdeaContent
      const retainFirstPublication = previous.version !== null && rank === previous.rank
      const next = {
        ...entry,
        publication:
          (retainFirstPublication ? old.publication : entry.publication) ?? old.publication,
      }
      const samePaperVersion =
        old.category === '论文' &&
        entry.category === '论文' &&
        rank === previous.rank &&
        (sourceVersion ?? null) === previous.version
      if (samePaperVersion && isAbstractExtension(next.summary, old.summary))
        next.summary = old.summary
      const previousContent =
        samePaperVersion && isAbstractExtension(old.summary, next.summary)
          ? JSON.stringify({ ...old, summary: next.summary })
          : previous.content
      const changed = JSON.stringify(next) !== previousContent
      const advanced =
        sourceVersion !== undefined && previous.version !== null && sourceVersion > previous.version
      if (changed || advanced) {
        this.db
          .prepare('INSERT INTO revisions (entry_id, captured_at, content) VALUES (?, ?, ?)')
          .run(id, time, previous.content)
      }
      this.db
        .prepare(
          'UPDATE entries SET content = ?, published_day = ?, category = ?, rank = ?, version = ?, strategy = 1 WHERE id = ?',
        )
        .run(
          JSON.stringify(next),
          publicationDay(next.publication),
          next.category,
          rank,
          sourceVersion ?? null,
          id,
        )
    }
    this.db.prepare('INSERT OR IGNORE INTO origins VALUES (?, ?, ?)').run(id, source, entry.url)
    return { id, added: !previous || previous.strategy === 0 }
  }

  overview(accountId: string, time: number) {
    const today = chinaDay(time)
    const items = this.db
      .prepare(
        `
      SELECT e.id, e.first_seen, json_extract(e.content, '$.title') AS title, e.category,
        json_extract(e.content, '$.publication') AS publication,
        json_extract(a.data, '$.priority') AS priority
      FROM entries e LEFT JOIN annotations a ON a.entry_id = e.id AND a.account_id = ?
      WHERE ${visibleEntries}
      ORDER BY coalesce(e.published_day, e.collected_day) DESC,
        CASE WHEN e.published_day IS NOT NULL THEN json_extract(e.content, '$.publication.value') END DESC,
        e.first_seen DESC, e.id DESC
    `,
      )
      .all(accountId, accountId)
      .map((row): IdeaCardItem => ({
        id: row.id as string,
        title: row.title as string,
        category: row.category as IdeaCardItem['category'],
        publication: row.publication
          ? (JSON.parse(row.publication as string) as IdeaCardItem['publication'])
          : null,
        firstSeen: row.first_seen as number,
        priority: (row.priority ?? '未标记') as IdeaCardItem['priority'],
      }))
    return {
      today,
      count: items.filter((item) => chinaDay(item.firstSeen) === today).length,
      items,
    }
  }

  list(accountId: string, query: IdeaQuery) {
    const where = ['(' + visibleEntries + ')']
    const args: SQLInputValue[] = [accountId, accountId]
    if ((query.mode === 'published' || query.mode === 'collected') && query.day) {
      where.push(query.mode === 'published' ? 'e.published_day = ?' : 'e.collected_day = ?')
      args.push(query.day)
    }
    if (query.mode === 'pending') where.push("json_extract(a.data, '$.pending') = 1")
    if (query.category) {
      where.push('e.category = ?')
      args.push(query.category)
    }
    if (query.topic) {
      where.push("EXISTS (SELECT 1 FROM json_each(e.content, '$.topics') WHERE value = ?)")
      args.push(query.topic)
    }
    if (query.text) {
      where.push("instr(lower(e.content || coalesce(a.data, '')), lower(?)) > 0")
      args.push(query.text)
    }
    const order =
      query.mode === 'published'
        ? "e.published_day DESC, json_extract(e.content, '$.publication.value') DESC, e.first_seen DESC, e.id DESC"
        : 'e.first_seen DESC, e.published_day DESC, e.id DESC'
    const rows = this.db
      .prepare(
        `
      SELECT e.id, e.content, e.first_seen, a.data AS note FROM entries e
      LEFT JOIN annotations a ON a.entry_id = e.id AND a.account_id = ?
      WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?
    `,
      )
      .all(...args, IDEA_PAGE_SIZE + 1, query.offset ?? 0) as ItemRow[]
    return { items: rows.slice(0, IDEA_PAGE_SIZE).map(idea), hasMore: rows.length > IDEA_PAGE_SIZE }
  }

  legacyPaper(id: string) {
    const row = this.db
      .prepare(
        "SELECT content, version FROM entries WHERE scope = '' AND strategy = 1 AND id = ? AND category = '论文'",
      )
      .get(id)
    if (!row) return null
    const content = JSON.parse(row.content as string) as IdeaContent
    const url = needsPaperSummary(content.summary)
      ? paperSummaryUrl(content.url, row.version as number | null)
      : null
    return url ? { url, summary: content.summary } : null
  }

  extendPaper(id: string, paper: { url: string; summary: string }, summary: string) {
    const current = this.legacyPaper(id)
    if (current?.url !== paper.url || current.summary !== paper.summary) return false
    if (!isAbstractExtension(paper.summary, summary)) return false
    this.db
      .prepare(
        "UPDATE entries SET content = json_set(content, '$.summary', ?) WHERE id = ? AND scope = ''",
      )
      .run(summary, id)
    return true
  }

  detail(accountId: string, id: string): IdeaDetail | null {
    const row = this.db
      .prepare(
        `
      SELECT e.id, e.content, e.first_seen, a.data AS note FROM entries e
      LEFT JOIN annotations a ON a.entry_id = e.id AND a.account_id = ?
      WHERE (${visibleEntries}) AND e.id = ?
    `,
      )
      .get(accountId, accountId, id) as ItemRow | undefined
    if (!row) return null
    const item = idea(row)
    const origins = this.db
      .prepare('SELECT source, url FROM origins WHERE entry_id = ? ORDER BY url != ?, source, url')
      .all(id, item.url) as IdeaOrigin[]
    const revisions = this.db
      .prepare('SELECT captured_at, content FROM revisions WHERE entry_id = ? ORDER BY id DESC')
      .all(id)
      .map((old) => ({
        capturedAt: old.captured_at as number,
        content: JSON.parse(old.content as string) as IdeaContent,
      }))
    const evidenceHistory = this.db
      .prepare(
        `
      SELECT captured_at AS capturedAt, evidence FROM evidence_history
      WHERE account_id = ? AND entry_id = ? ORDER BY id DESC
    `,
      )
      .all(accountId, id) as IdeaDetail['evidenceHistory']
    const related = item.personal.group
      ? (this.db
          .prepare(
            `
      SELECT e.id, json_extract(e.content, '$.title') AS title, e.category
      FROM entries e JOIN annotations a ON a.entry_id = e.id
      WHERE a.account_id = ? AND json_extract(a.data, '$.group') = ? AND e.id != ? AND (${visibleEntries})
      ORDER BY e.first_seen DESC LIMIT 20
    `,
          )
          .all(accountId, item.personal.group, id, accountId) as IdeaDetail['related'])
      : []
    return { ...item, origins, revisions, evidenceHistory, related }
  }

  saveNote(accountId: string, id: string, note: IdeaNote, time: number) {
    if (
      !this.db
        .prepare(`SELECT e.id FROM entries e WHERE (${visibleEntries}) AND e.id = ?`)
        .get(accountId, id)
    )
      throw new Error('找不到该条目')
    this.transaction(() => this.writeNote(accountId, id, note, time))
  }

  private writeNote(accountId: string, id: string, note: IdeaNote, time: number) {
    const previous = this.db
      .prepare(
        "SELECT json_extract(data, '$.evidence') AS evidence FROM annotations WHERE account_id = ? AND entry_id = ?",
      )
      .get(accountId, id)
    if ((previous?.evidence ?? null) !== note.evidence)
      this.db
        .prepare(
          'INSERT INTO evidence_history (account_id, entry_id, captured_at, evidence) VALUES (?, ?, ?, ?)',
        )
        .run(accountId, id, time, note.evidence)
    this.db
      .prepare(
        `
      INSERT INTO annotations VALUES (?, ?, ?)
      ON CONFLICT(account_id, entry_id) DO UPDATE SET data = excluded.data
    `,
      )
      .run(accountId, id, JSON.stringify(note))
  }

  removeAccount(accountId: string) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM evidence_history WHERE account_id = ?').run(accountId)
      this.db.prepare('DELETE FROM annotations WHERE account_id = ?').run(accountId)
      this.db.prepare('DELETE FROM entries WHERE scope = ?').run(accountId)
    })
  }

  backup() {
    const temp = this.file + '.' + randomUUID() + '.tmp'
    try {
      this.db.prepare('VACUUM INTO ?').run(temp)
      chmodSync(temp, 0o600)
      renameSync(temp, this.file + '.bak')
    } finally {
      rmSync(temp, { force: true })
    }
  }

  close() {
    this.db.close()
  }
}
