import { z } from 'zod'

export const FEISHU_REDIRECT_URI = 'http://127.0.0.1:43821/oauth/feishu/callback'
export const FEISHU_SCOPES = [
  'calendar:calendar:readonly',
  'contact:user.base:readonly',
  'offline_access',
]
export const feishuConfigSchema = z.object({
  appId: z
    .string()
    .trim()
    .regex(/^cli_[a-zA-Z0-9]+$/, '请输入有效的飞书 App ID'),
  appSecret: z.string().trim().min(1, '请输入 App Secret').max(512),
})
export type FeishuConfig = z.infer<typeof feishuConfigSchema>
export type FeishuIssue = {
  kind: 'authorization' | 'permission' | 'network' | 'rate_limit' | 'api' | 'storage'
  message: string
}
export type FeishuIdentity = { openId: string; name: string; tenantKey?: string }
export type FeishuConnection = {
  accountId: string
  appId: string | null
  configured: boolean
  status:
    | 'unconfigured'
    | 'not_connected'
    | 'connecting'
    | 'connected'
    | 'reauth_required'
    | 'permission_denied'
  identity: FeishuIdentity | null
  message: string | null
  revision: number
  setup?: {
    phase: 'creating_app' | 'authorizing' | 'verifying'
    userCode?: string
    expiresAt?: number
  }
}
export type CalendarEvent = {
  id: string
  title: string
  start: number
  end: number
  allDay: boolean
  startDate?: string
  endDate?: string
}
export type CalendarAgenda = {
  accountId: string
  revision: number
  connection: FeishuConnection
  events: CalendarEvent[]
  updatedAt: number | null
  rangeStart: number
  rangeEnd: number
  stale: boolean
  error: FeishuIssue | null
}
export interface FeishuAPI {
  connect(accountId: string): Promise<FeishuConnection>
  reopenAuthorization(accountId: string): Promise<void>
  getConnection(accountId: string): Promise<FeishuConnection>
  saveConfig(accountId: string, config: FeishuConfig): Promise<FeishuConnection>
  authorize(accountId: string): Promise<FeishuConnection>
  cancelAuthorization(accountId: string): Promise<void>
  disconnect(accountId: string): Promise<void>
  getAgenda(accountId: string, force?: boolean): Promise<CalendarAgenda>
  onChanged(accountId: string, listener: () => void): () => void
}

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function calendarRange(now = new Date()): { start: number; end: number } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 8)
  return { start: start.getTime(), end: end.getTime() }
}
export function localDate(value: string): number {
  const parts = value.split('-').map(Number)
  const date = new Date(parts[0], parts[1] - 1, parts[2])
  if (dateKey(date) !== value) throw new Error('无效的日历日期')
  return date.getTime()
}
