import { describe, expect, it, vi } from 'vitest'
import {
  normalizeTelegraphItems,
  TelegraphClient,
  TelegraphError,
  telegraphUrl,
} from '../electron/telegraph/client'

const signal = () => new AbortController().signal
const raw = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  ctime: 1795519251 + id,
  modified_time: 1795519251 + id,
  title: '',
  brief: `财联社11月24日电，消息 ${id}。`,
  content: `财联社11月24日电，消息 ${id}。`,
  level: 'C',
  recommend: 0,
  jpush: 0,
  bold: 0,
  status: 1,
  is_ad: 0,
  subjects: [],
  ...overrides,
})

describe('CLS telegraph client', () => {
  it('sorts parameters and generates the expected local signature', () => {
    expect(telegraphUrl(1795519251, 0, 20)).toBe(
      'https://www.cls.cn/v1/roll/get_roll_list?appName=CailianpressWeb&last_time=1795519251&os=web&refresh_type=0&rn=20&sv=7.7.5&sign=ab0fc6fb45acedc9ce67e87d29414084',
    )
  })

  it('normalizes headline fallbacks, importance and subjects while dropping invalid entries', () => {
    const items = normalizeTelegraphItems([
      raw(1, { title: '明确标题', subjects: [{ subject_name: 'A股' }] }),
      raw(2, { content: '【括号标题】正文内容。', brief: '', recommend: 1 }),
      raw(3, { content: '财联社11月24日电，第一句话。第二句话。', brief: '', level: 'B' }),
      raw(4, { is_ad: 1 }),
      raw(5, { status: 0 }),
      raw(6, { content: '', brief: '' }),
      { nope: true },
    ])
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ headline: '明确标题', subjects: ['A股'], important: false })
    expect(items[1]).toMatchObject({ headline: '括号标题', important: true })
    expect(items[2]).toMatchObject({ headline: '第一句话', important: true })
    expect(items[0].url).toBe('https://www.cls.cn/detail/1')
  })

  it('requests the signed endpoint and rejects malformed, failed and rate-limited responses', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ errno: 0, msg: '', data: { roll_data: [raw(7)] } }),
    )
    const client = new TelegraphClient(request)
    expect(await client.page(1795519251, 0, 50, signal())).toMatchObject({ items: [{ id: 7 }] })
    expect(String(request.mock.calls[0][0])).toContain('refresh_type=0')
    expect(new Headers(request.mock.calls[0][1]?.headers).get('Referer')).toBe(
      'https://www.cls.cn/',
    )

    request.mockResolvedValueOnce(Response.json({ errno: 600, msg: '签名失败', data: null }))
    await expect(client.page(1, 1, 50, signal())).rejects.toMatchObject({ kind: 'api' })
    request.mockResolvedValueOnce(
      new Response('slow down', { status: 429, headers: { 'retry-after': '8' } }),
    )
    await expect(client.page(1, 1, 50, signal())).rejects.toMatchObject({
      kind: 'rate_limit',
      retryAfter: 8000,
    })
    request.mockResolvedValueOnce(Response.json({ unexpected: true }))
    await expect(client.page(1, 1, 50, signal())).rejects.toBeInstanceOf(TelegraphError)
  })

  it('advances the raw time cursor through short or fully filtered history pages', async () => {
    const reply = (rows: unknown[]) => Response.json({ errno: 0, data: { roll_data: rows } })
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply([raw(8, { is_ad: 1 }), raw(7, { status: 0 })]))
      .mockResolvedValueOnce(reply([raw(6)]))
      .mockResolvedValueOnce(reply([]))
      .mockResolvedValueOnce(reply([raw(5)]))
    const client = new TelegraphClient(request)
    const skip = await client.page(1795519261, 1, 50, signal())
    expect(skip).toEqual({ items: [], nextCursor: 1795519258 })
    const short = await client.page(skip.nextCursor!, 1, 50, signal())
    expect(short).toMatchObject({ items: [{ id: 6 }], nextCursor: 1795519257 })
    expect(await client.page(short.nextCursor!, 1, 50, signal())).toEqual({
      items: [],
      nextCursor: null,
    })
    await expect(client.page(1795519256, 1, 50, signal())).rejects.toMatchObject({ kind: 'api' })
  })

  it('maps connection failures without swallowing explicit cancellation', async () => {
    const request = vi.fn<typeof fetch>(async () => {
      throw new TypeError('offline')
    })
    await expect(new TelegraphClient(request).page(1, 1, 50, signal())).rejects.toMatchObject({
      kind: 'network',
      retryAfter: 30000,
    })
    const abort = new AbortController()
    abort.abort()
    await expect(new TelegraphClient(request).page(1, 1, 50, abort.signal)).rejects.toThrow(
      'offline',
    )
  })

  it.runIf(process.env.LIVE_CLS === '1')(
    'passes an opt-in live source smoke check without making normal tests network-dependent',
    async () => {
      const started = Date.now()
      const client = new TelegraphClient()
      const { items, nextCursor } = await client.page(Math.floor(started / 1000), 1, 50, signal())
      const elapsedMs = Date.now() - started
      const latest = items[0]
      expect(items.length).toBeGreaterThan(0)
      expect(items.length).toBeLessThanOrEqual(50)
      expect(latest.publishedAt).toBeLessThanOrEqual(Date.now() + 60000)
      expect(latest.publishedAt).toBeGreaterThan(started - 6 * 60 * 60 * 1000)
      expect(nextCursor).not.toBeNull()
      const older = await client.page(nextCursor!, 1, 50, signal())
      expect(older.items.length).toBeGreaterThan(0)
      expect(older.items.every((item) => item.publishedAt / 1000 < nextCursor!)).toBe(true)
      expect(older.nextCursor).toBeLessThan(nextCursor!)
      console.info(
        'CLS live smoke',
        JSON.stringify({
          count: items.length,
          elapsedMs,
          firstCursor: nextCursor,
          nextCursor: older.nextCursor,
          latestId: latest.id,
          latestAt: new Date(latest.publishedAt).toISOString(),
          lagSeconds: Math.floor((started - latest.publishedAt) / 1000),
        }),
      )
    },
  )
})
