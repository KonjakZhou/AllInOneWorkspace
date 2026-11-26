import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdeaArchive } from '../electron/trading-ideas/archive'
import {
  isAbstractExtension,
  manualContent,
  publication,
  publicationDay,
} from '../electron/trading-ideas/content'
import { isStrategyIdea } from '../electron/trading-ideas/strategy'
import { IdeaService, latestCollectionSlot } from '../electron/trading-ideas/service'
import {
  collectors,
  parseJisilu,
  parseJisiluPost,
  parsePapers,
  parsePaperSummary,
  SourceError,
  type Collector,
} from '../electron/trading-ideas/sources'
import { chinaDay, emptyIdeaNote, type SourceStatus } from '../src/shared/trading-ideas'

const day = Date.parse('2026-11-25T22:00:00Z')
const directories: string[] = []
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), 'ideas-test-'))
  directories.push(path)
  return path
}
afterEach(() => {
  vi.useRealTimers()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function paper(version = 1, text = 'Tests momentum in Chinese stock markets.') {
  return `<rss xmlns:dc="urn:dc"><channel><item>
    <title>Sector Momentum</title><link>https://arxiv.org/abs/2601.12345</link>
    <guid>oai:arXiv.org:2601.12345v${version}</guid><dc:creator>Author Example</dc:creator>
    <description>arXiv:2601.12345v${version} Announce Type: new Abstract: ${text}</description>
    <pubDate>Wed, 25 Nov 2026 00:00:00 -0500</pubDate>
  </item></channel></rss>`
}
const repec = `<rdf:RDF xmlns:dc="urn:dc" xmlns:rdf="urn:rdf" xmlns:rss="urn:rss">
  <rss:item><rss:title>Sector Momentum</rss:title>
  <rss:link>https://d.repec.org/n?u=RePEc:arx:papers:2601.12345</rss:link>
  <rss:description>Research on sector momentum in U.S. ETFs.</rss:description>
  <dc:date>2026-10</dc:date><dc:creator>Author Example</dc:creator></rss:item></rdf:RDF>`
const status = (id: string, time = day): SourceStatus => ({
  id,
  label: id,
  outcome: '无新增',
  attemptedAt: time,
  lastSuccess: time,
  added: 0,
  details: '',
})
const manual = manualContent({
  url: 'https://example.com/rumor?utm_source=example',
  title: '某 ETF 调整传闻',
  author: '',
  category: '未证实传闻',
  evidence: '未证实',
  summary: '个人线索',
  publishedDay: '2026-11-24',
  eventDay: '',
})

describe('trading idea source parsing', () => {
  it('reads both paper formats and marks market and transfer status without inventing a date', () => {
    const [arxiv] = parsePapers(paper(), 'arxiv')
    const [paperInRepec] = parsePapers(repec, 'repec')
    expect(arxiv).toMatchObject({ market: '中国市场', screening: '国内研究', sourceVersion: 1 })
    expect(arxiv.key).toBe(paperInRepec.key)
    expect(paperInRepec).toMatchObject({
      market: '海外市场',
      screening: '迁移候选',
      publication: { value: '2026-10', precision: 'month' },
    })
    expect(publicationDay(paperInRepec.publication)).toBeNull()
    expect(
      parsePapers(
        paper(1, 'Predictability of a statistical series.').replace(
          'Sector Momentum',
          'Statistical Analysis',
        ),
        'arxiv',
      )[0].screening,
    ).toBe('待筛选')
    expect(() => parsePapers('<html>Denied</html>', 'arxiv')).toThrow()
  })

  it('uses the post time instead of the latest reply', () => {
    const list =
      '<div id="c_question_list"><div class="aw-item"><h4><a href="/question/1">某 ETF 传闻</a></h4><span class="aw-text-color-999">回复 2026-11-24 09:00</span></div></div>'
    const post =
      '<div class="aw-question-detail-title"><h1>某 ETF 传闻</h1><div class="aw-question-detail-meta"><span>发表时间 2026-11-20 14:00</span></div><div class="aw-question-detail-txt">简要内容</div></div>'
    const [row] = parseJisilu(list)
    expect(row.item.publication).toBeNull()
    expect(parseJisiluPost(post, row.item)).toMatchObject({
      publication: { value: '2026-11-20T06:00:00.000Z' },
      evidence: '未证实',
    })
    expect(publication('2026-02-31')).toBeNull()
  })
})

describe('trading idea archive', () => {
  it('coalesces the same paper across feeds, preserves revisions and indexes late arrivals by both dates', () => {
    const archive = new IdeaArchive(directory())
    try {
      expect(archive.recordCollection(parsePapers(repec, 'repec'), status('RePEc'), 2)).toBe(1)
      expect(archive.recordCollection(parsePapers(paper(), 'arxiv'), status('arXiv'), 3)).toBe(0)
      archive.recordCollection(
        parsePapers(paper(2, 'Revised Chinese stock analysis with costs.'), 'arxiv'),
        status('arXiv', day + 3600000),
        3,
      )
      archive.recordCollection(parsePapers(paper(), 'arxiv'), status('arXiv', day + 7200000), 3)
      const { items } = archive.list('A', { mode: 'published', day: '2026-11-25' })
      expect(items).toHaveLength(1)
      const [item] = items
      expect(item.summary).toMatch(/Revised/)
      expect(archive.overview('A', day).count).toBe(1)
      expect(archive.list('A', { mode: 'collected', day: chinaDay(day) }).items[0].id).toBe(item.id)
      expect(archive.detail('A', item.id)).toMatchObject({
        origins: expect.arrayContaining([{ source: 'RePEc', url: expect.any(String) }]),
      })
      expect(archive.detail('A', item.id)?.revisions).toHaveLength(2)
    } finally {
      archive.close()
    }
  })

  it('retains longer paper abstracts and fills a legacy excerpt without inventing a new version', () => {
    const archive = new IdeaArchive(directory())
    const full = 'Momentum evidence and trading costs across industry portfolios. '
      .repeat(12)
      .trim()
    const [record] = parsePapers(paper(1, full), 'arxiv')
    expect(record.summary).toBe(full)
    const longer = 'Asset allocation across markets. '.repeat(100).trim()
    expect(isAbstractExtension(longer.slice(0, 2400), longer)).toBe(true)
    expect(parsePaperSummary('<meta name="citation_abstract" content="' + full + '">')).toBe(full)
    try {
      const short = { ...record, summary: full.slice(0, 240) }
      archive.recordCollection([short], status('arXiv'), 3)
      const [item] = archive.list('A', { mode: 'archive' }).items
      const legacy = archive.legacyPaper(item.id)!
      expect(legacy.url).toBe('https://arxiv.org/abs/2601.12345v1')
      expect(archive.extendPaper(item.id, legacy, 'Different abstract. '.repeat(30))).toBe(false)
      expect(archive.extendPaper(item.id, legacy, full)).toBe(true)
      archive.recordCollection([short], status('arXiv', day + 1000), 3)
      expect(archive.detail('A', item.id)).toMatchObject({
        summary: full,
        revisions: [],
      })
    } finally {
      archive.close()
    }
  })

  it('keeps a late historical capture from masking the latest publication on the card', () => {
    const archive = new IdeaArchive(directory())
    try {
      const recent = parsePapers(paper(), 'arxiv')[0]
      archive.recordCollection([recent], status('arXiv'), 3)
      archive.recordCollection(
        [{ ...manual, title: 'A股 ETF 动量轮动规则' }],
        status('社区', day + 1000),
        1,
      )
      expect(archive.overview('A', day + 1000).items[0].title).toBe(recent.title)
      expect(archive.overview('A', day + 1000).count).toBe(2)
    } finally {
      archive.close()
    }
  })

  it('limits automatic intake to strategy ideas and keeps curated manual entries', () => {
    const archive = new IdeaArchive(directory())
    try {
      const disclosure = {
        ...manual,
        category: '官方披露' as const,
        title: '关于股份回购结果的公告',
      }
      const news = { ...manual, title: 'A股券商板块普涨', category: '财经媒体' as const }
      const posts = { ...manual, title: 'ETF份额近20日增加', category: '公开社区与开源' as const }
      const idea = { ...posts, title: 'ETF份额变化能预测行业相对收益吗？' }
      const unrelated = { ...idea, title: 'Solar cells efficiency', category: '论文' as const }
      expect(collectors().map((source) => source.id)).toEqual(['jisilu', 'arxiv', 'repec'])
      expect([disclosure, news, posts, unrelated, idea].map(isStrategyIdea)).toEqual([
        false,
        false,
        false,
        false,
        true,
      ])
      expect(
        archive.recordCollection([disclosure, news, posts, unrelated, idea], status('社区'), 1),
      ).toBe(1)
      archive.addManual(
        'A',
        { ...disclosure, key: disclosure.key + '-manual', url: 'https://example.com/manual' },
        day,
      )
      expect(archive.overview('A', day).count).toBe(2)
      expect(archive.overview('B', day).items.map((item) => item.title)).toEqual([idea.title])
    } finally {
      archive.close()
    }
  })

  it('filters already collected news on upgrade while preserving stored personal data', () => {
    const path = directory()
    const archive = new IdeaArchive(path)
    archive.recordCollection(parsePapers(paper(), 'arxiv'), status('arXiv'), 3)
    archive.addManual('A', { ...manual, key: 'my-idea' }, day)
    archive.close()
    const db = new DatabaseSync(join(path, 'archive.sqlite'))
    db.exec('ALTER TABLE entries DROP COLUMN strategy; PRAGMA user_version = 1')
    db.prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'legacy',
      '',
      'legacy',
      JSON.stringify({ ...manual, category: '财经媒体', title: '市场今日收涨' }),
      day,
      chinaDay(day),
      chinaDay(day),
      '财经媒体',
      1,
      null,
    )
    db.prepare('INSERT INTO annotations VALUES (?, ?, ?)').run(
      'A',
      'legacy',
      JSON.stringify({ ...emptyIdeaNote, note: '旧笔记' }),
    )
    db.close()
    const upgraded = new IdeaArchive(path)
    try {
      expect(upgraded.overview('A', day).count).toBe(2)
      expect(upgraded.list('A', { mode: 'archive' }).items.map((item) => item.title)).not.toContain(
        '市场今日收涨',
      )
      expect(upgraded.detail('A', 'legacy')).toBeNull()
      const raw = new DatabaseSync(join(path, 'archive.sqlite'))
      try {
        expect(
          raw.prepare('SELECT strategy FROM entries WHERE id = ?').get('legacy')?.strategy,
        ).toBe(0)
        expect(
          raw.prepare('SELECT data FROM annotations WHERE entry_id = ?').get('legacy')?.data,
        ).toContain('旧笔记')
      } finally {
        raw.close()
      }
    } finally {
      upgraded.close()
    }
  })

  it('isolates private notes and entries, preserves the evidence timeline and restores a SQLite backup', () => {
    const path = directory()
    const archive = new IdeaArchive(path)
    try {
      const id = archive.addManual('A', manual, day)
      archive.saveNote(
        'A',
        id,
        { ...emptyIdeaNote, pending: true, priority: '高', evidence: '已澄清' },
        day + 1000,
      )
      expect(archive.list('A', { mode: 'pending' }).items).toHaveLength(1)
      expect(archive.detail('B', id)).toBeNull()
      expect(() => archive.saveNote('B', id, emptyIdeaNote, day)).toThrow()
      expect(archive.detail('A', id)?.evidenceHistory).toEqual([
        { capturedAt: day + 1000, evidence: '已澄清' },
      ])
      archive.backup()
      expect(archive.detail('A', id)?.url).toBe('https://example.com/rumor')
    } finally {
      archive.close()
    }
    const recovery = directory()
    copyFileSync(join(path, 'archive.sqlite.bak'), join(recovery, 'archive.sqlite'))
    const restored = new IdeaArchive(recovery)
    try {
      expect(restored.list('A', { mode: 'pending' }).items[0].personal.priority).toBe('高')
      restored.removeAccount('A')
      expect(restored.list('A', { mode: 'archive' }).items).toHaveLength(0)
    } finally {
      restored.close()
    }
  })
})

describe('06:00 Beijing collection', () => {
  it('sets the same slot boundary on a weekend and a weekday', () => {
    expect(latestCollectionSlot(day - 1)).toBe(day - 86400000)
    expect(latestCollectionSlot(day)).toBe(day)
    const saturday = Date.parse('2026-11-27T22:00:00Z')
    expect(latestCollectionSlot(saturday)).toBe(saturday)
  })

  it('runs at the next morning slot without a renderer or manual refresh', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(day - 5000)
    const read = vi.fn(async () => ({ items: [] }))
    const service = new IdeaService(
      directory(),
      [{ id: 'paper', label: '论文', rank: 1, read }],
      () => {},
    )
    try {
      service.archive.set('enabled', '1')
      service.archive.set('slot:paper', String(latestCollectionSlot(Date.now())))
      service.start()
      await vi.advanceTimersByTimeAsync(4999)
      expect(read).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(read).toHaveBeenCalledTimes(1)
      expect(service.status().sources[0].outcome).toBe('无新增')
    } finally {
      service.dispose()
    }
  })

  it('coalesces refreshes, leaves other sources usable during backoff and catches up on restart', async () => {
    let now = day
    const path = directory()
    const read = vi.fn(async () => ({ items: parsePapers(paper(), 'arxiv') }))
    const fail = vi.fn(async () => {
      throw new SourceError('上游限流', 3600000)
    })
    const sources: Collector[] = [
      { id: 'read', label: 'arXiv', rank: 3, read },
      { id: 'fail', label: '例外来源', rank: 1, read: fail },
    ]
    const service = new IdeaService(
      path,
      sources,
      () => {},
      () => now,
    )
    try {
      service.enable()
      await Promise.all([service.refresh(), service.refresh()])
      expect(read).toHaveBeenCalledTimes(1)
      expect(service.status().sources.map((source) => source.outcome)).toEqual(['有新增', '失败'])
      await service.refresh()
      expect(fail).toHaveBeenCalledTimes(1)
    } finally {
      service.dispose()
    }
    now += 86400000
    const resumed = new IdeaService(
      path,
      sources,
      () => {},
      () => now,
    )
    try {
      resumed.start()
      await resumed.refresh()
      expect(read).toHaveBeenCalledTimes(2)
      expect(resumed.status().sources[0].outcome).toBe('无新增')
    } finally {
      resumed.dispose()
    }
  })
})
