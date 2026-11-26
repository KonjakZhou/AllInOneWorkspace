import { load } from 'cheerio'
import { setTimeout as wait } from 'node:timers/promises'
import { type IdeaCategory, type EvidenceState } from '../../src/shared/trading-ideas'
import {
  canonicalKey,
  cleanText,
  inferTopics,
  PAPER_SUMMARY_LIMIT,
  publication,
  sourceUrl,
  type CollectedIdea,
} from './content'

const JISILU = 'https://www.jisilu.cn/topic/ETF'
const ARXIV = 'https://rss.arxiv.org/rss/q-fin.TR+q-fin.PM'
const REPEC = 'https://nep.repec.org/rss/nep-fmk.rss.xml'
const MAX_BODY = 2 * 1024 * 1024
const MAX_HEADLINE_ITEMS = 60
const chinaMarket =
  /A\s*股|沪深|科创板|创业板|中证|国证|上证|深证|国内ETF|中国股市|(?:Chinese|China(?:'s)?)\s+(?:A[- ]shares?|stock|equity|ETF|market)|\bCSI\s*(?:300|500|1000)\b/iu
const transferTopic =
  /\bETFs?\b|sector|industry|equity|stock|momentum|liquidity|factor|portfolio|market impact|equities|指数|行业|轮动|资金|因子|股票|ETF/iu
const rumour = /传闻|网传|市场传言|未经证实|匿名消息/u

export type Validators = { etag?: string; lastModified?: string }
type SourceRead = {
  items: CollectedIdea[]
  validators?: Validators
  details?: string
  partial?: boolean
}
export type Collector = {
  id: string
  label: string
  rank: number
  validatorVersion?: number
  read: (signal: AbortSignal, validators: Validators) => Promise<SourceRead>
}

export class SourceError extends Error {
  constructor(
    message: string,
    readonly retryAfter = 0,
  ) {
    super(message)
  }
}

function backoff(value: string | null) {
  if (!value) return 0
  if (/^\d+$/u.test(value)) return Number(value) * 1000
  return Math.max(0, Date.parse(value) - Date.now()) || 0
}

async function requestText(
  request: typeof fetch,
  url: string,
  signal: AbortSignal,
  previous: Validators = {},
) {
  const headers: Record<string, string> = {
    'User-Agent': 'All-In-One-Workspace/1.0 (+https://github.com/KonjakZhou/AllInOneWorkspace)',
    Accept: 'application/rss+xml, application/xml, text/html, */*',
  }
  if (previous.etag) headers['If-None-Match'] = previous.etag
  if (previous.lastModified) headers['If-Modified-Since'] = previous.lastModified
  const result = await request(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  })
  if (result.status === 304) return { text: null, validators: previous }
  if (!result.ok || !result.body) {
    await result.body?.cancel().catch(() => undefined)
    throw new SourceError(
      '来源返回 HTTP ' + result.status,
      backoff(result.headers.get('Retry-After')),
    )
  }
  const reader = result.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_BODY) throw new SourceError('来源响应超过大小限制')
      text += decoder.decode(part.value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return {
    text: text + decoder.decode(),
    validators: {
      etag: result.headers.get('ETag') || undefined,
      lastModified: result.headers.get('Last-Modified') || undefined,
    },
  }
}

function plainPaper(value: string) {
  const $ = load(value, {}, false)
  $('script, style').remove()
  return cleanText($.root().text(), PAPER_SUMMARY_LIMIT)
}

export function parsePaperSummary(html: string) {
  const $ = load(html)
  const abstract = $('meta[name="citation_abstract"]').attr('content')
  return abstract ? cleanText(abstract, PAPER_SUMMARY_LIMIT) : ''
}

export async function fetchPaperSummary(
  url: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  const result = await requestText(request, url, signal)
  return parsePaperSummary(result.text ?? '')
}

function entry(
  url: string,
  title: string,
  author: string,
  category: IdeaCategory,
  evidence: EvidenceState,
  summary: string,
  published: string,
): CollectedIdea {
  return {
    key: canonicalKey(url),
    url,
    title: cleanText(title, 240),
    author: cleanText(author, 120),
    category,
    evidence,
    summary,
    publication: publication(published),
    eventDay: null,
    topics: inferTopics(title + ' ' + summary),
    market: null,
    screening: null,
  }
}

function forumTime(date: string) {
  const value = date.trim().match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u)?.[0]
  return value ? value.replace(' ', 'T') + ':00+08:00' : ''
}

export function parseJisilu(text: string) {
  const $ = load(text)
  const links = $('#c_question_list h4 a[href*="/question/"]')
  if (!links.length) throw new SourceError('未找到集思录 ETF 话题列表')
  return links
    .toArray()
    .flatMap((node) => {
      const anchor = $(node)
      const url = sourceUrl(anchor.attr('href') ?? '', JISILU)
      if (
        !url ||
        new URL(url).hostname !== 'www.jisilu.cn' ||
        !/^\/question\/\d+$/u.test(new URL(url).pathname)
      )
        return []
      const activity = anchor.closest('.aw-item').find('.aw-text-color-999').text()
      return [
        {
          item: {
            ...entry(url, anchor.text(), '', '公开社区与开源', '作者观点', '', ''),
            sourceVersion: 0,
          },
          activity: Date.parse(forumTime(activity)) || 0,
        },
      ]
    })
    .sort((a, b) => b.activity - a.activity)
}

export function parseJisiluPost(text: string, fallback: CollectedIdea): CollectedIdea {
  const $ = load(text)
  const main = $('.aw-question-detail-title').first()
  const title = cleanText(main.find('h1').text(), 240)
  if (!title) throw new SourceError('集思录帖子正文暂不可读')
  const summary = cleanText(main.find('.aw-question-detail-txt').text(), 240)
  const time =
    main
      .find('.aw-question-detail-meta span')
      .toArray()
      .map((node) => $(node).text())
      .find((value) => value.includes('发表时间')) ?? ''
  const author = cleanText($('.aw-side-bar .aw-user-name').first().text(), 120)
  const isRumour = rumour.test(title)
  return {
    ...fallback,
    title,
    author,
    summary,
    sourceVersion: 1,
    publication: publication(forumTime(time)),
    topics: inferTopics(title + ' ' + summary),
    category: isRumour ? '未证实传闻' : '公开社区与开源',
    evidence: isRumour ? '未证实' : '作者观点',
  }
}

export function parsePapers(text: string, format: 'arxiv' | 'repec') {
  const $ = load(text, { xml: true })
  if (!$(format === 'arxiv' ? 'rss' : 'rdf\\:RDF').length)
    throw new SourceError('论文订阅格式已变更')
  return $(format === 'arxiv' ? 'item' : 'rss\\:item')
    .toArray()
    .flatMap((node) => {
      const item = $(node)
      const prefix = format === 'arxiv' ? '' : 'rss\\:'
      const url = sourceUrl(item.children(prefix + 'link').text())
      const title = item
        .children(prefix + 'title')
        .text()
        .trim()
      if (!url || !title) return []
      const description = item
        .children(prefix + 'description')
        .text()
        .replace(/^arXiv:[\s\S]*?Abstract:\s*/u, '')
      const summary = plainPaper(description)
      const original = format === 'arxiv' ? item.children('guid').text() : ''
      const version = original.match(/v(\d+)$/u)?.[1]
      const body = title + ' ' + description
      const local = chinaMarket.test(body)
      const transferable = !local && transferTopic.test(body) && inferTopics(body).length > 0
      const foreign =
        /U\.S\.|United States|Japan(?:ese)?|Korea(?:n)?|Europe(?:an)?|NASDAQ|S&P\s*500|NYSE|美股|日本股市/iu.test(
          body,
        )
      const date = item.children(format === 'arxiv' ? 'pubDate' : 'dc\\:date').text()
      return [
        {
          ...entry(
            url,
            title,
            item
              .children('dc\\:creator')
              .toArray()
              .map((node) => $(node).text())
              .join('、'),
            '论文',
            '研究摘要',
            summary,
            date,
          ),
          topics: inferTopics(body),
          market: local ? '中国市场' : foreign ? '海外市场' : '市场未注明',
          screening: local ? '国内研究' : transferable ? '迁移候选' : '待筛选',
          ...(version ? { sourceVersion: Number(version) } : {}),
        } satisfies CollectedIdea,
      ]
    })
    .slice(0, MAX_HEADLINE_ITEMS)
}

export function collectors(request: typeof fetch = fetch): Collector[] {
  function publicFeed(
    id: string,
    label: string,
    rank: number,
    url: string,
    parse: (text: string) => CollectedIdea[],
    validatorVersion?: number,
  ): Collector {
    return {
      id,
      label,
      rank,
      validatorVersion,
      async read(signal, validators) {
        const response = await requestText(request, url, signal, validators)
        return {
          items: response.text === null ? [] : parse(response.text),
          validators: response.validators,
        }
      },
    }
  }
  return [
    {
      id: 'jisilu',
      label: '集思录 ETF 话题',
      rank: 1,
      async read(signal) {
        const list = await requestText(request, JISILU, signal)
        const threads = parseJisilu(list.text ?? '')
        const active = threads.slice(0, 8)
        const items = []
        let failures = 0
        for (const [index, thread] of active.entries()) {
          if (index) await wait(400, undefined, { signal })
          try {
            const response = await requestText(request, thread.item.url, signal)
            items.push(parseJisiluPost(response.text ?? '', thread.item))
          } catch (error) {
            signal.throwIfAborted()
            if (error instanceof SourceError && error.retryAfter) throw error
            items.push(thread.item)
            failures++
          }
        }
        return {
          items: [...items, ...threads.slice(active.length, 24).map((row) => row.item)],
          details: failures ? failures + ' 个帖子详情暂不可读，已保留标题' : '',
        }
      },
    },
    publicFeed('arxiv', 'arXiv 量化金融', 3, ARXIV, (text) => parsePapers(text, 'arxiv'), 3),
    publicFeed('repec', 'RePEc 金融市场', 2, REPEC, (text) => parsePapers(text, 'repec'), 3),
  ]
}
