import { vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { CredentialRecord, CredentialVault } from '../electron/feishu/vault'
import type { FeishuClientAPI } from '../electron/feishu/client'
import type { OAuthCallbacks, OAuthFlow } from '../electron/feishu/oauth'
import { FeishuService } from '../electron/feishu/service'
import type { OneClickFlow } from '../electron/feishu/one-click'

export const now = new Date(2026, 10, 24, 12).getTime()
export const config = { appId: 'cli_test', appSecret: 'test-secret-never-export' }
export const credentials = (name = '甲'): CredentialRecord => ({
  schemaVersion: 1,
  configuration: config,
  authorization: {
    application: config,
    identity: { openId: name, name },
    calendarId: `calendar-${name}`,
    token: {
      accessToken: 'access-' + name,
      refreshToken: 'refresh-' + name,
      expiresAt: now + 7200000,
      refreshExpiresAt: now + 86400000,
    },
  },
})
export const event = {
  id: 'event-1',
  title: '设计讨论',
  start: now + 3600000,
  end: now + 7200000,
  allDay: false,
}
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
export function setupService(connected = true) {
  const a = randomUUID(),
    b = randomUUID(),
    accounts = new Set<string>([a, b])
  const disk = new Map<string, CredentialRecord>(
    connected
      ? [
          [a, credentials('甲')],
          [b, credentials('乙')],
        ]
      : [[a, { schemaVersion: 1, configuration: config }]],
  )
  const vault = {
    read: vi.fn<CredentialVault['read']>(async (id) => structuredClone(disk.get(id))),
    write: vi.fn<CredentialVault['write']>(async (id, data) => {
      disk.set(id, structuredClone(data))
    }),
    remove: vi.fn<CredentialVault['remove']>(async (id) => {
      disk.delete(id)
    }),
  }
  const client = {
    exchange: vi.fn<FeishuClientAPI['exchange']>(
      async () => credentials('新').authorization!.token,
    ),
    refresh: vi.fn<FeishuClientAPI['refresh']>(
      async () => credentials('轮换').authorization!.token,
    ),
    identity: vi.fn<FeishuClientAPI['identity']>(async () => ({ openId: '新', name: '新身份' })),
    primary: vi.fn<FeishuClientAPI['primary']>(async () => 'new-primary'),
    events: vi.fn<FeishuClientAPI['events']>(async (_token, id) => [{ ...event, title: id }]),
  }
  let callbacks!: OAuthCallbacks
  let abort = new AbortController()
  const oauth = {
    start: vi.fn<OAuthFlow['start']>(async (_id, _app, handlers) => {
      callbacks = handlers
      abort = new AbortController()
    }),
    cancel: vi.fn<OAuthFlow['cancel']>(() => abort.abort()),
  }
  let time = now
  const changed = vi.fn()
  const oneClick = {
    register: vi.fn<OneClickFlow['register']>(async () => config),
    authorize: vi.fn<OneClickFlow['authorize']>(
      async () => credentials('快捷').authorization!.token,
    ),
    reopen: vi.fn<OneClickFlow['reopen']>(async () => {}),
  }
  const service = new FeishuService(
    vault,
    client,
    oauth,
    async (id) => accounts.has(id),
    changed,
    () => time,
    oneClick,
  )
  return {
    a,
    b,
    accounts,
    disk,
    vault,
    client,
    oauth,
    service,
    changed,
    oneClick,
    advance: (ms: number) => {
      time += ms
    },
    complete: () => callbacks.complete('code', 'verifier', abort.signal),
    fail: (message: string) => callbacks.failed(message),
  }
}
