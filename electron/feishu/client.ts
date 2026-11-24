import { z } from 'zod'
import {
  FEISHU_REDIRECT_URI,
  calendarRange,
  localDate,
  type CalendarEvent,
  type FeishuConfig,
  type FeishuIdentity,
} from '../../src/shared/feishu'
import type { Authorization } from './vault'
import { FeishuError } from './errors'

const tokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().positive().optional(),
})
export function parseTokens(raw: unknown, now: number): Authorization['token'] {
  const result = tokenResponse.safeParse(raw)
  if (!result.success) throw new FeishuError('api', '飞书令牌响应无效，请重新授权。')
  const token = result.data
  if (!token.refresh_token || !token.refresh_token_expires_in)
    throw new FeishuError(
      'permission',
      '未获得离线访问权限，请在飞书应用安全设置中开启刷新 user_access_token、发布后重新授权。',
    )
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: now + token.expires_in * 1000,
    refreshExpiresAt: now + token.refresh_token_expires_in * 1000,
  }
}
const eventTime = z.object({ date: z.string().optional(), timestamp: z.string().optional() })
const eventSchema = z.object({
  event_id: z.string(),
  summary: z.string().optional(),
  start_time: eventTime.optional(),
  end_time: eventTime.optional(),
  status: z.string().optional(),
  self_rsvp_status: z.string().optional(),
  is_exception: z.boolean().optional(),
})
export type RawEvent = z.infer<typeof eventSchema>
export function normalizeEvents(input: unknown[]): CalendarEvent[] {
  const unique = new Map<string, RawEvent>()
  for (const raw of input) {
    const event = eventSchema.parse(raw)
    const previous = unique.get(event.event_id)
    if (!previous || event.is_exception || !previous.is_exception) unique.set(event.event_id, event)
  }
  const events: CalendarEvent[] = []
  for (const event of unique.values()) {
    if (
      event.status === 'cancelled' ||
      ['decline', 'removed'].includes(event.self_rsvp_status ?? '')
    )
      continue
    if (!event.start_time || !event.end_time)
      throw new FeishuError('api', '飞书返回的日程缺少时间，暂时无法完整显示。')
    const allDay = !!event.start_time.date
    const start = allDay
      ? localDate(event.start_time.date!)
      : Number(event.start_time.timestamp) * 1000
    const end = allDay ? localDate(event.end_time.date!) : Number(event.end_time.timestamp) * 1000
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      throw new FeishuError('api', '飞书返回的日程时间无效，请稍后重试。')
    events.push({
      id: event.event_id,
      title: event.summary?.trim() || '未命名日程',
      start,
      end,
      allDay,
      ...(allDay ? { startDate: event.start_time.date, endDate: event.end_time.date } : {}),
    })
  }
  return events.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
}
export interface FeishuClientAPI {
  exchange(
    config: FeishuConfig,
    code: string,
    verifier: string,
    signal: AbortSignal,
  ): Promise<Authorization['token']>
  refresh(config: FeishuConfig, token: string, signal: AbortSignal): Promise<Authorization['token']>
  identity(token: string, signal: AbortSignal): Promise<FeishuIdentity>
  primary(token: string, signal: AbortSignal): Promise<string>
  events(
    token: string,
    calendarId: string,
    range: { start: number; end: number },
    signal: AbortSignal,
  ): Promise<CalendarEvent[]>
}
export class FeishuClient implements FeishuClientAPI {
  constructor(
    private request: typeof fetch = fetch,
    private now = Date.now,
  ) {}
  private async json(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await this.request(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw new FeishuError('network', '暂时无法连接飞书，请检查网络后重试。')
    }
    let payload: Record<string, unknown>
    try {
      payload = z.record(z.string(), z.unknown()).parse(await response.json())
    } catch {
      if (response.ok) throw new FeishuError('api', '飞书返回了无法识别的数据，请稍后重试。')
      payload = {}
    }
    const code = typeof payload.code === 'number' ? payload.code : undefined
    if (response.ok && (code === undefined || code === 0) && !payload.error) return payload
    if (response.status === 429 || [190004, 190005, 190010].includes(code ?? 0)) {
      const wait = Number(response.headers.get('retry-after'))
      throw new FeishuError(
        'rate_limit',
        '飞书请求较频繁，稍后将自动重试。',
        code,
        Number.isFinite(wait) && wait > 0 ? Math.min(wait * 1000, 3600000) : 60000,
      )
    }
    if (
      response.status === 401 ||
      [
        20008, 20024, 20026, 20037, 20064, 20066, 20073, 99991663, 99991664, 99991668, 99991669,
        99991671,
      ].includes(code ?? 0) ||
      payload.error === 'invalid_grant'
    )
      throw new FeishuError('authorization', '飞书授权已失效，请重新授权。', code)
    if (
      response.status === 403 ||
      [20009, 20010, 20027, 20068, 20069, 20074, 191002, 193002, 99991672, 99991679].includes(
        code ?? 0,
      )
    )
      throw new FeishuError(
        'permission',
        '飞书权限不足。请确认应用已发布、你在可用范围内，并已授权日历只读和离线访问权限。',
        code,
      )
    if (code === 20002)
      throw new FeishuError('authorization', 'App ID 或 App Secret 不正确，请检查应用配置。', code)
    throw new FeishuError('api', `飞书请求失败${code ? `（${code}）` : ''}，请稍后重试。`, code)
  }
  private async tokens(
    config: FeishuConfig,
    values: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Authorization['token']> {
    const body = JSON.stringify({
      client_id: config.appId,
      client_secret: config.appSecret,
      ...values,
    })
    const raw = await this.json(
      'https://accounts.feishu.cn/oauth/v3/token',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
      signal,
    )
    return parseTokens(raw, this.now())
  }
  exchange(config: FeishuConfig, code: string, verifier: string, signal: AbortSignal) {
    return this.tokens(
      config,
      {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: FEISHU_REDIRECT_URI,
      },
      signal,
    )
  }
  refresh(config: FeishuConfig, token: string, signal: AbortSignal) {
    return this.tokens(config, { grant_type: 'refresh_token', refresh_token: token }, signal)
  }
  private async api(path: string, token: string, signal: AbortSignal, method = 'GET') {
    const raw = await this.json(
      'https://open.feishu.cn/open-apis/' + path,
      {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      },
      signal,
    )
    return raw.data
  }
  async identity(token: string, signal: AbortSignal): Promise<FeishuIdentity> {
    const user = z
      .object({ open_id: z.string().min(1), name: z.string(), tenant_key: z.string().optional() })
      .parse(await this.api('authen/v1/user_info', token, signal))
    return { openId: user.open_id, name: user.name, tenantKey: user.tenant_key }
  }
  async primary(token: string, signal: AbortSignal): Promise<string> {
    const data = z
      .object({
        calendars: z.array(
          z.object({
            calendar: z.object({
              calendar_id: z.string(),
              role: z.string().optional(),
              type: z.string().optional(),
            }),
          }),
        ),
      })
      .parse(
        await this.api('calendar/v4/calendars/primary?user_id_type=open_id', token, signal, 'POST'),
      )
    const calendar =
      data.calendars.find((item) => item.calendar.type === 'primary')?.calendar ??
      data.calendars[0]?.calendar
    if (!calendar || !['reader', 'writer', 'owner'].includes(calendar.role ?? ''))
      throw new FeishuError('permission', '当前飞书账号没有可读取的个人主日历。')
    return calendar.calendar_id
  }
  async events(
    token: string,
    id: string,
    range = calendarRange(),
    signal: AbortSignal,
  ): Promise<CalendarEvent[]> {
    const read = async (start: number, end: number, depth = 0): Promise<unknown[]> => {
      const query = new URLSearchParams({
        start_time: String(Math.floor(start / 1000)),
        end_time: String(Math.floor(end / 1000) - 1),
        user_id_type: 'open_id',
      })
      try {
        const data = await this.api(
          `calendar/v4/calendars/${encodeURIComponent(id)}/events/instance_view?${query}`,
          token,
          signal,
        )
        return z.object({ items: z.array(z.unknown()).default([]) }).parse(data).items
      } catch (error) {
        if (
          error instanceof FeishuError &&
          error.code === 193104 &&
          depth < 8 &&
          end - start > 3600000
        ) {
          const middle = Math.floor((start + end) / 2000) * 1000
          return [
            ...(await read(start, middle, depth + 1)),
            ...(await read(middle, end, depth + 1)),
          ]
        }
        throw error
      }
    }
    return normalizeEvents(await read(range.start, range.end)).filter(
      (event) => event.start < range.end && event.end > range.start,
    )
  }
}
