import { randomUUID } from 'node:crypto'
import {
  calendarRange,
  feishuConfigSchema,
  type CalendarAgenda,
  type FeishuConfig,
  type FeishuConnection,
  type FeishuIssue,
} from '../../src/shared/feishu'
import { idSchema } from '../../src/shared/model'
import type { CredentialRecord, CredentialVault, Authorization } from './vault'
import type { FeishuClientAPI } from './client'
import type { OAuthFlow } from './oauth'
import { FeishuError, issueFrom } from './errors'
import type { OneClickFlow, SetupPrompt } from './one-click'

type Pending = {
  accountId: string
  id: string
  generation: number
  abort?: AbortController
  prompt?: SetupPrompt
  verifying?: boolean
}

type Slot = {
  record?: CredentialRecord
  loaded: boolean
  load?: Promise<void>
  generation: number
  abort: AbortController
  tail: Promise<unknown>
  agenda?: CalendarAgenda
  fetching?: Promise<CalendarAgenda>
  refreshing?: Promise<Authorization>
  issue?: FeishuIssue
  message?: string
  retryAt: number
  cleanupFailed?: boolean
  needsPersist?: boolean
}
export class FeishuService {
  private slots = new Map<string, Slot>()
  private pending?: Pending
  constructor(
    private vault: CredentialVault,
    private client: FeishuClientAPI,
    private oauth: OAuthFlow,
    private exists: (id: string) => Promise<boolean>,
    private changed: (id: string) => void,
    private now = Date.now,
    private oneClick?: OneClickFlow,
  ) {}
  private slot(id: string): Slot {
    idSchema.parse(id)
    let slot = this.slots.get(id)
    if (!slot) {
      slot = {
        loaded: false,
        generation: 0,
        abort: new AbortController(),
        tail: Promise.resolve(),
        retryAt: 0,
      }
      this.slots.set(id, slot)
    }
    return slot
  }
  private async get(id: string): Promise<Slot> {
    if (!(await this.exists(id))) throw new Error('本地账号不存在')
    const slot = this.slot(id)
    if (!slot.loaded) {
      const generation = slot.generation
      slot.load ??= this.queue(slot, () => this.vault.read(id))
        .then((record) => {
          if (slot.generation === generation) {
            slot.record = record
            slot.loaded = true
          }
        })
        .finally(() => {
          slot.load = undefined
        })
      await slot.load
    }
    return slot
  }
  private queue<T>(slot: Slot, operation: () => Promise<T>): Promise<T> {
    const next = slot.tail.then(operation)
    slot.tail = next.catch(() => undefined)
    return next
  }
  private connection(id: string, slot: Slot): FeishuConnection {
    const auth = slot.record?.authorization
    const status =
      this.pending?.accountId === id
        ? 'connecting'
        : slot.issue?.kind === 'authorization'
          ? 'reauth_required'
          : slot.issue?.kind === 'permission'
            ? 'permission_denied'
            : auth
              ? 'connected'
              : slot.record
                ? 'not_connected'
                : 'unconfigured'
    return {
      accountId: id,
      appId: slot.record?.configuration.appId ?? null,
      configured: !!slot.record,
      status,
      identity: auth?.identity ?? null,
      message: slot.message ?? slot.issue?.message ?? null,
      revision: slot.generation,
      ...(this.pending?.accountId === id && (this.pending.prompt || this.pending.verifying)
        ? {
            setup: this.pending.verifying
              ? { phase: 'verifying' as const }
              : {
                  phase: this.pending.prompt!.phase,
                  userCode: this.pending.prompt!.userCode,
                  expiresAt: this.pending.prompt!.expiresAt,
                },
          }
        : {}),
    }
  }
  async getConnection(id: string) {
    return this.connection(id, await this.get(id))
  }
  async saveConfig(id: string, input: FeishuConfig) {
    const config = feishuConfigSchema.parse(input),
      slot = await this.get(id)
    const generation = slot.generation
    if (slot.cleanupFailed) throw new Error('请先重试断开连接，完成旧凭证清理。')
    if (this.pending?.accountId === id) throw new Error('请先完成或取消当前授权，再修改应用配置。')
    await this.queue(slot, async () => {
      if (generation !== slot.generation) throw new Error('连接已变更，请重新操作。')
      const record: CredentialRecord = {
        schemaVersion: 1,
        configuration: config,
        authorization: slot.record?.authorization,
      }
      await this.vault.write(id, record)
      if (generation !== slot.generation) return
      slot.record = record
      slot.needsPersist = false
      slot.message = '应用配置已保存，点击授权连接飞书。'
    })
    this.changed(id)
    return this.connection(id, slot)
  }
  private async commitConnection(
    id: string,
    slot: Slot,
    pending: Pending,
    config: FeishuConfig,
    token: Authorization['token'],
    signal: AbortSignal,
  ) {
    const valid = () => this.pending === pending && slot.generation === pending.generation
    const identity = await this.client.identity(token.accessToken, signal)
    const calendarId = await this.client.primary(token.accessToken, signal)
    const range = calendarRange(new Date(this.now()))
    // Verify event read permission before replacing any existing connection.
    const events = await this.client.events(token.accessToken, calendarId, range, signal)
    if (!valid() || signal.aborted || !(await this.exists(id)))
      throw new Error('此授权会话已取消。')
    await this.queue(slot, async () => {
      if (!valid() || signal.aborted) throw new Error('此授权会话已取消。')
      const record: CredentialRecord = {
        schemaVersion: 1,
        configuration: config,
        ...(slot.record?.authMode ? { authMode: slot.record.authMode } : {}),
        authorization: { application: config, token, identity, calendarId },
      }
      await this.vault.write(id, record)
      if (!valid() || signal.aborted) {
        if (slot.record) await this.vault.write(id, slot.record)
        else await this.vault.remove(id)
        return
      }
      this.invalidate(slot)
      slot.record = record
      slot.issue = undefined
      slot.message = undefined
      this.pending = undefined
      slot.agenda = {
        accountId: id,
        revision: slot.generation,
        connection: this.connection(id, slot),
        events,
        updatedAt: this.now(),
        rangeStart: range.start,
        rangeEnd: range.end,
        stale: false,
        error: null,
      }
    })
    this.changed(id)
  }
  async connect(id: string) {
    const slot = await this.get(id)
    return slot.record ? this.authorize(id) : this.startOneClick(id, slot)
  }
  async reopenAuthorization(id: string) {
    const pending = this.pending
    if (pending?.accountId !== id || !pending.prompt || !this.oneClick)
      throw new Error('没有待确认的飞书连接，请重新发起。')
    await this.oneClick.reopen(pending.prompt.url)
  }
  private startOneClick(id: string, slot: Slot): FeishuConnection {
    if (!this.oneClick) throw new Error('快捷连接服务不可用，请使用高级设置。')
    if (this.pending) throw new Error('已有飞书连接正在进行，请先完成或取消。')
    if (slot.cleanupFailed) throw new Error('请先重试断开连接，完成旧凭证清理。')
    const flow = this.oneClick
    const pending: Pending = {
      accountId: id,
      id: randomUUID(),
      generation: slot.generation,
      abort: new AbortController(),
    }
    this.pending = pending
    slot.message = '正在准备飞书连接…'
    this.changed(id)
    const signal = pending.abort!.signal
    const valid = () =>
      this.pending === pending && slot.generation === pending.generation && !signal.aborted
    const prompt = (value: SetupPrompt) => {
      if (!valid()) return
      pending.prompt = value
      slot.message =
        value.phase === 'creating_app'
          ? '第 1 步：请在飞书页面确认创建个人应用，无需复制任何凭证。'
          : '第 2 步：请在飞书页面授权读取日历。完成后自动返回已连接状态。'
      this.changed(id)
    }
    const run = async () => {
      let config = slot.record?.configuration
      if (!config) {
        config = await flow.register(prompt, signal)
        if (!valid() || !(await this.exists(id))) return
        const configuration = config
        await this.queue(slot, async () => {
          if (!valid()) return
          const record: CredentialRecord = { schemaVersion: 1, configuration, authMode: 'device' }
          // Retain successfully created app credentials if the following user grant is cancelled.
          // Retrying then reuses the app instead of creating another remote application.
          slot.record = record
          slot.loaded = true
          slot.needsPersist = true
          await this.vault.write(id, record)
          if (slot.generation === pending.generation) slot.needsPersist = false
        })
      }
      if (!valid()) return
      if (slot.needsPersist)
        await this.queue(slot, async () => {
          if (!valid() || !slot.record) return
          await this.vault.write(id, slot.record)
          if (slot.generation === pending.generation) slot.needsPersist = false
        })
      if (!valid()) return
      const token = await flow.authorize(config, prompt, signal)
      if (!valid()) return
      pending.verifying = true
      slot.message = '正在验证飞书身份与主日历读取权限…'
      this.changed(id)
      await this.commitConnection(id, slot, pending, config, token, signal)
    }
    void run().catch((error) => {
      if (!valid()) return
      this.pending = undefined
      slot.message = issueFrom(error).message
      this.changed(id)
    })
    return this.connection(id, slot)
  }
  async authorize(id: string): Promise<FeishuConnection> {
    const slot = await this.get(id)
    if (slot.record?.authMode === 'device') return this.startOneClick(id, slot)
    if (this.pending) throw new Error('已有飞书授权正在进行，请先完成或取消。')
    if (!slot.record) throw new Error('请先保存飞书应用配置。')
    const config = { ...slot.record.configuration }
    const pending = { accountId: id, id: randomUUID(), generation: slot.generation }
    this.pending = pending
    slot.message = undefined
    this.changed(id)
    try {
      await this.oauth.start(id, config.appId, {
        complete: async (code, verifier, signal) => {
          const token = await this.client.exchange(config, code, verifier, signal)
          await this.commitConnection(id, slot, pending, config, token, signal)
        },
        failed: (message) => {
          if (this.pending === pending) {
            this.pending = undefined
            slot.message = message
            this.changed(id)
          }
        },
      })
    } catch (error) {
      if (this.pending === pending) this.pending = undefined
      slot.message = error instanceof Error ? error.message : '授权失败，请重试。'
      this.changed(id)
      throw error
    }
    return this.connection(id, slot)
  }
  cancelAuthorization(id: string) {
    if (this.pending?.accountId !== id) return
    this.pending.abort?.abort()
    this.oauth.cancel(id)
    this.pending = undefined
    this.slot(id).message = '已取消授权，原有连接保持不变。'
    this.changed(id)
  }
  private invalidate(slot: Slot) {
    slot.generation++
    slot.abort.abort()
    slot.abort = new AbortController()
    slot.agenda = undefined
    slot.fetching = undefined
    slot.refreshing = undefined
    slot.retryAt = 0
    slot.needsPersist = false
  }
  async disconnect(id: string) {
    if (!(await this.exists(id))) throw new Error('本地账号不存在')
    await this.removeAccount(id)
  }
  async removeAccount(id: string) {
    const slot = this.slot(id)
    this.cancelAuthorization(id)
    this.invalidate(slot)
    // Invalidate synchronously, then serialize deletion after any in-flight credential commit.
    slot.record = undefined
    slot.loaded = true
    slot.issue = undefined
    slot.message = undefined
    this.changed(id)
    await this.queue(slot, async () => {
      try {
        await this.vault.remove(id)
        slot.cleanupFailed = false
      } catch (error) {
        slot.cleanupFailed = true
        slot.message = issueFrom(error).message
        this.changed(id)
        throw error
      }
    })
  }
  private async token(
    id: string,
    slot: Slot,
    generation: number,
    force = false,
  ): Promise<Authorization> {
    if (slot.needsPersist)
      await this.queue(slot, async () => {
        if (generation !== slot.generation || !slot.record) throw new Error('连接已变更')
        await this.vault.write(id, slot.record)
        slot.needsPersist = false
      })
    const auth = slot.record?.authorization
    if (!auth) throw new FeishuError('authorization', '请先连接飞书账号。')
    if (!force && auth.token.expiresAt > this.now() + 60000) return auth
    if (slot.refreshing) return slot.refreshing
    const work = this.queue(slot, async () => {
      if (generation !== slot.generation) throw new Error('连接已变更')
      const current = slot.record!.authorization!
      if (current.token.refreshExpiresAt <= this.now())
        throw new FeishuError('authorization', '飞书授权已过期，请重新授权。')
      const token = await this.client.refresh(
        current.application,
        current.token.refreshToken,
        slot.abort.signal,
      )
      if (generation !== slot.generation) throw new Error('连接已变更')
      const authorization = { ...current, token }
      const record = { ...slot.record!, authorization }
      // Keep the newly rotated token in memory even if disk writing fails; never reuse the old token.
      slot.record = record
      slot.needsPersist = true
      await this.vault.write(id, record)
      slot.needsPersist = false
      return authorization
    })
    slot.refreshing = work
    try {
      return await work
    } finally {
      if (slot.refreshing === work) slot.refreshing = undefined
    }
  }
  private empty(id: string, slot: Slot, error: FeishuIssue | null = null): CalendarAgenda {
    const range = calendarRange(new Date(this.now()))
    return {
      accountId: id,
      revision: slot.generation,
      connection: this.connection(id, slot),
      events: [],
      updatedAt: null,
      rangeStart: range.start,
      rangeEnd: range.end,
      stale: !!error,
      error,
    }
  }
  async getAgenda(id: string, force = false): Promise<CalendarAgenda> {
    const slot = await this.get(id),
      range = calendarRange(new Date(this.now()))
    if (
      !slot.record?.authorization ||
      slot.issue?.kind === 'authorization' ||
      slot.issue?.kind === 'permission'
    )
      return this.empty(id, slot, slot.issue ?? null)
    if (slot.fetching) return slot.fetching
    const sameDay = slot.agenda?.rangeStart === range.start && slot.agenda?.rangeEnd === range.end
    if (
      slot.agenda &&
      sameDay &&
      (slot.retryAt > this.now() ||
        (!force && !slot.agenda.stale && this.now() - slot.agenda.updatedAt! < 300000))
    )
      return { ...slot.agenda, connection: this.connection(id, slot) }
    const generation = slot.generation
    const signal = slot.abort.signal
    const work = (async (): Promise<CalendarAgenda> => {
      try {
        let auth = await this.token(id, slot, generation)
        let events
        try {
          events = await this.client.events(auth.token.accessToken, auth.calendarId, range, signal)
        } catch (error) {
          if (!(error instanceof FeishuError) || error.kind !== 'authorization') throw error
          auth = await this.token(id, slot, generation, true)
          events = await this.client.events(auth.token.accessToken, auth.calendarId, range, signal)
        }
        if (generation !== slot.generation || signal.aborted) return this.empty(id, slot)
        slot.issue = undefined
        slot.retryAt = 0
        slot.agenda = {
          accountId: id,
          revision: generation,
          connection: this.connection(id, slot),
          events,
          updatedAt: this.now(),
          rangeStart: range.start,
          rangeEnd: range.end,
          stale: false,
          error: null,
        }
      } catch (error) {
        if (generation !== slot.generation || signal.aborted) return this.empty(id, slot)
        const issue = issueFrom(error)
        if (issue.kind === 'authorization' || issue.kind === 'permission') {
          slot.issue = issue
          slot.agenda = this.empty(id, slot, issue)
        } else {
          slot.retryAt = this.now() + ((error instanceof FeishuError && error.retryAfter) || 30000)
          slot.agenda = {
            ...(sameDay && slot.agenda ? slot.agenda : this.empty(id, slot)),
            connection: this.connection(id, slot),
            stale: true,
            error: issue,
          }
        }
      }
      this.changed(id)
      return slot.agenda!
    })()
    slot.fetching = work
    try {
      return await work
    } finally {
      if (slot.fetching === work) slot.fetching = undefined
    }
  }
  resume() {
    for (const [id, slot] of this.slots) {
      if (slot.agenda) slot.agenda = { ...slot.agenda, stale: true }
      this.changed(id)
    }
  }
  dispose() {
    this.pending?.abort?.abort()
    this.pending = undefined
    this.oauth.cancel()
    for (const slot of this.slots.values()) slot.abort.abort()
  }
}
