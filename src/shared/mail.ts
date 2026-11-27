import { z } from 'zod'

export const providerSchema = z.enum(['feishu', 'netease', 'gmail'])
export const mailIdSchema = z.uuid()
export const filterSchema = z.object({
  account: mailIdSchema.nullable(),
  folder: z.enum(['all', 'inbox', 'unread', 'sent']),
})
const timeSchema = z.number().int().min(0).max(4102444800000)
export const cursorSchema = z
  .object({
    time: timeSchema,
    key: z.string().max(8192).nullable(),
    band: z
      .object({ start: timeSchema, end: timeSchema })
      .refine(({ start, end }) => start < end && end - start <= 300 * 86400000)
      .optional(),
  })
  .refine(({ band, time }) => !band || (band.start <= time && time < band.end))
export const refSchema = z.object({ account: mailIdSchema, id: z.string().min(1).max(4096) })
export const addressSchema = z.object({ name: z.string(), email: z.string() })
export const summarySchema = refSchema.extend({
  time: z.number().int().nonnegative(),
  subject: z.string(),
  from: z.array(addressSchema),
  to: z.array(addressSchema),
  preview: z.string(),
  inbox: z.boolean(),
  sent: z.boolean(),
  unread: z.boolean(),
})
const imapFields = {
  password: z.string().trim().min(1).max(256),
  sentPath: z.string().min(1).max(1024).optional(),
}
export const connectSchema = z.union([
  z.object({ provider: z.literal('gmail'), reconnect: mailIdSchema.optional() }),
  z.object({
    provider: z.literal('feishu'),
    method: z.literal('imap'),
    reconnect: mailIdSchema.optional(),
    email: z.email(),
    ...imapFields,
  }),
  z.object({
    provider: z.literal('feishu'),
    method: z.literal('oauth').optional(),
    reconnect: mailIdSchema.optional(),
    appId: z
      .string()
      .trim()
      .regex(/^cli_[a-zA-Z0-9]+$/)
      .optional(),
    appSecret: z.string().trim().min(1).max(512).optional(),
  }),
  z.object({
    provider: z.literal('netease'),
    reconnect: mailIdSchema.optional(),
    email: z.email().refine((value) => /@163\.com$/i.test(value)),
    ...imapFields,
  }),
])
export type MailProvider = z.infer<typeof providerSchema>
export type MailFilter = z.infer<typeof filterSchema>
export type MailCursor = z.infer<typeof cursorSchema>
export type MailRef = z.infer<typeof refSchema>
export type MailView = {
  accountId: string
  filter: MailFilter
  selected: MailRef | null
  startAt?: { cursor?: MailCursor; page: MailPage }
}
export type MailSummary = z.infer<typeof summarySchema>
export type MailAddress = z.infer<typeof addressSchema>
export type MailConnect = z.infer<typeof connectSchema>
export type MailAccount = {
  id: string
  provider: MailProvider
  email: string
  feishuMethod?: 'imap' | 'oauth'
  issue?: string
  reauthorize?: boolean
}
export type MailState = {
  accounts: MailAccount[]
  gmailConfigured: boolean
  setup: { provider: MailProvider; code?: string; url?: string } | null
}
export type MailPage = {
  items: MailSummary[]
  next: MailCursor | null
  issues: { account: string; message: string }[]
}
export type MailDetail = {
  message: MailSummary
  body: string
  gmail?: { threadId?: string; messageId?: string }
}
export type MailReplyResult = 'thread' | 'search' | 'mailbox' | 'mailbox-with-keyword'
export type ConnectResult = { sentFolders: string[] } | { connected: true }
export type MailChange =
  | { kind: 'accounts' | 'resume' | 'status' }
  | { kind: 'cache'; account: string }
  | { kind: 'read'; message: MailRef }
export const mailSetupGuides = {
  feishuImap: 'https://www.feishu.cn/hc/zh-CN/articles/902478147400',
  feishuOAuth:
    'https://open.feishu.cn/document/server-docs/application-scope/introduction?lang=zh-CN',
  netease:
    'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2a5feb28b66796d3b',
  gmail: 'https://developers.google.cn/workspace/guides/create-credentials?hl=zh-cn#desktop-app',
} as const
export type MailSetupGuide = keyof typeof mailSetupGuides
export interface MailAPI {
  state(): Promise<MailState>
  importGoogle(): Promise<boolean>
  openSetupGuide(guide: MailSetupGuide): Promise<void>
  connect(input: MailConnect): Promise<ConnectResult>
  cancel(): Promise<void>
  reopen(): Promise<void>
  disconnect(id: string): Promise<void>
  cached(filter: MailFilter, disk?: boolean): Promise<MailSummary[]>
  list(filter: MailFilter, cursor?: MailCursor, refresh?: boolean): Promise<MailPage>
  detail(ref: MailRef): Promise<MailDetail>
  markRead(ref: MailRef): Promise<void>
  openMailbox(account: string): Promise<void>
  openReply(ref: MailRef): Promise<MailReplyResult>
  onChanged(callback: (change: MailChange) => void): () => void
}
export const defaultMailFilter: MailFilter = { account: null, folder: 'all' }
export const mailKey = (ref: MailRef) => ref.account + ':' + ref.id
export const mailProviderNames: Record<MailProvider, string> = {
  feishu: '飞书邮箱',
  netease: '163 邮箱',
  gmail: 'Gmail',
}
