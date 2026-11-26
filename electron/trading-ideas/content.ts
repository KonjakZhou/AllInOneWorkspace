import {
  chinaDay,
  ideaUrl,
  type IdeaContent,
  type IdeaTopic,
  type ManualIdea,
  type Publication,
} from '../../src/shared/trading-ideas'

export type CollectedIdea = IdeaContent & {
  key: string
  sourceVersion?: number
}

const topicRules: [IdeaTopic, RegExp][] = [
  ['指数换样', /样本|成份股|成分股|指数编制|index (?:rebalanc|constituen)/iu],
  ['ETF 份额与申赎', /份额|申购|赎回|折溢价|fund flows?|creation and redemption/iu],
  ['行业轮动', /轮动|景气|sector rotation|industry rotation|sector momentum/iu],
  ['因子与择时', /因子|择时|动量|反转|拥挤|factors?|momentum|reversal|timing|crowding/iu],
  ['成交与流动性', /成交|量价|流动性|价差|liquidity|trading volume|microstructure|market impact/iu],
  ['政策与公司事件', /政策|回购|并购|重组|分红|上市|repurchase|dividend|merger/iu],
  ['资产配置', /配置|组合|对冲|波动|portfolio|hedg|volatility|allocat/iu],
]

export function inferTopics(text: string) {
  return topicRules.filter(([, rule]) => rule.test(text)).map(([topic]) => topic)
}

export function cleanText(text: string, limit = 600) {
  return text.replace(/\s+/gu, ' ').trim().slice(0, limit)
}

export function sourceUrl(value: string, base?: string) {
  try {
    const url = new URL(value, base)
    if (!ideaUrl.safeParse(url.href).success) return null
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^(?:from|spm|share_source|act_menu)$/iu.test(key)) url.searchParams.delete(key)
    }
    url.searchParams.sort()
    return url.href
  } catch {
    return null
  }
}

export function canonicalKey(url: string) {
  const parsed = new URL(url)
  if (parsed.hostname === 'www.cninfo.com.cn' && parsed.pathname === '/new/disclosure/detail') {
    const announcement = parsed.searchParams.get('announcementId')
    if (announcement) return 'cninfo:' + announcement
  }
  const repec = parsed.hostname === 'd.repec.org' ? parsed.searchParams.get('u') : null
  const arxiv =
    parsed.hostname === 'arxiv.org'
      ? parsed.pathname.match(/^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/u)?.[1]
      : null
  const paper = arxiv ?? repec?.match(/^repec:arx:papers:(.+)$/iu)?.[1]
  if (paper) return 'arxiv:' + paper.replace(/v\d+$/u, '')
  if (repec) return repec.toLowerCase()
  return sourceUrl(url) ?? url
}

export function needsPaperSummary(summary: string) {
  return summary.length <= 240 || summary.length === 2400
}
export const PAPER_SUMMARY_LIMIT = 6000

export function paperSummaryUrl(url: string, version: number | null) {
  const key = canonicalKey(url)
  const arxiv = key.match(/^arxiv:((?:\d{4}\.\d{4,5})|(?:[a-z.-]+\/\d{7}))$/iu)
  if (arxiv) return 'https://arxiv.org/abs/' + arxiv[1] + (version ? 'v' + version : '')
  const repec = key.match(/^repec:([a-z0-9]{3}):([a-z0-9-]+):([a-z0-9:._-]+)$/u)
  if (repec) {
    const suffix = repec.slice(1).map(encodeURIComponent).join('/') + '.html'
    return 'https://ideas.repec.org/p/' + suffix
  }
  return null
}

export function isAbstractExtension(shorter: string, longer: string) {
  const comparable = (text: string) =>
    text
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}]/gu, '')
      .toLowerCase()
  if (!needsPaperSummary(shorter) || longer.length <= shorter.length) return false
  const prefix = comparable(shorter)
  return (!shorter || Boolean(prefix)) && comparable(longer).startsWith(prefix)
}

export function publication(value: string): Publication | null {
  const trimmed = value.trim()
  if (/^\d{4}$/u.test(trimmed)) return { value: trimmed, precision: 'year' }
  if (/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(trimmed)) return { value: trimmed, precision: 'month' }
  if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
    const time = Date.parse(trimmed)
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === trimmed
      ? { value: trimmed, precision: 'day' }
      : null
  }
  if (!/\d:\d{2}/u.test(trimmed) || !/(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)$/iu.test(trimmed)) return null
  const time = Date.parse(trimmed)
  return Number.isFinite(time) ? { value: new Date(time).toISOString(), precision: 'time' } : null
}

export function publicationDay(date: Publication | null) {
  if (date?.precision === 'time') return chinaDay(Date.parse(date.value))
  return date?.precision === 'day' ? date.value : null
}

export function manualContent(input: ManualIdea): CollectedIdea {
  const url = sourceUrl(input.url)!
  return {
    key: canonicalKey(url),
    url,
    title: input.title,
    author: input.author,
    category: input.category,
    evidence: input.evidence,
    summary: input.summary,
    publication: publication(input.publishedDay),
    eventDay: input.eventDay || null,
    topics: inferTopics(input.title + ' ' + input.summary),
    market: null,
    screening: null,
  }
}
