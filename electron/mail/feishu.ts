import { z } from 'zod'
import { MAIL_POLICY } from '../../src/shared/mail-policy'
import { FeishuClient } from '../feishu/client'
import { FeishuError } from '../feishu/errors'
import { OneClickAuth, type SetupPrompt } from '../feishu/one-click'
import { LoopbackOAuth } from '../feishu/oauth'
import type { Authorization } from '../feishu/vault'
import { FEISHU_REDIRECT_URI, type FeishuConfig } from '../../src/shared/feishu'
import type { MailSummary } from '../../src/shared/mail'
import {
  MailError,
  jsonRequest,
  maxBodyText,
  previewText,
  type OAuthCredential,
  type Folder,
  type Provider,
  type Token,
} from './provider'

type Feishu = OAuthCredential<'feishu'>
export const feishuMailScopes = [
  'mail:user_mailbox:readonly',
  'mail:user_mailbox.message:readonly',
  'mail:user_mailbox.message.subject:read',
  'mail:user_mailbox.message.address:read',
  'mail:user_mailbox.message.body:read',
  'mail:user_mailbox.message:modify',
  'offline_access',
]
const base = 'https://open.feishu.cn/open-apis/mail/v1/user_mailboxes/me/'
const address = z.object({ name: z.string().optional(), mail_address: z.string() })
const addresses = z.union([address, z.array(address)]).nullish()
const messageSchema = z.object({
  message_id: z.string().min(1),
  subject: z.string().default(''),
  from: addresses,
  to: addresses,
  internal_date: z.coerce.number().int().nonnegative(),
  body_preview: z.string().optional(),
  body_plain_text: z.string().optional(),
  folder_id: z.string().optional(),
  message_state: z.number().optional(),
  label_ids: z.array(z.string()).nullish(),
})
const envelope = z.object({ code: z.number(), data: z.unknown().optional() })
const searchSchema = z.object({
  items: z.array(z.object({ id: z.string() })).nullish(),
  page_token: z.string().optional(),
  has_more: z.boolean().optional(),
})
const listSchema = searchSchema.extend({ items: z.array(z.string()).nullish() })
const client = new FeishuClient((...args) => fetch(...args))
const tokenFields = (token: Authorization['token']): Token => ({
  access: token.accessToken,
  refresh: token.refreshToken,
  expires: token.expiresAt,
  refreshExpires: token.refreshExpiresAt,
})

async function api(
  token: string,
  path: string,
  signal: AbortSignal,
  method = 'GET',
  body?: object,
) {
  const { response, payload, retryMs } = await jsonRequest(
    base + path,
    {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    signal,
  )
  const result = envelope.safeParse(payload)
  const code = result.success ? result.data.code : undefined
  if (response.status === 429 || [190004, 190005, 190010, 99991400].includes(code ?? 0))
    throw new MailError('飞书邮件请求过于频繁，请稍后重试。', 'quota', retryMs)
  if (response.status === 401 || [99991663, 99991668, 99991671].includes(code ?? 0))
    throw new MailError('飞书授权已失效，请重新连接。', 'auth')
  if (response.status === 403 || code === 99991672)
    throw new MailError('飞书应用缺少邮箱权限，请在开放平台检查邮件权限和用户授权。')
  if (!response.ok || !result.success || code !== 0)
    throw new MailError(
      '飞书无法读取或更新邮件' + (code ? '（' + code + '）' : '') + '，请重试。',
      response.status >= 500 ? 'network' : 'api',
    )
  return result.data.data
}

function oauthError(error: unknown): never {
  if (error instanceof FeishuError)
    throw new MailError(
      error.message,
      error.kind === 'authorization'
        ? 'auth'
        : error.kind === 'rate_limit'
          ? 'quota'
          : error.kind === 'network'
            ? 'network'
            : 'api',
      error.retryAfter || undefined,
    )
  throw error
}

export async function renewFeishu(credential: Feishu, signal: AbortSignal) {
  try {
    return tokenFields(await client.refresh(credential, credential.token.refresh, signal))
  } catch (error) {
    return oauthError(error)
  }
}

function authorizeCustom(
  config: FeishuConfig,
  open: (url: string) => Promise<void>,
  signal: AbortSignal,
) {
  const flow = new LoopbackOAuth(open, 43821, 300000, {
    name: '飞书邮箱',
    callbackPath: new URL(FEISHU_REDIRECT_URI).pathname,
    authorize: (clientId, redirectUri) => {
      const url = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize')
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: feishuMailScopes.join(' '),
        prompt: 'consent',
      }).toString()
      return url
    },
  })
  return new Promise<Authorization['token']>((resolve, reject) => {
    const cancel = () => {
      flow.cancel()
      reject(signal.reason)
    }
    if (signal.aborted) return cancel()
    signal.addEventListener('abort', cancel, { once: true })
    const cleanup = () => signal.removeEventListener('abort', cancel)
    const fail = (error: unknown) => {
      cleanup()
      reject(error)
    }
    void flow
      .start('feishu-mail', config.appId, {
        complete: async (code, verifier, callbackSignal) => {
          try {
            const token = await client.exchange(config, code, verifier, callbackSignal)
            callbackSignal.throwIfAborted()
            cleanup()
            resolve(token)
          } catch (error) {
            fail(error)
            throw error
          }
        },
        failed: (message) => fail(new MailError(message, 'auth')),
      })
      .catch(fail)
  })
}

export async function authorizeFeishu(
  config: FeishuConfig | undefined,
  open: (url: string) => Promise<void>,
  prompt: (value: SetupPrompt) => void,
  signal: AbortSignal,
) {
  const flow = new OneClickAuth(open, fetch, Date.now, feishuMailScopes)
  try {
    const app = config ?? (await flow.register(prompt, signal))
    const token = tokenFields(
      config ? await authorizeCustom(app, open, signal) : await flow.authorize(app, prompt, signal),
    )
    const profile = z
      .object({ primary_email_address: z.email().optional() })
      .parse(await api(token.access, 'profile', signal))
    if (!profile.primary_email_address)
      throw new MailError('该飞书身份没有可用的邮箱，请先在飞书开通邮箱。')
    return { ...app, token, email: profile.primary_email_address }
  } catch (error) {
    return oauthError(error)
  }
}

function decode(text?: string | null) {
  return text ? Buffer.from(text, 'base64url').toString('utf8') : ''
}

function summary(
  credential: Feishu,
  item: z.infer<typeof messageSchema>,
  folder?: Folder,
): MailSummary {
  const addressList = (value: z.infer<typeof addresses>) =>
    (Array.isArray(value) ? value : value ? [value] : []).map(({ name, mail_address }) => ({
      name: name ?? '',
      email: mail_address,
    }))
  return {
    account: credential.id,
    id: item.message_id,
    time: item.internal_date,
    subject: item.subject,
    from: addressList(item.from),
    to: addressList(item.to),
    preview: previewText(decode(item.body_preview)),
    unread: item.label_ids?.includes('UNREAD') ?? false,
    inbox: item.folder_id === 'INBOX' || folder === 'inbox',
    sent: item.folder_id === 'SENT' || item.message_state === 2 || folder === 'sent',
  }
}

async function batch(credential: Feishu, ids: string[], folder: Folder, signal: AbortSignal) {
  const items: MailSummary[] = []
  for (let offset = 0; offset < ids.length; offset += 20) {
    const page = z.object({ messages: z.array(messageSchema).nullish() }).parse(
      await api(credential.token.access, 'messages/batch_get', signal, 'POST', {
        format: 'metadata',
        message_ids: ids.slice(offset, offset + 20),
      }),
    )
    items.push(...(page.messages ?? []).map((msg) => summary(credential, msg, folder)))
  }
  return items
}

export function createFeishuMail(): Provider<Feishu> & {
  clear(id: string): void
  expire?(): void
} {
  // A mismatch between the folder listing and date search switches the folder to a complete inventory.
  const indexes = new Map<string, { items: MailSummary[]; time: number; used: number }>()
  const fallback = new Set<string>()
  const checked = new Map<string, number>()
  const keyOf = (credential: Feishu, folder: Folder) => credential.id + ':' + folder

  async function folderPage(
    credential: Feishu,
    folder: Folder,
    signal: AbortSignal,
    pageToken?: string,
  ) {
    const q = new URLSearchParams({
      folder_id: folder.toUpperCase(),
      page_size: '20',
      ...(pageToken ? { page_token: pageToken } : {}),
    })
    return listSchema.parse(await api(credential.token.access, 'messages?' + q, signal))
  }

  async function search(
    credential: Feishu,
    folder: Folder,
    start: number,
    end: number,
    signal: AbortSignal,
  ) {
    const ids = new Set<string>()
    let pageToken: string | undefined
    do {
      const q = new URLSearchParams({
        page_size: '15',
        ...(pageToken ? { page_token: pageToken } : {}),
      })
      const result = searchSchema.parse(
        await api(credential.token.access, 'search?' + q, signal, 'POST', {
          query: '',
          filter: {
            folder: [folder],
            create_time: {
              start_time: new Date(Math.max(0, Math.floor(start / 1000) * 1000 - 1000))
                .toISOString()
                .replace('.000Z', 'Z'),
              end_time: new Date(Math.ceil(end / 1000) * 1000 + 1000)
                .toISOString()
                .replace('.000Z', 'Z'),
            },
          },
        }),
      )
      for (const { id } of result.items ?? []) ids.add(id)
      pageToken = result.has_more ? result.page_token : undefined
      if (result.has_more && !pageToken) throw new MailError('飞书返回了无效的分页游标。')
      if (ids.size >= 60 && end - start > 1000) return { items: [], split: true }
    } while (pageToken)
    return { items: await batch(credential, [...ids], folder, signal) }
  }

  return {
    expire() {
      const now = Date.now()
      for (const [key, value] of indexes)
        if (now - value.used >= MAIL_POLICY.memoryIdleMs) indexes.delete(key)
    },
    clear(id) {
      for (const folder of ['inbox', 'sent'] as const) {
        const key = id + ':' + folder
        indexes.delete(key)
        fallback.delete(key)
        checked.delete(key)
      }
    },
    async range(credential, folder, range, signal) {
      const key = keyOf(credential, folder)
      const within = ({ time }: MailSummary) => time >= range.start && time < range.end
      if (!fallback.has(key)) {
        const result = await search(credential, folder, range.start, range.end, signal)
        if (result.split) return result
        if (Date.now() - (checked.get(key) ?? 0) >= 15 * 60 * 1000 || range.start === 0) {
          const head = await folderPage(credential, folder, signal)
          const samples = await batch(credential, head.items ?? [], folder, signal)
          if (
            samples.some(
              (sample) => within(sample) && !result.items.some(({ id }) => id === sample.id),
            )
          )
            fallback.add(key)
          if (samples.some(within)) checked.set(key, Date.now())
          if (!head.has_more && !fallback.has(key)) {
            return {
              items: result.items.filter(within),
              exhausted: !samples.some(({ time }) => time < range.start),
            }
          }
        }
        if (!fallback.has(key)) return { items: result.items.filter(within) }
      }
      let index = indexes.get(key)
      if (
        !index ||
        (range.end > Date.now() - MAIL_POLICY.refreshMs &&
          Date.now() - index.time >= MAIL_POLICY.refreshMs)
      ) {
        const items: MailSummary[] = []
        let pageToken: string | undefined
        do {
          const page = await folderPage(credential, folder, signal, pageToken)
          items.push(...(await batch(credential, page.items ?? [], folder, signal)))
          pageToken = page.has_more ? page.page_token : undefined
          if (page.has_more && !pageToken) throw new MailError('飞书返回了无效的分页游标。')
        } while (pageToken)
        index = { items, time: Date.now(), used: Date.now() }
        signal.throwIfAborted()
        indexes.set(key, index)
      }
      index.used = Date.now()
      return {
        items: index.items.filter(within),
        exhausted: !index.items.some(({ time }) => time < range.start),
      }
    },
    async detail(credential, id, signal) {
      const response = z
        .object({ message: messageSchema })
        .parse(
          await api(
            credential.token.access,
            'messages/' + encodeURIComponent(id) + '?format=plain_text_full',
            signal,
          ),
        )
      return {
        message: summary(credential, response.message),
        body: maxBodyText(decode(response.message.body_plain_text)),
      }
    },
    async read(credential, id, signal) {
      await api(credential.token.access, 'messages/batch_modify', signal, 'POST', {
        message_ids: [id],
        remove_label_ids: ['UNREAD'],
      })
      const confirmed = await batch(credential, [id], 'inbox', signal)
      if (!confirmed.some((message) => message.id === id && !message.unread))
        throw new MailError('飞书未确认已读，请重试。')
      for (const folder of ['inbox', 'sent'] as const) {
        const item = indexes
          .get(keyOf(credential, folder))
          ?.items.find((message) => message.id === id)
        if (item) item.unread = false
      }
    },
  }
}
