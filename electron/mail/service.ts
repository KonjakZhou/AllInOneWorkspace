import { randomUUID } from 'node:crypto'
import { MAIL_POLICY } from '../../src/shared/mail-policy'
import {
  mailKey,
  type MailAccount,
  type MailChange,
  type MailConnect,
  type MailCursor,
  type MailDetail,
  type MailFilter,
  type MailPage,
  type MailRef,
  type MailState,
  type MailSummary,
  type ConnectResult,
} from '../../src/shared/mail'
import { authorizeFeishu, createFeishuMail, renewFeishu } from './feishu'
import { authorizeGmail, gmail, renewGmail } from './gmail'
import { imap } from './imap'
import {
  MailError,
  type DesktopConfig,
  type Folder,
  type MailCredential,
  type MailRegistry,
  type Provider,
  type Range,
  type RangeResult,
} from './provider'
import { MailStorage } from './storage'

const DAY = 86400000
const FRESH = MAIL_POLICY.refreshMs
const PAGE = MAIL_POLICY.listPageSize
type Setup = NonNullable<MailState['setup']>
type Scope = {
  id: string
  lifetime: AbortController
  registry: Promise<MailRegistry>
  setup?: { abort: AbortController; status: Setup }
  accounts: Map<string, AbortController>
  imapOperations: Map<string, Promise<unknown>>
  issues: Map<string, MailError>
  cooldown: Map<string, number>
  reads: Map<string, number>
  mailboxRevisions: Map<string, string>
}
type Entry<T> = { value: T; fetched: number; used: number }
const secondary = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1)
export function newestFirst(a: MailSummary, b: MailSummary) {
  return b.time - a.time || secondary(mailKey(a), mailKey(b))
}
export function matchesFilter(message: MailSummary, filter: MailFilter) {
  if (filter.account && message.account !== filter.account) return false
  if (filter.folder === 'all') return message.inbox || message.sent
  if (filter.folder === 'sent') return message.sent
  return message.inbox && (filter.folder !== 'unread' || message.unread)
}
function mergeRows(target: Map<string, MailSummary>, items: MailSummary[]) {
  for (const item of items) {
    const key = mailKey(item)
    const existing = target.get(key)
    target.set(
      key,
      existing
        ? { ...item, inbox: item.inbox || existing.inbox, sent: item.sent || existing.sent }
        : item,
    )
  }
}
function safeError(error: unknown): MailError {
  return error instanceof MailError
    ? error
    : new MailError('邮箱服务返回了无法处理的数据，请重试。')
}

const feishu = createFeishuMail()
export type Providers = {
  feishu: typeof feishu
  gmail: typeof gmail
  imap: typeof imap
}
export class MailService {
  private scope?: Scope
  private tail: Promise<unknown> = Promise.resolve()
  private inflight = new Map<string, Promise<unknown>>()
  private heads = new Map<string, Entry<MailPage>>()
  private ranges = new Map<string, Entry<RangeResult> & { head: boolean }>()
  private bodies = new Map<string, Entry<MailDetail>>()
  private maintenance?: ReturnType<typeof setInterval>

  constructor(
    private storage: MailStorage,
    private open: (url: string) => Promise<void>,
    private changed: (workspace: string, change: MailChange) => void,
    private drivers: Providers = { feishu, gmail, imap },
    private now = Date.now,
  ) {}

  activate(id: string) {
    if (this.scope?.id === id) return
    this.deactivate()
    const scope: Scope = {
      id,
      lifetime: new AbortController(),
      registry: this.tail.then(() => this.storage.load(id)),
      accounts: new Map(),
      imapOperations: new Map(),
      issues: new Map(),
      cooldown: new Map(),
      reads: new Map(),
      mailboxRevisions: new Map(),
    }
    void scope.registry.catch(() => undefined)
    this.scope = scope
  }

  deactivate() {
    const scope = this.scope
    scope?.lifetime.abort('工作区已切换')
    if (scope)
      for (const id of scope.accounts.keys()) {
        this.drivers.feishu.clear(id)
        this.drivers.gmail.clear?.(id)
      }
    this.scope = undefined
    this.inflight.clear()
    this.heads.clear()
    this.ranges.clear()
    this.bodies.clear()
  }

  resume() {
    if (this.scope) this.changed(this.scope.id, { kind: 'resume' })
  }

  startMaintenance() {
    void this.storage.cleanup()
    this.maintenance = setInterval(() => {
      this.expire()
      void this.storage.cleanup()
    }, 60000)
    this.maintenance.unref()
  }

  dispose() {
    clearInterval(this.maintenance)
    this.deactivate()
  }

  private queue<T>(operation: () => Promise<T>) {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => undefined)
    return result
  }

  private context(workspace: string) {
    if (this.scope?.id !== workspace) throw new MailError('当前工作区已切换。')
    return this.scope
  }

  private async registry(scope: Scope) {
    scope.lifetime.signal.throwIfAborted()
    const value = await scope.registry
    scope.lifetime.signal.throwIfAborted()
    return value
  }

  private mutate(scope: Scope, change: (current: MailRegistry) => MailRegistry) {
    return this.queue(async () => {
      const next = change(await this.registry(scope))
      scope.lifetime.signal.throwIfAborted()
      await this.storage.save(scope.id, next)
      scope.registry = Promise.resolve(next)
      return next
    })
  }

  private accountController(scope: Scope, id: string) {
    let controller = scope.accounts.get(id)
    if (!controller) {
      controller = new AbortController()
      scope.accounts.set(id, controller)
    }
    return controller
  }

  private accountSignal(scope: Scope, id: string) {
    return AbortSignal.any([scope.lifetime.signal, this.accountController(scope, id).signal])
  }

  private dropCached(scope: Scope, id: string) {
    const prefix = scope.id + ':' + id + ':'
    for (const key of this.heads.keys()) {
      const { account } = JSON.parse(key) as MailFilter
      if (!account || account === id) this.heads.delete(key)
    }
    for (const key of this.ranges.keys()) if (key.startsWith(prefix)) this.ranges.delete(key)
    for (const key of this.bodies.keys()) if (key.startsWith(prefix)) this.bodies.delete(key)
    return this.storage.forget(scope.id, id)
  }

  private forget(scope: Scope, id: string) {
    for (const key of scope.reads.keys()) if (key.startsWith(id + ':')) scope.reads.delete(key)
    for (const key of scope.mailboxRevisions.keys())
      if (key.startsWith(id + ':')) scope.mailboxRevisions.delete(key)
    this.drivers.feishu.clear(id)
    this.drivers.gmail.clear?.(id)
    scope.issues.delete(id)
    scope.cooldown.delete(id)
    return this.dropCached(scope, id)
  }

  removeWorkspace(id: string) {
    if (this.scope?.id === id) this.deactivate()
    return this.queue(() => this.storage.removeWorkspace(id))
  }

  async state(workspace: string): Promise<MailState> {
    const scope = this.context(workspace)
    const registry = await this.registry(scope)
    const accounts: MailAccount[] = registry.accounts.map((credential) => {
      const { id, email, provider } = credential
      const issue = scope.issues.get(id)
      return {
        id,
        email,
        provider,
        feishuMethod:
          provider === 'feishu' ? ('password' in credential ? 'imap' : 'oauth') : undefined,
        issue: issue?.message,
        reauthorize: issue?.kind === 'auth',
      }
    })
    return { accounts, gmailConfigured: !!registry.google, setup: scope.setup?.status ?? null }
  }

  async importGoogle(workspace: string, google: DesktopConfig) {
    const scope = this.context(workspace)
    await this.mutate(scope, (current) => ({ ...current, google }))
    this.changed(workspace, { kind: 'accounts' })
  }

  async connect(workspace: string, input: MailConnect): Promise<ConnectResult> {
    const scope = this.context(workspace)
    if (scope.setup) throw new MailError('请先完成或取消正在进行的邮箱授权。')
    const setup = { abort: new AbortController(), status: { provider: input.provider } as Setup }
    scope.setup = setup
    const signal = AbortSignal.any([setup.abort.signal, scope.lifetime.signal])
    try {
      const current = await this.registry(scope)
      const previous = input.reconnect
        ? current.accounts.find(({ id }) => id === input.reconnect)
        : undefined
      if (input.reconnect && previous?.provider !== input.provider)
        throw new MailError('重新连接的邮箱已不可用。')
      this.changed(workspace, { kind: 'accounts' })
      const id = previous?.id ?? randomUUID()
      let credential: MailCredential
      if ('password' in input) {
        if (previous && previous.email.toLowerCase() !== input.email.toLowerCase())
          throw new MailError('请使用原邮箱 ' + previous.email + ' 重新连接。')
        const choice = await this.drivers.imap.discoverSent(
          input,
          signal,
          input.sentPath ?? (previous && 'password' in previous ? previous.sentPath : undefined),
        )
        if (choice.sentFolders) return { sentFolders: choice.sentFolders }
        credential = {
          id,
          provider: input.provider,
          email: input.email,
          password: input.password,
          sentPath: choice.path,
        }
      } else if (input.provider === 'gmail') {
        const config =
          current.google ?? (previous?.provider === 'gmail' ? previous.config : undefined)
        if (!config) throw new MailError('请先导入 Google 桌面 OAuth 配置。')
        const auth = await authorizeGmail(config, this.open, signal, previous?.email)
        credential = { ...auth, id, provider: input.provider, config }
      } else {
        if (!!input.appId !== !!input.appSecret)
          throw new MailError('请填写 App ID 和 App Secret。')
        const config =
          input.appId && input.appSecret
            ? { appId: input.appId, appSecret: input.appSecret }
            : undefined
        const auth = await authorizeFeishu(
          config,
          this.open,
          ({ userCode, url }) => {
            if (signal.aborted) return
            setup.status = { provider: 'feishu', code: userCode, url }
            this.changed(workspace, { kind: 'accounts' })
          },
          signal,
        )
        credential = { ...auth, id, provider: input.provider }
      }
      signal.throwIfAborted()
      const email = credential.email.toLowerCase()
      if (previous && previous.email.toLowerCase() !== email)
        throw new MailError('授权返回了其他邮箱，请选择 ' + previous.email + '。')
      await this.mutate(scope, (record) => {
        signal.throwIfAborted()
        if (previous && !record.accounts.some(({ id }) => id === previous.id))
          throw new MailError('邮箱已断开。')
        if (
          record.accounts.some(
            (entry) =>
              entry.id !== id &&
              entry.provider === input.provider &&
              entry.email.toLowerCase() === email,
          )
        )
          throw new MailError('此邮箱已连接，可在账号列表中重新授权。')
        return {
          ...record,
          accounts: [...record.accounts.filter((entry) => entry.id !== id), credential],
        }
      })
      scope.accounts.get(id)?.abort('邮箱已重新授权')
      scope.accounts.delete(id)
      await this.forget(scope, id)
      return { connected: true }
    } catch (error) {
      if (signal.aborted) throw new MailError('邮箱授权已取消。')
      throw safeError(error)
    } finally {
      if (scope.setup === setup) scope.setup = undefined
      if (this.scope === scope) this.changed(workspace, { kind: 'accounts' })
    }
  }

  cancel(workspace: string) {
    this.context(workspace).setup?.abort.abort('邮箱授权已取消')
  }

  async disconnect(workspace: string, id: string) {
    const scope = this.context(workspace)
    await this.mutate(scope, (current) => ({
      ...current,
      accounts: current.accounts.filter((entry) => entry.id !== id),
    }))
    scope.accounts.get(id)?.abort('邮箱已断开')
    scope.accounts.delete(id)
    await this.forget(scope, id)
    this.changed(workspace, { kind: 'accounts' })
  }

  private share<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key)
    if (existing) return existing as Promise<T>
    const task = run().finally(() => {
      if (this.inflight.get(key) === task) this.inflight.delete(key)
    })
    this.inflight.set(key, task)
    return task
  }

  private async renew(scope: Scope, id: string, signal: AbortSignal, failedAccess?: string) {
    return this.share(scope.id + ':' + id + ':renew', async () => {
      const credential = (await this.registry(scope)).accounts.find((entry) => entry.id === id)
      if (!credential) throw new MailError('此邮箱已断开。')
      if (
        'password' in credential ||
        (credential.token.expires > this.now() + 60000 &&
          (!failedAccess || failedAccess !== credential.token.access))
      )
        return credential
      if (credential.token.refreshExpires && this.now() >= credential.token.refreshExpires)
        throw new MailError('邮箱授权已过期，请重新连接。', 'auth')
      const token = await (credential.provider === 'gmail'
        ? renewGmail(credential, signal)
        : renewFeishu(credential, signal))
      signal.throwIfAborted()
      const next = { ...credential, token }
      await this.mutate(scope, (current) => {
        signal.throwIfAborted()
        return {
          ...current,
          accounts: current.accounts.map((entry) => (entry === credential ? next : entry)),
        }
      })
      return next
    })
  }

  private async remote<T>(
    scope: Scope,
    id: string,
    run: (
      driver: Provider<MailCredential>,
      credential: MailCredential,
      signal: AbortSignal,
    ) => Promise<T>,
  ) {
    const signal = this.accountSignal(scope, id)
    const credential = (await this.registry(scope)).accounts.find((account) => account.id === id)
    if (!credential) throw new MailError('此邮箱已断开。')
    if (!('password' in credential)) return this.runRemote(scope, id, signal, run)
    // Inbox, sent, body and writes share a mailbox login budget, even across open views.
    const previous = scope.imapOperations.get(id)
    const task = (previous?.catch(() => undefined) ?? Promise.resolve()).then(() =>
      this.runRemote(scope, id, signal, run),
    )
    scope.imapOperations.set(id, task)
    try {
      return await task
    } finally {
      if (scope.imapOperations.get(id) === task) scope.imapOperations.delete(id)
    }
  }

  private async runRemote<T>(
    scope: Scope,
    id: string,
    signal: AbortSignal,
    run: (
      driver: Provider<MailCredential>,
      credential: MailCredential,
      signal: AbortSignal,
    ) => Promise<T>,
  ) {
    signal.throwIfAborted()
    const previous = scope.issues.get(id)
    if (previous && (previous.kind === 'auth' || (scope.cooldown.get(id) ?? 0) > this.now()))
      throw previous
    const invoke = (credential: MailCredential) =>
      run(
        ('password' in credential
          ? this.drivers.imap
          : this.drivers[credential.provider]) as Provider<MailCredential>,
        credential,
        signal,
      )
    try {
      const credential = await this.renew(scope, id, signal)
      let value: T
      try {
        value = await invoke(credential)
      } catch (reason) {
        if (safeError(reason).kind !== 'auth' || 'password' in credential) throw reason
        value = await invoke(await this.renew(scope, id, signal, credential.token.access))
      }
      signal.throwIfAborted()
      if (scope.issues.delete(id)) this.changed(scope.id, { kind: 'status' })
      scope.cooldown.delete(id)
      return value
    } catch (reason) {
      signal.throwIfAborted()
      const issue = safeError(reason)
      scope.issues.set(id, issue)
      if (previous?.message !== issue.message || previous.kind !== issue.kind)
        this.changed(scope.id, { kind: 'status' })
      if (issue.kind === 'quota' || issue.kind === 'network')
        scope.cooldown.set(id, this.now() + issue.retryMs)
      throw issue
    }
  }

  private expire() {
    const now = this.now()
    for (const [key, entry] of this.heads)
      if (now - entry.used >= MAIL_POLICY.memoryIdleMs) this.heads.delete(key)
    for (const [key, entry] of this.ranges)
      if (now - entry.used >= MAIL_POLICY.memoryIdleMs) this.ranges.delete(key)
    for (const [key, entry] of this.bodies)
      if (now - entry.used >= MAIL_POLICY.memoryIdleMs) this.bodies.delete(key)
    this.drivers.feishu.expire?.()
    this.drivers.gmail.expire?.()
    for (const [key, until] of this.scope?.reads ?? [])
      if (until < now) this.scope?.reads.delete(key)
  }

  private readState(scope: Scope, message: MailSummary) {
    return (scope.reads.get(mailKey(message)) ?? 0) > this.now()
      ? { ...message, unread: false }
      : message
  }

  async cached(workspace: string, filter: MailFilter, disk = false) {
    const scope = this.context(workspace)
    this.expire()
    const accounts = (await this.registry(scope)).accounts.filter(
      ({ id }) => !filter.account || id === filter.account,
    )
    const items = await Promise.all(
      accounts.map(async ({ id }) => {
        const prefix = workspace + ':' + id + ':range:'
        const memory = [...this.ranges]
          .filter(([key]) => key.startsWith(prefix))
          .map(([, value]) => value)
          .sort((a, b) => a.fetched - b.fetched)
        const byKey = new Map<string, MailSummary>()
        for (const entry of memory) {
          mergeRows(byKey, entry.value.items)
          if (entry.value.items.some((item) => matchesFilter(item, filter))) entry.used = this.now()
        }
        const usable = [...byKey.values()].filter((item) =>
          matchesFilter(this.readState(scope, item), filter),
        )
        if (disk && usable.length < PAGE) {
          const local = await this.storage.recent(workspace, id)
          for (const item of local ?? []) {
            const key = mailKey(item)
            if (!byKey.has(key)) byKey.set(key, item)
          }
        }
        return [...byKey.values()]
      }),
    )
    const live = new Set((await this.registry(scope)).accounts.map(({ id }) => id))
    return items
      .flat()
      .map((item) => this.readState(scope, item))
      .filter((item) => live.has(item.account) && matchesFilter(item, filter))
      .sort(newestFirst)
      .slice(0, PAGE)
  }

  private loadRange(
    scope: Scope,
    credential: MailCredential,
    folder: Folder,
    range: Range,
    revalidate: boolean,
  ): Promise<RangeResult> {
    const revisionKey = credential.id + ':' + folder
    const rangeKey = folder + ':' + range.start + ':' + range.end
    const key = scope.id + ':' + credential.id + ':range:' + rangeKey
    const now = this.now()
    const head = range.end > now - FRESH
    const entry = this.ranges.get(key)
    if (
      entry &&
      ((!head && !revalidate) ||
        now - entry.fetched < (revalidate ? MAIL_POLICY.manualRefreshMs : FRESH))
    ) {
      entry.used = now
      return Promise.resolve(entry.value)
    }
    const signal = this.accountSignal(scope, credential.id)
    return this.share(key, async () => {
      const persistent = !head
      const stored =
        persistent && !revalidate
          ? await this.storage.get(scope.id, credential.id, rangeKey)
          : undefined
      const revision = scope.mailboxRevisions.get(revisionKey)
      const cached = !revision || stored?.revision === revision ? stored : undefined
      signal.throwIfAborted()
      const previews =
        'password' in credential
          ? new Map(
              [...this.ranges]
                .filter(([name]) =>
                  name.startsWith(scope.id + ':' + credential.id + ':range:' + folder + ':'),
                )
                .flatMap(([, entry]) =>
                  entry.value.items.map(({ id, preview }) => [id, preview] as const),
                ),
            )
          : undefined
      const result: RangeResult =
        cached ??
        (await this.remote(scope, credential.id, (driver, account, signal) =>
          driver.range(account, folder, range, signal, previews),
        ))
      signal.throwIfAborted()
      if (result.revision) {
        const latest = scope.mailboxRevisions.get(revisionKey)
        if (!cached && latest && latest !== result.revision)
          await this.dropCached(scope, credential.id)
        scope.mailboxRevisions.set(revisionKey, result.revision)
      }
      signal.throwIfAborted()
      const normalized = {
        ...result,
        items: result.items.map((item) => this.readState(scope, item)),
      }
      if (persistent && !cached && !normalized.split)
        void this.storage.put(scope.id, credential.id, rangeKey, normalized)
      this.ranges.set(key, { value: normalized, fetched: this.now(), used: this.now(), head })
      if (normalized.items.length) this.changed(scope.id, { kind: 'cache', account: credential.id })
      const related = [...this.ranges].filter(
        ([name, item]) =>
          name.startsWith(scope.id + ':' + credential.id + ':range:' + folder + ':') &&
          item.head === head,
      )
      related.sort((a, b) => b[1].used - a[1].used)
      for (const [name] of related.slice(
        head ? MAIL_POLICY.latestRangesPerFolder : MAIL_POLICY.historyRangesPerFolder,
      ))
        this.ranges.delete(name)
      return normalized
    })
  }

  async list(
    workspace: string,
    filter: MailFilter,
    cursor?: MailCursor,
    refresh = false,
  ): Promise<MailPage> {
    const scope = this.context(workspace)
    const registry = await this.registry(scope)
    this.expire()
    const filterKey = JSON.stringify(filter)
    const head = this.heads.get(filterKey)
    if (
      !cursor &&
      head &&
      this.now() - head.fetched < (refresh ? MAIL_POLICY.manualRefreshMs : FRESH)
    ) {
      head.used = this.now()
      return head.value
    }
    return this.share(
      workspace + ':list:' + filterKey + ':' + JSON.stringify(cursor ?? null),
      async () => {
        const accountList = registry.accounts.filter(
          ({ id }) => !filter.account || id === filter.account,
        )
        if (!accountList.length) return { items: [], next: null, issues: [] }
        const folders: Folder[] =
          filter.folder === 'all'
            ? ['inbox', 'sent']
            : [filter.folder === 'sent' ? 'sent' : 'inbox']
        const boundary = cursor ?? { time: this.now() + 1, key: null }
        const candidates = new Map<string, MailSummary>()
        const issues = new Map<string, string>()
        const finished = new Set<string>()
        let end =
          cursor?.band?.end ??
          (cursor && cursor.key === null
            ? cursor.time
            : (Math.floor(boundary.time / DAY) + 1) * DAY)
        let width = cursor?.band ? end - cursor.band.start : DAY
        const bands: Range[] = []
        const streamCount = accountList.length * folders.length
        for (let step = 0; end > 0 && step < 6; step++) {
          const collected = candidates.size
          let start = Math.max(0, end - width)
          for (;;) {
            const pending = accountList
              .flatMap((account) => folders.map((folder) => ({ account, folder })))
              .filter(({ account, folder }) => !finished.has(account.id + ':' + folder))
            const settled = await Promise.allSettled(
              pending.map(({ account, folder }) =>
                this.loadRange(
                  scope,
                  account,
                  folder,
                  { start, end },
                  !cursor && refresh && step === 0,
                ),
              ),
            )
            scope.lifetime.signal.throwIfAborted()
            for (const [index, result] of settled.entries()) {
              if (result.status !== 'rejected') continue
              const { account, folder } = pending[index]
              finished.add(account.id + ':' + folder)
              issues.set(account.id, safeError(result.reason).message)
            }
            if (settled.some((result) => result.status === 'fulfilled' && result.value.split)) {
              const mid = Math.floor((start + end) / 2)
              if (mid <= start || mid >= end) throw new MailError('邮箱返回了无效的时间范围。')
              start = mid
              continue
            }
            bands.push({ start, end })
            for (const [index, result] of settled.entries()) {
              const { account, folder } = pending[index]
              if (result.status === 'rejected') continue
              const filtered = result.value.items
                .map((row) => this.readState(scope, row))
                .filter(
                  (row) =>
                    matchesFilter(row, filter) &&
                    (row.time < boundary.time ||
                      (row.time === boundary.time &&
                        boundary.key !== null &&
                        secondary(mailKey(row), boundary.key) > 0)),
                )
              mergeRows(candidates, filtered)
              if (result.value.exhausted) finished.add(account.id + ':' + folder)
            }
            break
          }
          width = candidates.size > collected ? end - start : Math.min(width * 4, 300 * DAY)
          end = start
          if (candidates.size >= PAGE || finished.size === streamCount) break
        }
        const live = new Set((await this.registry(scope)).accounts.map(({ id }) => id))
        for (const id of issues.keys()) if (!live.has(id)) issues.delete(id)
        const done = end === 0 || finished.size === streamCount
        if (!cursor) {
          const fallback = await Promise.all(
            [...issues.keys()].map((account) =>
              this.cached(workspace, { ...filter, account }, true),
            ),
          )
          for (const item of fallback.flat()) {
            if (
              (done || item.time >= end) &&
              item.time < boundary.time &&
              !candidates.has(mailKey(item))
            )
              candidates.set(mailKey(item), item)
          }
        }
        const rows = [...candidates.values()]
          .filter(({ account }) => live.has(account))
          .sort(newestFirst)
        const items = rows.slice(0, PAGE)
        const last = items.at(-1)
        const next =
          last && rows.length > PAGE
            ? {
                time: last.time,
                key: mailKey(last),
                band: bands.find(({ start, end }) => last.time >= start && last.time < end),
              }
            : done
              ? null
              : { time: end, key: null }
        const value = {
          items,
          next,
          issues: [...issues].map(([account, message]) => ({ account, message })),
        }
        if (!cursor && !issues.size)
          this.heads.set(filterKey, { value, fetched: this.now(), used: this.now() })
        return value
      },
    )
  }

  async detail(workspace: string, ref: MailRef) {
    const scope = this.context(workspace)
    const key = workspace + ':' + mailKey(ref)
    this.expire()
    const hit = this.bodies.get(key)
    if (hit) {
      hit.used = this.now()
      return { ...hit.value, message: this.readState(scope, hit.value.message) }
    }
    return this.share(key + ':body', async () => {
      const value = await this.remote(scope, ref.account, (driver, credential, signal) =>
        driver.detail(credential, ref.id, signal),
      )
      const message = this.readState(scope, value.message)
      this.bodies.set(key, { value: { ...value, message }, used: this.now(), fetched: this.now() })
      if (this.bodies.size > MAIL_POLICY.bodyEntries) {
        const oldest = [...this.bodies].sort((a, b) => a[1].used - b[1].used)[0]
        this.bodies.delete(oldest[0])
      }
      return { ...value, message }
    })
  }

  async markRead(workspace: string, ref: MailRef) {
    const scope = this.context(workspace)
    return this.share(workspace + ':' + mailKey(ref) + ':read', async () => {
      const signal = this.accountSignal(scope, ref.account)
      await this.remote(scope, ref.account, (driver, credential, signal) =>
        driver.read(credential, ref.id, signal),
      )
      signal.throwIfAborted()
      const key = mailKey(ref)
      scope.reads.set(key, this.now() + FRESH)
      for (const [filterKey, entry] of this.heads) {
        if (!entry.value.items.some((item) => mailKey(item) === key)) continue
        const { folder } = JSON.parse(filterKey) as MailFilter
        entry.value = {
          ...entry.value,
          items: entry.value.items.flatMap((item) =>
            mailKey(item) !== key
              ? [item]
              : folder === 'unread'
                ? []
                : [{ ...item, unread: false }],
          ),
        }
      }
      const body = this.bodies.get(workspace + ':' + key)
      if (body) body.value = { ...body.value, message: { ...body.value.message, unread: false } }
      for (const entry of this.ranges.values())
        entry.value.items = entry.value.items.map((item) =>
          mailKey(item) === key ? { ...item, unread: false } : item,
        )
      void this.storage.markRead(workspace, ref)
      this.changed(workspace, { kind: 'read', message: ref })
    })
  }

  private mailboxUrl(credential: MailCredential) {
    if (credential.provider === 'gmail')
      return 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(credential.email)
    return credential.provider === 'feishu' ? 'https://web.feishu.cn/mail' : 'https://mail.163.com/'
  }

  async openMailbox(workspace: string, id: string) {
    const scope = this.context(workspace)
    const credential = (await this.registry(scope)).accounts.find((entry) => entry.id === id)
    if (!credential) throw new MailError('此邮箱已断开。')
    await this.open(this.mailboxUrl(credential))
  }

  async openReply(workspace: string, ref: MailRef) {
    const scope = this.context(workspace)
    const signal = this.accountSignal(scope, ref.account)
    const credential = (await this.registry(scope)).accounts.find(
      (entry) => entry.id === ref.account,
    )
    if (!credential) throw new MailError('此邮箱已断开。')
    const detail = await this.detail(workspace, ref)
    signal.throwIfAborted()
    const url = this.mailboxUrl(credential)
    if (credential.provider === 'gmail' && detail.gmail?.threadId) {
      await this.open(url + '#all/' + encodeURIComponent(detail.gmail.threadId))
      return { kind: 'thread' } as const
    }
    if (credential.provider === 'gmail' && detail.gmail?.messageId) {
      await this.open(
        url + '#search/' + encodeURIComponent('rfc822msgid:' + detail.gmail.messageId),
      )
      return { kind: 'search' } as const
    }
    const keyword = detail.message.subject.trim() || detail.message.from[0]?.email.trim() || ''
    await this.open(url)
    return { kind: 'mailbox', keyword } as const
  }
}
