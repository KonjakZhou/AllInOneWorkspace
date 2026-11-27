import { afterEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { authorizeGmail, gmail, renewGmail } from '../electron/mail/gmail'
import { discoverSent, imap } from '../electron/mail/imap'
import type { ImapCredential, OAuthCredential } from '../electron/mail/provider'

const connect = vi.hoisted(() => vi.fn())
vi.mock('imapflow', () => ({
  ImapFlow: class {
    constructor(options: unknown) {
      return connect(options)
    }
  },
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

const neteaseAccount: ImapCredential = {
  provider: 'netease',
  id: '7d805db7-2e80-46a9-b928-8fb1a3ab41db',
  email: 'test@163.com',
  password: 'client-code',
  sentPath: '已发送',
}
const signal = () => new AbortController().signal

describe('Gmail', () => {
  it('通过桌面 OAuth 识别正确邮箱，并保留或轮换离线令牌', async () => {
    const realFetch = globalThis.fetch
    let requested: URLSearchParams | undefined
    let rotation = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.endsWith('/profile')) return Response.json({ emailAddress: 'a@gmail.com' })
        requested = init?.body as URLSearchParams
        if (requested.get('grant_type') === 'authorization_code')
          return Response.json({
            access_token: 'first',
            refresh_token: 'refresh-first',
            expires_in: 3600,
          })
        return Response.json({
          access_token: 'next',
          expires_in: 3600,
          ...(rotation++ > 0 ? { refresh_token: 'refresh-next' } : {}),
        })
      }),
    )
    const config = { clientId: 'test.apps.googleusercontent.com', secret: 'google-desktop-secret' }
    let oauth!: URL
    const request = authorizeGmail(
      config,
      async (url) => {
        oauth = new URL(url)
      },
      signal(),
    )
    await vi.waitFor(() => expect(oauth).toBeDefined())
    expect(oauth.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.modify')
    expect(oauth.searchParams.get('access_type')).toBe('offline')
    const redirect = new URL(oauth.searchParams.get('redirect_uri')!)
    expect(redirect.hostname).toBe('127.0.0.1')
    redirect.searchParams.set('state', oauth.searchParams.get('state')!)
    redirect.searchParams.set('code', 'browser-code')
    expect((await realFetch(redirect)).status).toBe(200)
    const authenticated = await request
    expect(authenticated.email).toBe('a@gmail.com')
    expect(requested?.get('code_verifier')).toBeTruthy()
    const credential: OAuthCredential<'gmail'> = {
      ...authenticated,
      config,
      provider: 'gmail',
      id: neteaseAccount.id,
    }
    const reused = await renewGmail(credential, signal())
    expect(reused.refresh).toBe('refresh-first')
    const rotated = await renewGmail({ ...credential, token: reused }, signal())
    expect(rotated.refresh).toBe('refresh-next')
    expect(requested?.get('refresh_token')).toBe('refresh-first')
  })

  it('按 Gmail 标签读取摘要并用远程 modify 移除 UNREAD', async () => {
    const time = Date.now() - 5000
    const config = { clientId: 'test.apps.googleusercontent.com', secret: 'desktop-secret' }
    const credential: OAuthCredential<'gmail'> = {
      provider: 'gmail',
      id: neteaseAccount.id,
      email: 'a@gmail.com',
      config,
      token: { access: 'access', refresh: 'refresh', expires: Date.now() + 3600000 },
    }
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input)
      if (url.pathname.endsWith('/modify')) {
        expect(JSON.parse(String(init?.body))).toEqual({ removeLabelIds: ['UNREAD'] })
        return Response.json({})
      }
      if (url.pathname.endsWith('/messages')) {
        expect(url.searchParams.get('labelIds')).toBe('INBOX')
        return Response.json({ messages: [{ id: 'gmail-message' }] })
      }
      return Response.json({
        id: 'gmail-message',
        internalDate: String(time),
        labelIds: ['INBOX', 'UNREAD'],
        snippet: '正文摘要',
        payload: {
          headers: [
            { name: 'Subject', value: 'Hello' },
            { name: 'From', value: 'Sender <from@example.com>' },
          ],
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await gmail.range(
      credential,
      'inbox',
      { start: time - 1000, end: time + 1000 },
      signal(),
    )
    expect(result.items[0]).toMatchObject({
      subject: 'Hello',
      preview: '正文摘要',
      unread: true,
      from: [{ name: 'Sender', email: 'from@example.com' }],
    })
    await gmail.read(credential, 'gmail-message', signal())
    expect(fetchMock.mock.calls.at(-1)?.[0]).toContain('/gmail-message/modify')
  })
})

describe('IMAP', () => {
  it('使用 TLS 和客户端 ID，枚举可选择的已发送文件夹', async () => {
    const mock = {
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn(async () => [
        { path: 'INBOX', flags: new Set() },
        { path: '已发送', flags: new Set(), specialUse: '\\Sent' },
        { path: '不允许打开', flags: new Set(['\\Noselect']) },
        { path: '其他文件夹', flags: new Set() },
      ]),
    }
    connect.mockReturnValue(mock)
    expect(await discoverSent(neteaseAccount, signal())).toEqual({ path: '已发送' })
    expect(await discoverSent(neteaseAccount, signal(), '丢失的文件夹')).toEqual({
      sentFolders: ['已发送', '其他文件夹'],
    })
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'imap.163.com',
        port: 993,
        secure: true,
        tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
        clientInfo: expect.objectContaining({ name: 'All In One Workspace' }),
      }),
    )
    expect(mock.close).toHaveBeenCalledTimes(2)
  })

  it('使用飞书的 TLS 服务器和专用密码读取收件、发件与正文', async () => {
    const account: ImapCredential = {
      ...neteaseAccount,
      provider: 'feishu',
      email: 'test@example.com',
      sentPath: 'Sent Items',
    }
    const now = Date.now()
    const message = {
      uid: 9,
      internalDate: new Date(now),
      envelope: {
        subject: '飞书邮件',
        from: [{ name: '发送者', address: 'from@example.com' }],
      },
      flags: new Set<string>(),
      bodyStructure: { type: 'text/plain', part: '1' },
    }
    const mock = {
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn(async () => [{ path: account.sentPath, flags: new Set(['\\Sent']) }]),
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
      mailbox: { uidValidity: 42n, exists: 1 },
      search: vi.fn(async () => [message.uid]),
      fetchAll: vi.fn(async () => [message]),
      fetchOne: vi.fn(async () => message),
      download: vi.fn(async () => ({ content: Readable.from(['飞书正文']) })),
      messageFlagsAdd: vi.fn(async () => {
        message.flags.add('\\Seen')
        return true
      }),
    }
    connect.mockReturnValue(mock)
    expect(await discoverSent(account, signal())).toEqual({ path: account.sentPath })
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'imap.feishu.cn',
        port: 993,
        secure: true,
        tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
        auth: { user: 'test@example.com', pass: 'client-code' },
      }),
    )
    const range = { start: now - 1000, end: now + 1000 }
    const inbox = await imap.range(account, 'inbox', range, signal())
    const sent = await imap.range(account, 'sent', range, signal())
    expect(inbox.items[0]).toMatchObject({
      subject: '飞书邮件',
      from: [{ name: '发送者', email: 'from@example.com' }],
      preview: '飞书正文',
      inbox: true,
      unread: true,
    })
    expect(sent.items[0]).toMatchObject({ inbox: false, sent: true })
    const { id } = inbox.items[0]
    const refreshed = await imap.range(
      account,
      'inbox',
      range,
      signal(),
      new Map([[id, '缓存摘要']]),
    )
    expect(refreshed.items[0].preview).toBe('缓存摘要')
    expect(mock.download).toHaveBeenCalledTimes(2)
    expect(await imap.detail(account, id, signal())).toMatchObject({
      message: { unread: true },
      body: '飞书正文',
    })
    expect(mock.getMailboxLock).toHaveBeenLastCalledWith('INBOX', { readOnly: true })
    expect(mock.messageFlagsAdd).not.toHaveBeenCalled()
    await imap.read(account, id, signal())
    expect(mock.getMailboxLock).toHaveBeenLastCalledWith('INBOX', { readOnly: false })
    expect(mock.messageFlagsAdd).toHaveBeenCalledWith('9', ['\\Seen'], { uid: true })
  })

  it('区分 IMAP 的连接超时、服务端限流与命令拒绝', async () => {
    const mock = { on: vi.fn(), close: vi.fn(), connect: vi.fn(), list: vi.fn() }
    connect.mockReturnValue(mock)
    const account = { ...neteaseAccount, provider: 'feishu' } as const
    mock.connect.mockRejectedValueOnce({ code: 'GREETING_TIMEOUT' })
    await expect(discoverSent(account, signal())).rejects.toMatchObject({
      kind: 'network',
      message: '飞书邮箱 IMAP 连接或握手超时。',
    })
    mock.connect.mockRejectedValueOnce({ authenticationFailed: true, code: 'ETHROTTLE' })
    await expect(discoverSent(account, signal())).rejects.toMatchObject({ kind: 'quota' })
    mock.list.mockRejectedValueOnce({ responseStatus: 'NO' })
    await expect(discoverSent(account, signal())).rejects.toMatchObject({
      kind: 'api',
      message: '飞书邮箱 IMAP 服务器拒绝读取邮箱文件夹。',
    })
  })

  it('拒绝旧 UIDVALIDITY，更新当前邮件后核对 Seen', async () => {
    const release = vi.fn()
    const flags = new Set<string>()
    const mock = {
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      mailbox: { uidValidity: 42n },
      getMailboxLock: vi.fn(async () => ({ release })),
      fetchOne: vi.fn(async () => ({ flags })),
      messageFlagsAdd: vi.fn(async () => {
        flags.add('\\Seen')
        return true
      }),
    }
    connect.mockReturnValue(mock)
    await expect(
      imap.read(neteaseAccount, JSON.stringify(['INBOX', '41', 11]), signal()),
    ).rejects.toThrow('邮件索引已更新')
    expect(mock.messageFlagsAdd).not.toHaveBeenCalled()
    await imap.read(neteaseAccount, JSON.stringify(['INBOX', '42', 11]), signal())
    expect(mock.messageFlagsAdd).toHaveBeenCalledWith('11', ['\\Seen'], { uid: true })
    expect(mock.fetchOne).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenCalledTimes(2)
  })
})
