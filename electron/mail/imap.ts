import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from 'imapflow'
import { simpleParser } from 'mailparser'
import { z } from 'zod'
import { mailProviderNames, type MailSummary } from '../../src/shared/mail'
import {
  MailError,
  maxBodyBytes,
  maxBodyText,
  previewText,
  type ImapCredential,
  type Provider,
} from './provider'

const DAY = 86400000
const getRef = z.tuple([z.string().min(1), z.string().regex(/^\d+$/), z.number().int().positive()])
type Identity = Pick<ImapCredential, 'provider' | 'email' | 'password'>
function localDate(time: number) {
  return new Date(time).toISOString().slice(0, 10)
}
async function connect<T>(
  credential: Identity,
  signal: AbortSignal,
  action: string,
  run: (client: ImapFlow) => Promise<T>,
) {
  signal.throwIfAborted()
  const name = mailProviderNames[credential.provider]
  const client = new ImapFlow({
    host: credential.provider === 'feishu' ? 'imap.feishu.cn' : 'imap.163.com',
    port: 993,
    secure: true,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    auth: { user: credential.email, pass: credential.password },
    clientInfo: { name: 'All In One Workspace', vendor: 'All In One Workspace', version: '1.2.0' },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 20000,
  })
  const onAbort = () => client.close()
  let connected = false
  client.on('error', () => undefined)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await client.connect()
    connected = true
    return await run(client)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof MailError) throw error
    const issue = error as {
      code?: string
      authenticationFailed?: boolean
      responseText?: string
      serverResponseCode?: string
      responseStatus?: string
    }
    const code = issue.code ?? ''
    const response = (issue.serverResponseCode ?? '') + ' ' + (issue.responseText ?? '')
    if (code === 'ETHROTTLE' || /limit|too many|throttl/i.test(response))
      throw new MailError(name + '限制了 IMAP 请求频率或连接数，请稍后重试。', 'quota', 60000)
    if (
      issue.authenticationFailed ||
      /unsafe login|authentication|authorization|login failed/i.test(issue.responseText ?? '')
    )
      throw new MailError(
        credential.provider === 'feishu'
          ? '飞书邮箱登录失败。请确认管理员已允许第三方客户端登录，并检查邮箱地址和专用密码。'
          : '163 邮箱登录失败。请检查 IMAP 开关与客户端授权码。',
        'auth',
      )
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
      throw new MailError(name + ' IMAP 服务器域名解析失败。', 'network')
    if (/CERT|^ERR_(TLS|SSL)|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code))
      throw new MailError(name + ' IMAP 加密连接或证书验证失败。', 'network')
    if (/TIME(?:D)?OUT/i.test(code))
      throw new MailError(
        name + (connected ? action + '超时。' : ' IMAP 连接或握手超时。'),
        'network',
      )
    if (issue.responseStatus === 'NO' || issue.responseStatus === 'BAD')
      throw new MailError(name + ' IMAP 服务器拒绝' + action + '。')
    throw new MailError(
      name + (connected ? action + '时 IMAP 连接中断。' : ' IMAP 连接未建立。'),
      'network',
    )
  } finally {
    signal.removeEventListener('abort', onAbort)
    client.close()
  }
}

export async function discoverSent(input: Identity, signal: AbortSignal, path?: string) {
  return connect(input, signal, '读取邮箱文件夹', async (client) => {
    const folders = (await client.list({ listOnly: true })).filter(
      ({ flags, path }) =>
        !flags.has('\\Noselect') && !flags.has('\\NonExistent') && path.toUpperCase() !== 'INBOX',
    )
    const sent = path
      ? folders.find((folder) => folder.path === path)
      : folders.find(({ specialUse, flags }) => specialUse === '\\Sent' || flags.has('\\Sent'))
    if (!sent) {
      if (!folders.length)
        throw new MailError('邮箱没有返回可用的已发送文件夹，请在邮箱中检查文件夹设置。')
      return { sentFolders: folders.map(({ path }) => path) }
    }
    return { path: sent.path }
  })
}

function textParts(node?: MessageStructureObject): MessageStructureObject[] {
  if (!node || node.disposition === 'attachment') return []
  if (node.childNodes) return node.childNodes.flatMap(textParts)
  return node.type === 'text/plain' || node.type === 'text/html' ? [node] : []
}

async function body(client: ImapFlow, raw: FetchMessageObject, limit: number) {
  const parts = textParts(raw.bodyStructure)
  const part = parts.find(({ type }) => type === 'text/plain') ?? parts[0]
  if (!part) return ''
  const download = await client.download(String(raw.uid), part.part ?? '1', {
    uid: true,
    maxBytes: limit,
    chunkSize: Math.min(limit, 65536),
  })
  if (!download.content) return ''
  const chunks: Buffer[] = []
  for await (const chunk of download.content) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  if (part.type !== 'text/html') return text
  const parsed = await simpleParser('Content-Type: text/html; charset=utf-8\r\n\r\n' + text, {
    skipImageLinks: true,
    skipTextToHtml: true,
  })
  return parsed.text ?? ''
}

function summary(
  credential: ImapCredential,
  path: string,
  validity: string,
  raw: FetchMessageObject,
  text: string,
): MailSummary {
  const addresses = (all: NonNullable<FetchMessageObject['envelope']>['to']) =>
    (all ?? []).map(({ name, address }) => ({ name: name ?? '', email: address ?? '' }))
  if (!raw.internalDate) throw new MailError('邮件缺少服务器时间。')
  return {
    account: credential.id,
    id: JSON.stringify([path, validity, raw.uid]),
    time: new Date(raw.internalDate).getTime(),
    subject: raw.envelope?.subject ?? '',
    from: addresses(raw.envelope?.from),
    to: addresses(raw.envelope?.to),
    preview: previewText(text),
    inbox: path.toUpperCase() === 'INBOX',
    sent: path === credential.sentPath,
    unread: !(raw.flags?.has('\\Seen') ?? false),
  }
}

async function withMessage<T>(
  credential: ImapCredential,
  id: string,
  signal: AbortSignal,
  run: (client: ImapFlow, path: string, validity: string, uid: number) => Promise<T>,
  readOnly: boolean,
) {
  let ref: z.infer<typeof getRef>
  try {
    ref = getRef.parse(JSON.parse(id))
  } catch {
    throw new MailError('邮件标识无效。')
  }
  const [path, validity, uid] = ref
  if (path !== 'INBOX' && path !== credential.sentPath) throw new MailError('邮件文件夹已更改。')
  return connect(credential, signal, readOnly ? '读取邮件正文' : '更新邮件状态', async (client) => {
    const lock = await client.getMailboxLock(path, { readOnly })
    try {
      if (!client.mailbox || String(client.mailbox.uidValidity) !== validity)
        throw new MailError('邮件索引已更新，请刷新列表。')
      return await run(client, path, validity, uid)
    } finally {
      lock.release()
    }
  })
}

export const imap: Provider<ImapCredential> & { discoverSent: typeof discoverSent } = {
  discoverSent,
  range(credential, folder, range, signal, previews) {
    const path = folder === 'inbox' ? 'INBOX' : credential.sentPath
    return connect(
      credential,
      signal,
      folder === 'inbox' ? '读取收件箱' : '读取已发送邮件',
      async (client) => {
        const lock = await client.getMailboxLock(path, { readOnly: true })
        try {
          if (!client.mailbox) throw new MailError('邮件文件夹暂时无法打开。')
          const validity = String(client.mailbox.uidValidity)
          if (!client.mailbox.exists) return { items: [], exhausted: true, revision: validity }
          // IMAP SEARCH dates have day precision and ignore timezone. Filter by INTERNALDATE after FETCH.
          const since = localDate(Math.max(0, range.start - DAY))
          const before = localDate(range.end + 2 * DAY)
          const ids = await client.search({ since, before, deleted: false }, { uid: true })
          if (!ids) throw new MailError('暂时无法搜索邮件。')
          if (ids.length > 100 && range.end - range.start > DAY) return { items: [], split: true }
          const items: MailSummary[] = []
          for (let offset = 0; offset < ids.length; offset += 50) {
            const rows = await client.fetchAll(
              ids.slice(offset, offset + 50),
              {
                internalDate: true,
                envelope: true,
                flags: true,
                bodyStructure: true,
              },
              { uid: true },
            )
            for (const raw of rows) {
              if (!raw.internalDate) continue
              const time = new Date(raw.internalDate).getTime()
              if (time < range.start || time >= range.end) continue
              const id = JSON.stringify([path, validity, raw.uid])
              items.push(
                summary(
                  credential,
                  path,
                  validity,
                  raw,
                  previews?.get(id) ?? (await body(client, raw, 2048)),
                ),
              )
            }
          }
          const older = ids.length
            ? ids
            : range.start > 0
              ? await client.search(
                  { before: localDate(range.start + 2 * DAY), deleted: false },
                  { uid: true },
                )
              : []
          return {
            items,
            exhausted: Array.isArray(older) && older.length === 0,
            revision: validity,
          }
        } finally {
          lock.release()
        }
      },
    )
  },
  detail(credential, id, signal) {
    return withMessage(
      credential,
      id,
      signal,
      async (client, path, validity, uid) => {
        const raw = await client.fetchOne(
          String(uid),
          { internalDate: true, envelope: true, flags: true, bodyStructure: true },
          { uid: true },
        )
        if (!raw || raw.flags?.has('\\Deleted')) throw new MailError('这封邮件已不可用。')
        const text = await body(client, raw, maxBodyBytes)
        return {
          message: summary(credential, path, validity, raw, text),
          body:
            maxBodyText(text) +
            (Buffer.byteLength(text) >= maxBodyBytes
              ? '\n\n（正文过长，请在邮箱中查看完整内容）'
              : ''),
        }
      },
      true,
    )
  },
  read(credential, id, signal) {
    return withMessage(
      credential,
      id,
      signal,
      async (client, _path, _validity, uid) => {
        const current = await client.fetchOne(String(uid), { flags: true }, { uid: true })
        if (!current || current.flags?.has('\\Deleted')) throw new MailError('这封邮件已不可用。')
        if (current.flags?.has('\\Seen')) return
        if (!(await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })))
          throw new MailError('邮箱服务器未确认已读，请重试。')
        const confirmed = await client.fetchOne(String(uid), { flags: true }, { uid: true })
        if (!confirmed || !confirmed.flags?.has('\\Seen'))
          throw new MailError('邮箱服务器未确认已读，请重试。')
      },
      false,
    )
  },
}
