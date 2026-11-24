import { describe, expect, it, vi } from 'vitest'
import { FeishuClient, normalizeEvents } from '../electron/feishu/client'
import {
  agendaDays,
  dayLabel,
  eventDetailRange,
  eventRange,
  eventTag,
  nextEvent,
  nextTodayEvent,
} from '../src/widgets/feishu-calendar/presentation'
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
  it('extracts only room names and locations from instance views, excluding failed bookings and users', () => {
    const result = normalizeEvents([
      {
        ...timed('event', now, now + 60000),
        attendees: [
          {
            type: 'resource',
            display_name: '  上海 · 会议室 A  ',
            room_id: 'room-a',
            rsvp_status: 'accept',
          },
          { type: 'resource', display_name: '上海 · 会议室 A', rsvp_status: 'accept' },
          { type: 'resource', display_name: '会议室 B', rsvp_status: 'needs_action' },
          { room_id: 'room-c', display_name: '会议室 C', rsvp_status: 'tentative' },
          { type: 'resource', display_name: '预约失败', rsvp_status: 'decline' },
          { type: 'resource', display_name: '已删除', rsvp_status: 'removed' },
          { type: 'user', display_name: '私人姓名', user_id: 'private-user' },
        ],
        location: { name: '办公区', address: '二层', latitude: 1, longitude: 2 },
      },
    ])
    expect(result[0].rooms).toEqual(['上海 · 会议室 A', '会议室 B（预约中）', '会议室 C（待定）'])
    expect(result[0].location).toBe('办公区 · 二层')
    expect(JSON.stringify(result)).not.toMatch(
      /room-a|room-c|私人姓名|private-user|latitude|longitude|预约失败|已删除/,
    )
    expect(
      normalizeEvents([{ ...timed('empty', now, now + 60000), attendees: null, location: null }])[0]
        .rooms,
    ).toBeUndefined()
  })
  it('keeps tomorrow in the date heading, with only NEXT and TODAY on rows', () => {
    const today = new Date(2026, 11, 31, 12)
    const tomorrow = new Date(2027, 0, 1)
    const later = new Date(2027, 0, 2)
    const event = {
      id: 'e',
      title: '日程',
      start: tomorrow.getTime() + 3600000,
      end: later.getTime(),
      allDay: false,
    }
    expect(eventTag(event, tomorrow, today, 'e')).toBe('NEXT')
    expect(eventTag(event, tomorrow, today, 'other')).toBe('')
    expect(eventTag(event, later, today, 'other')).toBe('')
    const ongoing = { ...event, start: today.getTime() - 1000, end: today.getTime() + 1000 }
    expect(eventTag(ongoing, today, today)).toBe('TODAY')
    expect(eventTag(event, later, today, 'e')).toBe('')
    expect(dayLabel(tomorrow, today)).toBe('1月1日·星期五·明天')
    expect(dayLabel(later, today)).toBe('1月2日·星期六')
    expect(dayLabel(new Date(2026, 10, 25), new Date(2026, 10, 24))).toBe('11月25日·星期三·明天')
  })
  it('limits the overview to the next timed event starting today, including local midnight and DST', () => {
    for (const today of [new Date(2026, 11, 31, 12), new Date(2026, 2, 8, 12)]) {
      const at = today.getTime()
      const tomorrow = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate() + 1,
      ).getTime()
      const events = normalizeEvents([
        timed('tomorrow', tomorrow, tomorrow + 3600000),
        timed('ongoing', at - 1000, at + 1000),
        timed('ended', at - 2000, at - 1000),
        timed('later', at + 7200000, at + 10800000),
        timed('next', at + 3600000, at + 7200000),
      ])
      expect(nextTodayEvent(events, today)?.id).toBe('next')
      const remaining = events.filter((event) => !['next', 'later'].includes(event.id))
      expect(nextTodayEvent(remaining, today)).toBeUndefined()
      expect(nextEvent(remaining, at)?.id).toBe('tomorrow')
      expect(
        nextTodayEvent([{ ...events[0], start: at + 1000, end: tomorrow, allDay: true }], today),
      ).toBeUndefined()
      expect(nextTodayEvent([], today)).toBeUndefined()
    }
  })
  it('shows full date/time details and the final covered day for all-day events', () => {
    const event = {
      id: 'e',
      title: '日程',
      start: new Date(2026, 10, 24, 10, 30).getTime(),
      end: new Date(2026, 10, 24, 12).getTime(),
      allDay: false,
    }
    expect(eventDetailRange(event)).toContain('2026年11月24日')
    expect(eventDetailRange(event)).toContain('10:30–12:00')
    const cross = { ...event, end: new Date(2026, 10, 25, 1).getTime() }
    expect(eventDetailRange(cross)).toContain('2026年11月25日')
    expect(eventDetailRange(cross)).toContain('01:00')
    const allDay = {
      ...event,
      allDay: true,
      start: new Date(2026, 10, 24).getTime(),
      end: new Date(2026, 10, 26).getTime(),
    }
    expect(eventDetailRange(allDay)).toContain('2026年11月25日')
    expect(eventDetailRange(allDay)).not.toContain('26日')
    expect(eventDetailRange(allDay)).toContain('全天')
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
