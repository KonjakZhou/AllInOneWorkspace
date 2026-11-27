import { mkdtemp, readdir, readFile, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gmail } from '../electron/mail/gmail'
import { type MailCredential, MailError } from '../electron/mail/provider'
import { MailService, type Providers } from '../electron/mail/service'
import { MailStorage } from '../electron/mail/storage'
import { defaultMailFilter, mailKey, type MailCursor, type MailSummary } from '../src/shared/mail'
import { MAIL_POLICY } from '../src/shared/mail-policy'

const work = '75b2a68f-fd95-47ae-ad06-a88e9c353ad0'
const other = 'b892b0c6-04e8-4788-90bb-4f18f5e4c714'
const first = 'f029ab45-5483-4945-bc1e-b22168c70185'
const second = '91ccc34e-b74f-4918-856e-3ebb2135afe2'
const now = Date.UTC(2026, 10, 26, 10)
const day = 86400000
let directory: string
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (directory) await rm(directory, { recursive: true, force: true })
})

function row(account: string, id: string, time: number, sent = false): MailSummary {
  return {
    account,
    id,
    time,
    subject: '私有主题 ' + id,
    from: [],
    to: [],
    preview: '私有摘要',
    inbox: !sent,
    sent,
    unread: !sent,
  }
}

async function setup(items: MailSummary[], google?: Providers['gmail']) {
  directory = await mkdtemp(join(tmpdir(), 'mail-service-'))
  const storage = new MailStorage(directory, {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0x5a)),
    decryptStringAsync: async (value) => ({
      result: Buffer.from(value.map((byte) => byte ^ 0x5a)).toString(),
      shouldReEncrypt: false,
    }),
  })
  const accounts: MailCredential[] = [first, second].map((id, index) => ({
    id,
    email: 'mail' + index + '@163.com',
    provider: 'netease',
    sentPath: 'Sent',
    password: 'secret-authorization-code',
  }))
  await storage.save(work, { accounts })
  let clock = now
  let failure = false
  let failsRead = false
  const changed = vi.fn()
  const imap: Providers['imap'] = {
    discoverSent: vi.fn(async () => ({ path: 'Sent' })),
    range: vi.fn(async (credential, folder, { start, end }) => {
      if (failure && credential.id === second) throw new MailError('邮箱暂不可用', 'network', 30000)
      const subset = items.filter(
        ({ account, sent }) => account === credential.id && sent === (folder === 'sent'),
      )
      const filtered = subset.filter(({ time }) => time >= start && time < end)
      if (filtered.length > 60 && end - start > 1000) return { items: [], split: true }
      return {
        items: filtered.map((value) => ({ ...value })),
        exhausted: !subset.some(({ time }) => time < start),
      }
    }),
    detail: vi.fn(async (credential, id) => ({
      message: { ...items.find((row) => row.account === credential.id && row.id === id)! },
      body: '完整的本地内存正文',
    })),
    read: vi.fn(async (credential, id) => {
      if (failsRead) throw new MailError('服务器拒绝')
      items.find((row) => row.account === credential.id && row.id === id)!.unread = false
    }),
  }
  const unreachable = () => {
    throw new Error('Unexpected provider')
  }
  const unused = { range: unreachable, detail: unreachable, read: unreachable }
  const open = vi.fn(async (_url: string) => {})
  const drivers: Providers = {
    imap,
    feishu: { ...unused, clear: vi.fn() },
    gmail: google ?? unused,
  }
  const service = new MailService(storage, open, changed, drivers, () => clock)
  service.activate(work)
  return {
    service,
    storage,
    imap,
    changed,
    open,
    drivers,
    fail: (value: boolean) => {
      failure = value
    },
    failRead: (value: boolean) => {
      failsRead = value
    },
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('共享邮箱服务', () => {
  it.each(['netease', 'feishu-imap', 'feishu-oauth', 'gmail'] as const)(
    '%s 的历史摘要在重启后从加密磁盘恢复，并保持账号隔离和已读同步',
    async (source) => {
      const incoming = row(first, 'history', now - 2 * day)
      const { service, storage, drivers } = await setup([incoming])
      const identity = { id: first, email: 'test@example.com' }
      const token = { access: 'test', refresh: 'test', expires: now + day }
      const credential: MailCredential =
        source === 'gmail'
          ? {
              ...identity,
              provider: 'gmail',
              token,
              config: { clientId: 'test.apps.googleusercontent.com', secret: 'test' },
            }
          : source === 'feishu-oauth'
            ? { ...identity, provider: 'feishu', token, appId: 'cli_test', appSecret: 'test' }
            : {
                ...identity,
                provider: source === 'netease' ? 'netease' : 'feishu',
                password: 'test',
                sentPath: 'Sent',
              }
      const range = vi.fn(async () => ({ items: [{ ...incoming }], exhausted: true }))
      const read = vi.fn(async () => {})
      for (const driver of Object.values(drivers)) Object.assign(driver, { range, read })
      service.deactivate()
      await storage.save(work, { accounts: [credential] })
      service.activate(work)
      const filter = { account: first, folder: 'inbox' } as const
      const cursor = { time: now - day, key: null }
      expect((await service.list(work, filter, cursor)).items).toEqual([incoming])
      await storage.cleanup()
      const history = join(directory, 'cache', 'mail-v1')
      for (const file of await readdir(history))
        expect(await readFile(join(history, file), 'utf8')).not.toContain('私有')
      service.deactivate()
      service.activate(work)
      expect(await service.cached(work, filter, true)).toEqual([incoming])
      expect((await service.list(work, filter, cursor)).items).toEqual([incoming])
      expect(range).toHaveBeenCalledTimes(1)
      await service.markRead(work, incoming)
      await storage.cleanup()
      service.deactivate()
      service.activate(work)
      expect(await service.cached(work, filter, true)).toEqual([{ ...incoming, unread: false }])
      expect(await service.cached(work, { ...filter, account: second }, true)).toEqual([])
      await service.disconnect(work, first)
      expect(await readdir(history)).toEqual([])
    },
  )

  it('一分钟内复用自动刷新结果，手动刷新保持五秒去重', async () => {
    const incoming = row(first, 'latest', now - 1000)
    const { service, imap, advance } = await setup([incoming])
    const filter = { account: first, folder: 'inbox' } as const
    await service.list(work, filter)
    advance(59999)
    await service.list(work, filter)
    expect(imap.range).toHaveBeenCalledTimes(1)
    advance(1)
    await service.list(work, filter)
    expect(imap.range).toHaveBeenCalledTimes(2)
    advance(4999)
    await service.list(work, filter, undefined, true)
    expect(imap.range).toHaveBeenCalledTimes(2)
    advance(1)
    await service.list(work, filter, undefined, true)
    expect(imap.range).toHaveBeenCalledTimes(3)
  })

  it('最新、历史和正文均在十分钟闲置后释放，访问会重新计时', async () => {
    const recent = row(first, 'latest', now - 1000)
    const older = row(first, 'history', now - 2 * day)
    const { service, imap, advance } = await setup([recent, older])
    await service.list(work, { account: first, folder: 'inbox' })
    await service.detail(work, older)
    advance(599999)
    expect(await service.cached(work, defaultMailFilter)).toEqual([recent, older])
    await service.detail(work, older)
    expect(imap.detail).toHaveBeenCalledTimes(1)
    advance(600000)
    expect(await service.cached(work, defaultMailFilter)).toEqual([])
    await service.detail(work, older)
    expect(imap.detail).toHaveBeenCalledTimes(2)
  })

  it('正文超过八封时先淘汰最久未访问的正文', async () => {
    const items = Array.from({ length: 9 }, (_, i) => row(first, String(i), now - i))
    const { service, imap, advance } = await setup(items)
    for (const item of items.slice(0, 8)) {
      await service.detail(work, item)
      advance(1)
    }
    await service.detail(work, items[0])
    advance(1)
    await service.detail(work, items[8])
    await service.detail(work, items[0])
    expect(imap.detail).toHaveBeenCalledTimes(9)
    await service.detail(work, items[1])
    expect(imap.detail).toHaveBeenCalledTimes(10)
  })

  it('在目标 Gmail 账号打开会话，缺少会话标识时按原始邮件 ID 搜索', async () => {
    const { service, storage, open } = await setup([], gmail)
    const accounts: MailCredential[] = [first, second].map((id, index) => ({
      id,
      provider: 'gmail',
      email: 'mail' + index + '@gmail.com',
      config: { clientId: 'test.apps.googleusercontent.com', secret: 'test' },
      token: { access: 'access-' + index, refresh: 'refresh', expires: now + day },
    }))
    service.deactivate()
    await storage.save(work, { accounts })
    service.activate(work)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input)
        const hasThread = url.pathname.endsWith('/with-thread')
        expect(new Headers(init?.headers).get('Authorization')).toBe(
          'Bearer access-' + (hasThread ? 0 : 1),
        )
        if (url.searchParams.get('format') === 'raw')
          return Response.json({
            raw: Buffer.from('Subject: Test\r\n\r\nThe body').toString('base64url'),
          })
        expect(url.searchParams.get('fields')).toContain('threadId')
        return Response.json({
          id: hasThread ? 'with-thread' : 'search-by-id',
          ...(hasThread ? { threadId: '19ab22fc91' } : {}),
          internalDate: now - 3000,
          payload: { headers: [{ name: 'Message-ID', value: '<id+reply@example.com>' }] },
        })
      }),
    )
    await expect(service.openReply(work, { account: first, id: 'with-thread' })).resolves.toEqual({
      kind: 'thread',
    })
    await expect(service.openReply(work, { account: second, id: 'search-by-id' })).resolves.toEqual(
      { kind: 'search' },
    )
    expect(open.mock.calls).toEqual([
      ['https://mail.google.com/mail/?authuser=mail0%40gmail.com#all/19ab22fc91'],
      [
        'https://mail.google.com/mail/?authuser=mail1%40gmail.com#search/rfc822msgid%3Aid%2Breply%40example.com',
      ],
    ])
  })

  it('飞书 IMAP 与已有飞书账号共用邮箱身份校验，历史使用统一磁盘缓存', async () => {
    const { imap, service, storage } = await setup([])
    const persistHistory = vi.spyOn(storage, 'put')
    const input = {
      provider: 'feishu',
      method: 'imap',
      email: 'one@example.com',
      password: 'feishu-client-password',
    } as const
    vi.mocked(imap.discoverSent).mockResolvedValueOnce({ sentFolders: ['Sent'] })
    expect(await service.connect(work, input)).toEqual({ sentFolders: ['Sent'] })
    expect((await service.state(work)).accounts).toHaveLength(2)
    expect(await service.connect(work, { ...input, sentPath: 'Sent' })).toEqual({ connected: true })
    expect(await service.connect(work, { ...input, email: 'two@example.com' })).toEqual({
      connected: true,
    })
    const accounts = (await service.state(work)).accounts.filter(
      ({ provider }) => provider === 'feishu',
    )
    expect(accounts.map(({ email, feishuMethod }) => [email, feishuMethod])).toEqual([
      ['one@example.com', 'imap'],
      ['two@example.com', 'imap'],
    ])
    const account = accounts[0].id
    await expect(
      service.connect(work, { ...input, email: 'two@example.com', reconnect: account }),
    ).rejects.toThrow('请使用原邮箱')
    await expect(service.connect(work, input)).rejects.toThrow('此邮箱已连接')
    const cursor = { time: now - day, key: null }
    await service.list(work, { ...defaultMailFilter, account }, cursor)
    expect(imap.range).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'feishu', id: account, sentPath: 'Sent' }),
      expect.any(String),
      expect.any(Object),
      expect.any(AbortSignal),
      expect.any(Map),
    )
    expect(persistHistory).toHaveBeenCalledWith(work, account, expect.any(String), {
      items: [],
      exhausted: true,
    })
    service.deactivate()
    service.activate(work)
    expect((await service.state(work)).accounts).toHaveLength(4)
  })

  it('在密集区间和同时间邮件之间分页，向前扫描空区间并稳定合并账号和文件夹', async () => {
    const rows = Array.from({ length: 149 }, (_, i) =>
      row(i % 4 ? first : second, String(i), now - 2000, i % 5 === 0),
    )
    rows.push(row(first, 'old', now - day * 15))
    const { service } = await setup(rows)
    const received: MailSummary[] = []
    let cursor: MailCursor | undefined
    for (let i = 0; i < 10; i++) {
      const page = await service.list(work, defaultMailFilter, cursor)
      expect(page.items.length).toBeLessThanOrEqual(50)
      expect(page.issues).toEqual([])
      received.push(...page.items)
      if (!page.next) break
      cursor = page.next
    }
    expect(received.map(mailKey)).toEqual(
      rows
        .slice()
        .sort((a, b) => b.time - a.time || (mailKey(a) < mailKey(b) ? -1 : 1))
        .map(mailKey),
    )
    const sent = await service.list(work, { account: first, folder: 'sent' })
    expect(sent.items.length).toBeGreaterThan(0)
    expect(
      sent.items.every(({ account, inbox, sent }) => account === first && sent && !inbox),
    ).toBe(true)
  })

  it('在网络冷却期间保留部分账号结果，重试补回遗漏的较新邮件', async () => {
    const older = row(first, 'older', now - day * 15)
    const newer = row(second, 'newer', now - 1000)
    const { service, fail, advance, imap } = await setup([older, newer])
    const separate = { ...defaultMailFilter, account: first }
    expect((await service.list(work, separate)).items).toEqual([older])
    fail(true)
    const initial = await service.list(work, defaultMailFilter)
    expect(initial.items).toEqual([older])
    expect(initial.issues).toEqual([{ account: second, message: '邮箱暂不可用' }])
    expect(await service.cached(work, defaultMailFilter)).toEqual([older])
    const count = vi
      .mocked(imap.range)
      .mock.calls.filter(([credential]) => credential.id === second).length
    await service.list(work, defaultMailFilter)
    expect(
      vi.mocked(imap.range).mock.calls.filter(([credential]) => credential.id === second),
    ).toHaveLength(count)
    fail(false)
    advance(MAIL_POLICY.refreshMs + 1)
    expect((await service.list(work, defaultMailFilter, undefined, true)).items).toEqual([
      newer,
      older,
    ])
  })

  it('离线账号保留独立缓存，正常账号可在汇总中继续分页', async () => {
    const offline = row(second, 'offline', now - 1000)
    const available = Array.from({ length: 65 }, (_, index) =>
      row(first, String(index), now - day * (index < 55 ? 2 : 7) - index),
    )
    const { service, fail, advance } = await setup([offline, ...available])
    const expired = { ...defaultMailFilter, account: second }
    expect((await service.list(work, expired)).items).toEqual([offline])
    advance(MAIL_POLICY.refreshMs + 1)
    fail(true)
    const head = await service.list(work, defaultMailFilter)
    expect(head.items).toEqual([offline, ...available.slice(0, 49)])
    expect(head.issues).toHaveLength(1)
    expect(head.next).not.toBeNull()
    expect((await service.list(work, expired)).items).toEqual([offline])
    const rest = await service.list(work, defaultMailFilter, head.next!)
    expect(rest.items).toEqual(available.slice(49))
    expect(rest.next).toBeNull()
  })

  it('等远程确认才更新已读，同时复用并清理缓存', async () => {
    const incoming = row(first, 'inbox', now - day * 2)
    const { service, changed, failRead, storage } = await setup([incoming])
    const filter = { account: first, folder: 'unread' } as const
    const [one, two] = await Promise.all([service.list(work, filter), service.list(work, filter)])
    expect(one).toEqual(two)
    const history = join(directory, 'cache', 'mail-v1')
    await storage.cleanup()
    const files = await readdir(history)
    expect(files.length).toBeGreaterThan(0)
    for (const name of files)
      expect(await readFile(join(history, name), 'utf8')).not.toContain('私有')
    failRead(true)
    await expect(service.markRead(work, incoming)).rejects.toThrow('服务器拒绝')
    expect(changed.mock.calls.some(([, value]) => value.kind === 'read')).toBe(false)
    expect((await service.list(work, filter)).items).toHaveLength(1)
    failRead(false)
    await service.markRead(work, incoming)
    expect(changed).toHaveBeenCalledWith(work, { kind: 'read', message: incoming })
    expect((await service.list(work, filter)).items).toEqual([])
    expect((await service.detail(work, incoming)).message.unread).toBe(false)
    await storage.cleanup()
    expect(await readdir(history)).toEqual(files)
    service.deactivate()
    service.activate(work)
    expect(await service.cached(work, { ...filter, folder: 'all' }, true)).toEqual([
      { ...incoming, unread: false },
    ])
    expect(await service.cached(work, filter, true)).toEqual([])
    await service.disconnect(work, first)
    expect((await service.state(work)).accounts.map(({ id }) => id)).toEqual([second])
    expect((await readdir(history)).every((name) => !name.includes(first))).toBe(true)
  })

  it('切换工作区后作废读请求并清除删除工作区的授权', async () => {
    const { service, imap, storage } = await setup([])
    let release!: () => void
    vi.mocked(imap.range).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { items: [] }
    })
    const query = service.list(work, { account: first, folder: 'inbox' })
    const rejected = expect(query).rejects.toBeDefined()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    service.activate(other)
    release()
    await rejected
    expect((await service.state(other)).accounts).toEqual([])
    await expect(service.state(work)).rejects.toThrow('当前工作区已切换')
    await service.removeWorkspace(work)
    expect(await storage.load(work)).toEqual({ accounts: [] })
  })
})

describe('邮箱磁盘容量和闲置期限', () => {
  it.each(['get', 'recent'] as const)(
    '%s 可读取四十七小时前的缓存，并从本次访问重计四十八小时',
    async (method) => {
      const incoming = row(first, 'history', now - 2 * day)
      const { storage } = await setup([])
      await storage.put(work, first, 'history', { items: [incoming] })
      const history = join(directory, 'cache', 'mail-v1')
      const [file] = await readdir(history)
      const path = join(history, file)
      const clock = Math.floor(Date.now() / 1000) * 1000
      const old = (clock - 47 * 60 * 60 * 1000) / 1000
      await utimes(path, old, old)
      const time = vi.spyOn(Date, 'now').mockReturnValue(clock)
      if (method === 'get')
        expect((await storage.get(work, first, 'history'))?.items).toEqual([incoming])
      else expect(await storage.recent(work, first)).toEqual([incoming])
      expect((await stat(path)).mtimeMs).toBe(clock)
      time.mockReturnValue(clock + 48 * 60 * 60 * 1000 - 1)
      await storage.cleanup()
      expect(await readdir(history)).toEqual([file])
      time.mockReturnValue(clock + 48 * 60 * 60 * 1000)
      await storage.cleanup()
      expect(await readdir(history)).toEqual([])
      expect((await storage.load(work)).accounts).toHaveLength(2)
    },
  )

  it('访问旧缓存块不会用旧的未读状态覆盖后来保存的摘要', async () => {
    const incoming = row(first, 'history', now - 2 * day)
    const { storage } = await setup([])
    const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    await storage.put(work, first, 'old', { items: [incoming] })
    time.mockReturnValue(Date.now() + 1000)
    await storage.put(work, first, 'new', { items: [{ ...incoming, unread: false }] })
    time.mockReturnValue(Date.now() + 1000)
    await storage.get(work, first, 'old')
    expect(await storage.recent(work, first)).toEqual([{ ...incoming, unread: false }])
    expect(await storage.recent(work, first)).toEqual([{ ...incoming, unread: false }])
  })

  it('不同账号和工作区共享一百二十八个磁盘缓存块预算，淘汰最久未使用的块', async () => {
    const { storage } = await setup([])
    const history = join(directory, 'cache', 'mail-v1')
    for (let i = 0; i < 128; i++)
      await storage.put(i % 2 ? work : other, i % 3 ? first : second, String(i), { items: [] })
    const clock = Math.floor(Date.now() / 1000) * 1000
    for (const file of await readdir(history))
      await utimes(join(history, file), clock / 1000, clock / 1000)
    const time = vi.spyOn(Date, 'now').mockReturnValue(clock + 1000)
    await storage.get(work, first, '1')
    await storage.put(work, first, 'overflow', { items: [] })
    expect(await readdir(history)).toHaveLength(128)
    expect(await storage.get(work, first, '1')).toBeDefined()
    expect(await storage.get(work, first, 'overflow')).toBeDefined()
    time.mockRestore()
  })

  it('密文总量不超过十六 MiB，单块超过一 MiB 时放弃持久化', async () => {
    const { storage } = await setup([])
    const items = [{ ...row(first, 'large', now), preview: 'a'.repeat(700000) }]
    for (let i = 0; i < 20; i++) await storage.put(work, first, String(i), { items })
    const history = join(directory, 'cache', 'mail-v1')
    const files = await readdir(history)
    const bytes = (await Promise.all(files.map((file) => stat(join(history, file))))).reduce(
      (sum, file) => sum + file.size,
      0,
    )
    expect(files.length).toBeLessThan(20)
    expect(bytes).toBeLessThanOrEqual(16 * 1024 * 1024)
    await storage.put(work, first, 'oversize', {
      items: [{ ...items[0], preview: 'a'.repeat(1024 * 1024) }],
    })
    expect(await storage.get(work, first, 'oversize')).toBeUndefined()
    expect(await readdir(history)).toHaveLength(files.length)
  })
})
