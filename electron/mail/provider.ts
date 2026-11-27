import { z } from 'zod'
import type { MailDetail, MailSummary, MailProvider } from '../../src/shared/mail'

const tokenSchema = z.object({
  access: z.string(),
  refresh: z.string(),
  expires: z.number(),
  refreshExpires: z.number().optional(),
})
const desktopSchema = z.object({
  clientId: z.string().regex(/^[\w.-]+\.apps\.googleusercontent\.com$/),
  secret: z.string().min(1).max(512),
})
const identitySchema = z.object({ id: z.uuid(), email: z.email() })
const imapCredentialSchema = identitySchema.extend({
  provider: z.enum(['netease', 'feishu']),
  password: z.string(),
  sentPath: z.string(),
})
export const credentialSchema = z.union([
  identitySchema.extend({
    provider: z.literal('gmail'),
    token: tokenSchema,
    config: desktopSchema,
  }),
  identitySchema.extend({
    provider: z.literal('feishu'),
    token: tokenSchema,
    appId: z.string(),
    appSecret: z.string(),
  }),
  imapCredentialSchema,
])
export const registrySchema = z.object({
  accounts: z.array(credentialSchema),
  google: desktopSchema.optional(),
})
export type MailCredential = z.infer<typeof credentialSchema>
export type MailRegistry = z.infer<typeof registrySchema>
export type ImapCredential = z.infer<typeof imapCredentialSchema>
export type OAuthCredential<P extends Exclude<MailProvider, 'netease'>> = Extract<
  MailCredential,
  { provider: P; token: z.infer<typeof tokenSchema> }
>
export type Token = z.infer<typeof tokenSchema>
export type DesktopConfig = z.infer<typeof desktopSchema>
export const googleFileSchema = z.object({
  installed: z.object({
    client_id: desktopSchema.shape.clientId,
    client_secret: desktopSchema.shape.secret,
  }),
})
export type Range = { start: number; end: number }
export type Folder = 'inbox' | 'sent'
export type RangeResult = {
  items: MailSummary[]
  split?: boolean
  exhausted?: boolean
  revision?: string
}
export type Provider<C extends MailCredential> = {
  range(
    credential: C,
    folder: Folder,
    range: Range,
    signal: AbortSignal,
    previews?: ReadonlyMap<string, string>,
  ): Promise<RangeResult>
  detail(credential: C, id: string, signal: AbortSignal): Promise<MailDetail>
  read(credential: C, id: string, signal: AbortSignal): Promise<void>
}
export class MailError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'quota' | 'network' | 'api' | 'missing' = 'api',
    readonly retryMs = 30000,
  ) {
    super(message)
  }
}
export const previewText = (text: string) => text.replace(/\s+/gu, ' ').trim().slice(0, 280)
export const maxBodyBytes = 2 * 1024 * 1024
export const maxBodyText = (text: string) =>
  text.length > maxBodyBytes
    ? text.slice(0, maxBodyBytes) + '\n\n（正文过长，请在邮箱中查看完整内容）'
    : text

export async function jsonRequest(url: string, options: RequestInit, signal: AbortSignal) {
  let response: Response
  try {
    response = await fetch(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    })
  } catch {
    signal.throwIfAborted()
    throw new MailError('邮箱服务暂时无法连接，请重试。', 'network')
  }
  const payload: unknown = await response.json().catch(() => null)
  const wait = response.headers.get('Retry-After')
  const seconds = wait === null ? NaN : Number(wait)
  const retryMs =
    wait === null
      ? undefined
      : Math.max(
          5000,
          (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(wait) - Date.now()) || 30000,
        )
  return { response, payload, retryMs }
}
