import { describe, expect, it, vi } from 'vitest'
import { FeishuClient, normalizeEvents } from '../electron/feishu/client'
import { agendaDays, eventRange, nextEvent } from '../src/widgets/feishu-calendar/presentation'
import { calendarRange, dateKey, localDate } from '../src/shared/feishu'
import { config, now } from './feishu-fixtures'

const timed = (id: string, start: number, end: number) => ({
  event_id: id,
  start_time: { timestamp: String(start / 1000) },
  end_time: { timestamp: String(end / 1000) },
})
const signal = () => new AbortController().signal
const response = (data: unknown) => new Response(JSON.stringify({ code: 0, data }))
describe('Feishu API and event semantics', () => {
  it('deduplicates exceptions, removes cancellation/declines and supplies missing titles', () => {
    const raw = timed('series_1', now + 1000, now + 2000)
    expect(
      normalizeEvents([
        raw,
        { ...raw, is_exception: true, summary: '改期' },
        raw,
        { ...raw, event_id: 'cancel', status: 'cancelled' },
        { ...raw, event_id: 'decline', self_rsvp_status: 'decline' },
      ]),
    ).toMatchObject([{ id: 'series_1', title: '改期' }])
    expect(normalizeEvents([raw])[0].title).toBe('未命名日程')
    expect(
      normalizeEvents([raw, { event_id: raw.event_id, is_exception: true, status: 'cancelled' }]),
    ).toEqual([])
    expect(() => normalizeEvents([{ event_id: 'bad' }])).toThrow('缺少时间')
  })
  it('groups cross-day/all-day with an exclusive end; NEXT ignores past, ongoing and all-day', () => {
    const start = new Date(2026, 10, 24).getTime(),
      day = 86400000
    const events = normalizeEvents([
      timed('ended', start + 3600000, start + 7200000),
      timed('ongoing', now - 3600000, now + 3600000),
      timed('next', now + 3600000, now + 7200000),
      timed('cross', start - 3600000, start + day + 3600000),
      { event_id: 'all-day', start_time: { date: '2026-11-24' }, end_time: { date: '2026-11-26' } },
      timed('midnight-end', start + 3600000, start + day),
    ])
    expect(nextEvent(events, now)?.id).toBe('next')
    const groups = agendaDays(events, new Date(now))
    expect(groups).toHaveLength(8)
    expect(groups[0].events[0].id).toBe('all-day')
    expect(groups[1].events.map((event) => event.id)).toEqual(['all-day', 'cross'])
    expect(groups[2].events).toEqual([])
    expect(eventRange(events.find((event) => event.id === 'all-day')!)).toBe('全天')
    expect(eventRange(events.find((event) => event.id === 'cross')!)).toContain('11/23')
  })
  it('returns only display fields even if the API includes attendee or availability details', () => {
    expect(
      normalizeEvents([
        {
          ...timed('event', now, now + 60000),
          summary: '日程',
          attendees: [{ user_id: 'private-attendee' }],
          free_busy_status: 'busy',
          description: 'private-description',
        },
      ]),
    ).toEqual([{ id: 'event', title: '日程', start: now, end: now + 60000, allDay: false }])
  })
  it('uses eight local natural days across month boundaries', () => {
    const range = calendarRange(new Date(2026, 10, 28, 23, 59))
    expect(dateKey(new Date(range.start))).toBe('2026-11-28')
    expect(dateKey(new Date(range.end))).toBe('2026-12-06')
    expect(new Date(range.start).getHours()).toBe(0)
    expect(localDate('2026-11-24')).toBe(new Date(2026, 10, 24).getTime())
    expect(() => localDate('2026-02-30')).toThrow()
    // When run with TZ=America/New_York, the range straddles spring DST (191 hours).
    const dst = calendarRange(new Date(2026, 2, 7, 12))
    const offsetDelta =
      new Date(dst.end).getTimezoneOffset() - new Date(dst.start).getTimezoneOffset()
    expect(dst.end - dst.start).toBe(8 * 86400000 + offsetDelta * 60000)
  })
  it('exchanges PKCE and rotates refresh tokens using API expiry values', async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'at',
            refresh_token: 'rt',
            expires_in: 120,
            refresh_token_expires_in: 600,
          }),
        ),
    )
    const client = new FeishuClient(request, () => now)
    const result = await client.exchange(config, 'code', 'verifier', signal())
    expect(result).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: now + 120000,
      refreshExpiresAt: now + 600000,
    })
    expect(request.mock.calls[0][0]).toBe('https://accounts.feishu.cn/oauth/v3/token')
    const body = JSON.parse(request.mock.calls[0][1]!.body as string)
    expect(body.code_verifier).toBe('verifier')
    expect(body.redirect_uri).toBe('http://127.0.0.1:43821/oauth/feishu/callback')
    await client.refresh(config, 'old-refresh', signal())
    expect(JSON.parse(request.mock.calls[1][1]!.body as string).refresh_token).toBe('old-refresh')
  })
  it('queries only the primary calendar and expanded instances; splits overflow and deduplicates', async () => {
    const request = vi.fn<typeof fetch>()
    request
      .mockResolvedValueOnce(
        response({
          calendars: [{ calendar: { calendar_id: 'user/id', role: 'owner', type: 'primary' } }],
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 193104 })))
      .mockResolvedValueOnce(response({ items: [timed('one', now, now + 1000)] }))
      .mockResolvedValueOnce(response({ items: [timed('one', now, now + 1000)] }))
    const client = new FeishuClient(request)
    const id = await client.primary('access', signal())
    expect(request.mock.calls[0][1]?.method).toBe('POST')
    const result = await client.events('access', id, calendarRange(new Date(now)), signal())
    expect(result).toHaveLength(1)
    expect(request.mock.calls[1][0]).toContain('user%2Fid/events/instance_view')
    expect(request.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer access' })
    expect(request).toHaveBeenCalledTimes(4)
  })
  it.each([
    [401, 'authorization'],
    [403, 'permission'],
    [429, 'rate_limit'],
    [500, 'api'],
  ] as const)('converts HTTP %s into a sanitized %s issue', async (status, kind) => {
    const client = new FeishuClient(
      async () =>
        new Response(JSON.stringify({ msg: 'DO_NOT_LEAK_TOKEN' }), {
          status,
          headers: { 'Retry-After': '45' },
        }),
    )
    try {
      await client.identity('secret', signal())
      throw new Error('expected failure')
    } catch (err) {
      expect(err).toMatchObject({ kind })
      expect(String(err)).not.toContain('DO_NOT_LEAK')
      if (kind === 'rate_limit') expect(err).toMatchObject({ retryAfter: 45000 })
    }
  })
  it('rejects missing offline permission and converts network failures', async () => {
    const client = new FeishuClient(
      async () => new Response(JSON.stringify({ access_token: 'at', expires_in: 120 })),
    )
    await expect(client.exchange(config, 'code', 'verifier', signal())).rejects.toMatchObject({
      kind: 'permission',
    })
    const offline = new FeishuClient(async () => {
      throw new Error('offline')
    })
    await expect(offline.identity('at', signal())).rejects.toMatchObject({ kind: 'network' })
    const throttled = new FeishuClient(
      async () => new Response('Too many requests', { status: 429 }),
    )
    await expect(throttled.identity('at', signal())).rejects.toMatchObject({ kind: 'rate_limit' })
  })
})
