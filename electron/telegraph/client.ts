import { createHash } from 'node:crypto'
import { z } from 'zod'
import { version } from '../../package.json'
import {
  telegraphCursorSchema,
  type TelegraphItem,
  type TelegraphIssue,
} from '../../src/shared/telegraph'

const ENDPOINT = 'https://www.cls.cn/v1/roll/get_roll_list'
const rawItemSchema = z.object({
  id: z.number().int().positive(),
  ctime: z.number().int().positive(),
  modified_time: z.number().int().nonnegative().optional(),
  title: z.string().nullish(),
  brief: z.string().nullish(),
  content: z.string().nullish(),
  level: z.string().nullish(),
  recommend: z.number().int().optional(),
  jpush: z.number().int().optional(),
  bold: z.number().int().optional(),
  status: z.number().int().optional(),
  is_ad: z.number().int().optional(),
  subjects: z.array(z.object({ subject_name: z.string().nullish() })).nullish(),
})
const responseSchema = z.object({
  errno: z.number().int(),
  msg: z.string().optional(),
  data: z.object({ roll_data: z.array(z.unknown()) }).nullish(),
})

export class TelegraphError extends Error {
  constructor(
    readonly kind: TelegraphIssue['kind'],
    message: string,
    readonly retryAfter = 0,
  ) {
    super(message)
  }
}

export function telegraphUrl(lastTime: number, refreshType: 0 | 1, limit = 50): string {
  const params: Record<string, string> = {
    appName: 'CailianpressWeb',
    last_time: String(Math.floor(lastTime)),
    os: 'web',
    refresh_type: String(refreshType),
    rn: String(limit),
    sv: '7.7.5',
  }
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&')
  const sha1 = createHash('sha1').update(query).digest('hex')
  const sign = createHash('md5').update(sha1).digest('hex')
  return `${ENDPOINT}?${query}&sign=${sign}`
}

function headline(title: string, content: string): string {
  if (title) return title
  const bracketed = content.match(/^【([^】]{1,100})】/u)?.[1]?.trim()
  if (bracketed) return bracketed
  const withoutPrefix = content.replace(/^财联社\d{1,2}月\d{1,2}日电[，,:：\s]*/u, '')
  const sentence = withoutPrefix.split(/[。！？\n]/u)[0]?.trim() || content
  return sentence.length > 72 ? `${sentence.slice(0, 72)}…` : sentence
}

export function normalizeTelegraphItems(input: unknown[]): TelegraphItem[] {
  const items: TelegraphItem[] = []
  for (const value of input) {
    const parsed = rawItemSchema.safeParse(value)
    if (!parsed.success) continue
    const item = parsed.data
    if (item.status !== undefined && item.status !== 1) continue
    if (item.is_ad === 1) continue
    const content = (item.content?.trim() || item.brief?.trim() || '').trim()
    if (!content) continue
    const title = item.title?.trim() || ''
    const subjects = [
      ...new Set(
        (item.subjects ?? [])
          .map((subject) => subject.subject_name?.trim())
          .filter((name): name is string => !!name),
      ),
    ]
    items.push({
      id: item.id,
      headline: headline(title, content),
      content,
      level: item.level?.trim().toUpperCase() || 'C',
      publishedAt: item.ctime * 1000,
      modifiedAt: (item.modified_time || item.ctime) * 1000,
      important:
        item.recommend === 1 ||
        item.jpush === 1 ||
        item.bold === 1 ||
        item.level === 'A' ||
        item.level === 'B',
      subjects,
      url: `https://www.cls.cn/detail/${item.id}`,
    })
  }
  return items
}

export interface TelegraphClientAPI {
  page(
    lastTime: number,
    refreshType: 0 | 1,
    limit: number,
    signal: AbortSignal,
  ): Promise<{ items: TelegraphItem[]; nextCursor: number | null }>
}

export class TelegraphClient implements TelegraphClientAPI {
  constructor(private request: typeof fetch = fetch) {}

  async page(lastTime: number, refreshType: 0 | 1, limit: number, signal: AbortSignal) {
    let response: Response
    try {
      response = await this.request(telegraphUrl(lastTime, refreshType, limit), {
        headers: {
          'User-Agent': `All-In-One-Workspace/${version} (+https://www.cls.cn/telegraph)`,
          Referer: 'https://www.cls.cn/',
        },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw new TelegraphError('network', '暂时无法连接财联社，请检查网络后重试。', 30000)
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'))
      const retryAfter = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60000
      throw new TelegraphError(
        'rate_limit',
        '财联社请求较频繁，稍后将自动重试。',
        Math.min(retryAfter, 15 * 60 * 1000),
      )
    }
    if (!response.ok)
      throw new TelegraphError('api', `财联社请求失败（HTTP ${response.status}）。`, 30000)
    let payload: z.infer<typeof responseSchema>
    try {
      payload = responseSchema.parse(await response.json())
    } catch {
      throw new TelegraphError('api', '财联社返回了无法识别的数据，请稍后重试。', 30000)
    }
    if (payload.errno !== 0 || !payload.data)
      throw new TelegraphError('api', payload.msg || `财联社请求失败（${payload.errno}）。`, 30000)
    const rows = payload.data.roll_data.slice(0, limit)
    if (refreshType === 0) return { items: normalizeTelegraphItems(rows), nextCursor: null }

    // The website's older-than cursor is exclusive. Move it using the raw rows
    // so filtering ads or invalid headlines cannot end the history prematurely.
    const olderRows = rows.flatMap((row) => {
      const time = telegraphCursorSchema.safeParse(
        row && typeof row === 'object' && 'ctime' in row ? row.ctime : null,
      )
      return time.success && time.data < lastTime ? [{ row, time: time.data }] : []
    })
    if (rows.length && !olderRows.length)
      throw new TelegraphError('api', '财联社没有返回更早的时间，请稍后重试。')
    return {
      items: normalizeTelegraphItems(olderRows.map(({ row }) => row)),
      nextCursor: olderRows.length ? Math.min(...olderRows.map(({ time }) => time)) : null,
    }
  }
}
