import { simpleParser } from 'mailparser'
import { z } from 'zod'
import { MAIL_POLICY } from '../../src/shared/mail-policy'
import { LoopbackOAuth } from '../feishu/oauth'
import type { MailSummary } from '../../src/shared/mail'
import {
  MailError,
  jsonRequest,
  maxBodyBytes,
  maxBodyText,
  previewText,
  type OAuthCredential,
  type DesktopConfig,
  type Provider,
  type RangeResult,
  type Token,
} from './provider'

type Gmail = OAuthCredential<'gmail'>
const scope = 'https://www.googleapis.com/auth/gmail.modify'
const base = 'https://gmail.googleapis.com/gmail/v1/users/me/'
const headersSchema = z.array(z.object({ name: z.string(), value: z.string() })).default([])
const messageSchema = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  internalDate: z.coerce.number().int().nonnegative(),
  labelIds: z.array(z.string()).default([]),
  snippet: z.string().default(''),
  sizeEstimate: z.number().default(0),
  payload: z.object({ headers: headersSchema }).optional(),
})
const listSchema = z.object({
  messages: z.array(z.object({ id: z.string() })).default([]),
  nextPageToken: z.string().optional(),
})

async function api(token: string, path: string, signal: AbortSignal, body?: object) {
  const { response, payload, retryMs } = await jsonRequest(
    base + path,
    {
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    },
    signal,
  )
  if (response.ok) return payload
  if (response.status === 401) throw new MailError('Gmail 授权已失效，请重新连接。', 'auth')
  const reason = (payload as { error?: { errors?: { reason?: string }[] } } | null)?.error
    ?.errors?.[0]?.reason
  if (
    response.status === 429 ||
    reason === 'rateLimitExceeded' ||
    reason === 'userRateLimitExceeded'
  )
    throw new MailError('Gmail 请求过于频繁，请稍后重试。', 'quota', retryMs)
  if (response.status === 403)
    throw new MailError('Gmail API 不可用，请检查 Cloud 项目、账号权限和 Gmail API 设置。')
  if (response.status === 404) throw new MailError('Gmail 中的这封邮件已不可用。', 'missing')
  throw new MailError(
    'Gmail 暂时无法提供邮件，请重试。',
    response.status >= 500 ? 'network' : 'api',
  )
}

async function exchange(
  config: DesktopConfig,
  fields: Record<string, string>,
  signal: AbortSignal,
  previous?: Token,
) {
  const { response, payload, retryMs } = await jsonRequest(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.secret,
        ...fields,
      }),
    },
    signal,
  )
  if (response.status === 429) throw new MailError('Gmail 授权请求过于频繁。', 'quota', retryMs)
  if (!response.ok) {
    const code = (payload as { error?: string } | null)?.error
    if (code === 'invalid_grant' || code === 'invalid_client')
      throw new MailError('Gmail 授权或 OAuth 客户端配置已失效，请重新连接。', 'auth')
    throw new MailError('暂时无法更新 Gmail 授权，请重试。', 'network')
  }
  const result = z
    .object({
      access_token: z.string().min(1),
      expires_in: z.number().positive(),
      refresh_token: z.string().optional(),
      refresh_token_expires_in: z.number().optional(),
      scope: z.string().optional(),
    })
    .parse(payload)
  if (result.scope && !result.scope.split(' ').includes(scope))
    throw new MailError('请允许 Gmail 邮件读取和已读状态权限。', 'auth')
  const refresh = result.refresh_token || previous?.refresh
  if (!refresh) throw new MailError('Gmail 未返回离线授权，请重新连接。', 'auth')
  return {
    access: result.access_token,
    refresh,
    expires: Date.now() + result.expires_in * 1000,
    refreshExpires: result.refresh_token_expires_in
      ? Date.now() + result.refresh_token_expires_in * 1000
      : previous?.refreshExpires,
  }
}

export function renewGmail(credential: Gmail, signal: AbortSignal) {
  return exchange(
    credential.config,
    { grant_type: 'refresh_token', refresh_token: credential.token.refresh },
    signal,
    credential.token,
  )
}

export async function authorizeGmail(
  config: DesktopConfig,
  open: (url: string) => Promise<void>,
  signal: AbortSignal,
  email?: string,
) {
  const flow = new LoopbackOAuth(open, 0, 300000, {
    name: 'Gmail',
    callbackPath: '/oauth/google/callback',
    authorize: (clientId, redirectUri) => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope,
        access_type: 'offline',
        prompt: 'consent select_account',
        ...(email ? { login_hint: email } : {}),
      }).toString()
      return url
    },
  })
  return new Promise<{ email: string; token: Token }>((resolve, reject) => {
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
      .start('gmail', config.clientId, {
        complete: async (code, verifier, callbackSignal, redirectUri) => {
          try {
            const token = await exchange(
              config,
              {
                grant_type: 'authorization_code',
                code,
                code_verifier: verifier,
                redirect_uri: redirectUri!,
              },
              callbackSignal,
            )
            const profile = z
              .object({ emailAddress: z.email() })
              .parse(await api(token.access, 'profile', callbackSignal))
            callbackSignal.throwIfAborted()
            cleanup()
            resolve({ email: profile.emailAddress, token })
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

async function metadata(credential: Gmail, id: string, signal: AbortSignal) {
  const q = new URLSearchParams({
    // FULL with a response field mask keeps snippets and dates while excluding body data.
    format: 'full',
    fields: 'id,threadId,internalDate,labelIds,snippet,sizeEstimate,payload(headers)',
  })
  return messageSchema.parse(
    await api(credential.token.access, 'messages/' + encodeURIComponent(id) + '?' + q, signal),
  )
}

async function summary(
  credential: Gmail,
  raw: z.infer<typeof messageSchema>,
): Promise<MailSummary> {
  const fields = (raw.payload?.headers ?? [])
    .filter(({ name }) => /^(from|to|subject)$/i.test(name))
    .map(({ name, value }) => name + ': ' + value.replace(/[\r\n]+/gu, ' '))

  const parsed = await simpleParser(fields.join('\r\n') + '\r\n\r\n')
  const addresses = (values: typeof parsed.to) =>
    (Array.isArray(values) ? values : values ? [values] : []).flatMap(({ value }) =>
      value.map(({ name, address }) => ({ name, email: address ?? '' })),
    )
  return {
    account: credential.id,
    id: raw.id,
    time: raw.internalDate,
    subject: parsed.subject ?? '',
    from: addresses(parsed.from),
    to: addresses(parsed.to),
    preview: previewText(raw.snippet),
    inbox: raw.labelIds.includes('INBOX'),
    sent: raw.labelIds.includes('SENT'),
    unread: raw.labelIds.includes('UNREAD'),
  }
}

const headChecks = new Map<string, { until: number; request: Promise<string | undefined> }>()
const gmailHeads = new Map<string, { historyId: string; used: number; result: RangeResult }>()

async function headRevision(credential: Gmail, signal: AbortSignal) {
  const now = Date.now()
  const previous = headChecks.get(credential.id)
  if (previous && previous.until > now) return previous.request
  const request = api(credential.token.access, 'profile?fields=historyId', signal).then(
    (data) => z.object({ historyId: z.string().optional() }).parse(data).historyId,
  )
  headChecks.set(credential.id, { until: now + MAIL_POLICY.manualRefreshMs, request })
  try {
    return await request
  } catch (error) {
    if (headChecks.get(credential.id)?.request === request) headChecks.delete(credential.id)
    throw error
  }
}

function clearHead(id: string) {
  headChecks.delete(id)
  for (const key of gmailHeads.keys()) if (key.startsWith(id + ':')) gmailHeads.delete(key)
}

export const gmail: Provider<Gmail> & { clear?: (id: string) => void; expire?: () => void } = {
  clear: clearHead,
  expire() {
    const now = Date.now()
    for (const [key, value] of gmailHeads)
      if (now - value.used >= MAIL_POLICY.memoryIdleMs) gmailHeads.delete(key)
    for (const [key, value] of headChecks) if (now >= value.until) headChecks.delete(key)
  },
  async range(credential, folder, range, signal) {
    const now = Date.now()
    const cacheKey = [credential.id, folder, range.start, range.end].join(':')
    const historyId =
      range.end > now - MAIL_POLICY.refreshMs ? await headRevision(credential, signal) : undefined
    const remembered = gmailHeads.get(cacheKey)
    if (historyId && remembered?.historyId === historyId) {
      remembered.used = now
      return remembered.result
    }
    const remember = (result: RangeResult) => {
      signal.throwIfAborted()
      if (historyId) {
        gmailHeads.set(cacheKey, { historyId, used: now, result })
        const prefix = credential.id + ':' + folder + ':'
        const keys = [...gmailHeads]
          .filter(([key]) => key.startsWith(prefix))
          .sort((a, b) => b[1].used - a[1].used)
        for (const [key] of keys.slice(4)) gmailHeads.delete(key)
      }
      return result
    }
    const ids = new Set<string>()
    let pageToken: string | undefined
    do {
      const q = new URLSearchParams({
        labelIds: folder === 'inbox' ? 'INBOX' : 'SENT',
        maxResults: '100',
        q:
          'after:' +
          Math.max(0, Math.floor(range.start / 1000) - 1) +
          ' before:' +
          (Math.ceil(range.end / 1000) + 1),
        ...(pageToken ? { pageToken } : {}),
      })
      const result = listSchema.parse(await api(credential.token.access, 'messages?' + q, signal))
      for (const { id } of result.messages) ids.add(id)
      pageToken = result.nextPageToken
      if ((pageToken || ids.size >= 100) && range.end - range.start > 1000)
        return remember({ items: [], split: true })
    } while (pageToken)
    const all = [...ids]
    const items: MailSummary[] = []
    for (let offset = 0; offset < all.length; offset += 6) {
      const messages = await Promise.all(
        all.slice(offset, offset + 6).map(async (id) => {
          try {
            return [await summary(credential, await metadata(credential, id, signal))]
          } catch (error) {
            if (error instanceof MailError && error.kind === 'missing') return []
            throw error
          }
        }),
      )
      items.push(...messages.flat().filter(({ time }) => time >= range.start && time < range.end))
    }
    let exhausted = range.start === 0
    if (!ids.size && !exhausted) {
      const query = new URLSearchParams({
        labelIds: folder === 'inbox' ? 'INBOX' : 'SENT',
        maxResults: '1',
        q: 'before:' + (Math.ceil(range.start / 1000) + 1),
      })
      const older = listSchema.parse(
        await api(credential.token.access, 'messages?' + query, signal),
      )
      exhausted = !older.messages.length && !older.nextPageToken
    }
    return remember({ items, exhausted })
  },
  async detail(credential, id, signal) {
    const info = await metadata(credential, id, signal)
    const message = await summary(credential, info)
    const internetId = info.payload?.headers
      .find(({ name }) => name.toLowerCase() === 'message-id')
      ?.value.trim()
    const messageId = internetId?.replace(/^<(.*)>$/u, '$1')
    const gmail = {
      threadId: /^[a-f0-9]{1,64}$/iu.test(info.threadId ?? '') ? info.threadId : undefined,
      messageId:
        messageId && /^[^\s<>@]{1,256}@[^\s<>@]{1,253}$/u.test(messageId) ? messageId : undefined,
    }
    if (info.sizeEstimate > maxBodyBytes * 2)
      return {
        message,
        gmail,
        body: message.preview + '\n\n（邮件过大，请在 Gmail 中查看完整内容）',
      }
    const raw = z
      .object({ raw: z.string() })
      .parse(
        await api(
          credential.token.access,
          'messages/' + encodeURIComponent(id) + '?format=raw&fields=raw',
          signal,
        ),
      )
    const parsed = await simpleParser(Buffer.from(raw.raw, 'base64url'), {
      skipImageLinks: true,
      skipTextToHtml: true,
    })
    return { message, gmail, body: maxBodyText(parsed.text ?? message.preview) }
  },
  async read(credential, id, signal) {
    await api(credential.token.access, 'messages/' + encodeURIComponent(id) + '/modify', signal, {
      removeLabelIds: ['UNREAD'],
    })
    clearHead(credential.id)
  },
}
