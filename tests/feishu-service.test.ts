import { describe, expect, it } from 'vitest'
import { credentials, deferred, event, now, setupService } from './feishu-fixtures'
import { FeishuError } from '../electron/feishu/errors'
import type { CredentialRecord } from '../electron/feishu/vault'

describe('account-scoped Feishu service', () => {
  it('isolates identities and shares requests/cache between instances of one account', async () => {
    const { service, client, a, b } = setupService()
    const [first, second, other] = await Promise.all([
      service.getAgenda(a),
      service.getAgenda(a),
      service.getAgenda(b),
    ])
    expect(first).toEqual(second)
    expect(first.events[0].title).toBe('calendar-甲')
    expect(other.events[0].title).toBe('calendar-乙')
    expect(client.events).toHaveBeenCalledTimes(2)
    await service.getAgenda(a)
    expect(client.events).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(await service.getConnection(a))).not.toMatch(
      /access-|refresh-|test-secret/,
    )
  })
  it('coalesces refresh, persists rotated tokens, and uses returned expiry', async () => {
    const { service, client, vault, disk, a } = setupService()
    disk.get(a)!.authorization!.token.expiresAt = now - 1
    await Promise.all([service.getAgenda(a), service.getAgenda(a, true), service.getAgenda(a)])
    expect(client.refresh).toHaveBeenCalledOnce()
    expect(client.refresh.mock.calls[0][1]).toBe('refresh-甲')
    expect(vault.write).toHaveBeenCalledOnce()
    expect(disk.get(a)?.authorization?.token.refreshToken).toBe('refresh-轮换')
    expect(client.events.mock.calls[0][0]).toBe('access-轮换')
  })
  it('does not reuse a consumed refresh token after a disk write failure', async () => {
    const { service, client, vault, disk, a, advance } = setupService()
    disk.get(a)!.authorization!.token.expiresAt = now - 1
    vault.write.mockRejectedValueOnce(new FeishuError('storage', '保存失败'))
    expect((await service.getAgenda(a)).error?.kind).toBe('storage')
    advance(31000)
    expect((await service.getAgenda(a, true)).error).toBeNull()
    expect(client.refresh).toHaveBeenCalledOnce()
    expect(disk.get(a)?.authorization?.token.refreshToken).toBe('refresh-轮换')
  })
  it('retains stale data on network failure, observes rate limits, and retries after wake', async () => {
    const { service, client, a, advance } = setupService()
    const original = await service.getAgenda(a)
    client.events.mockRejectedValueOnce(new FeishuError('network', '离线'))
    const offline = await service.getAgenda(a, true)
    expect(offline).toMatchObject({
      events: original.events,
      updatedAt: original.updatedAt,
      stale: true,
      error: { kind: 'network' },
    })
    await service.getAgenda(a, true)
    expect(client.events).toHaveBeenCalledTimes(2)
    advance(31000)
    client.events.mockRejectedValueOnce(new FeishuError('rate_limit', '限流', 429, 60000))
    await service.getAgenda(a, true)
    advance(50000)
    await service.getAgenda(a, true)
    expect(client.events).toHaveBeenCalledTimes(3)
    advance(11000)
    service.resume()
    expect((await service.getAgenda(a)).stale).toBe(false)
  })
  it.each(['authorization', 'permission'] as const)(
    'hides cached events after unrecoverable %s errors',
    async (kind) => {
      const { service, client, a } = setupService()
      await service.getAgenda(a)
      client.events.mockRejectedValue(new FeishuError(kind, '重新授权'))
      client.refresh.mockRejectedValue(new FeishuError(kind, '重新授权'))
      const result = await service.getAgenda(a, true)
      expect(result.events).toEqual([])
      expect(result.connection.status).toBe(
        kind === 'authorization' ? 'reauth_required' : 'permission_denied',
      )
      await service.getAgenda(a, true)
      expect(client.events).toHaveBeenCalledTimes(2)
    },
  )
  it('refreshes rejected access tokens once before declaring authorization expired', async () => {
    const { service, client, a } = setupService()
    client.events.mockRejectedValueOnce(new FeishuError('authorization', '过期'))
    expect((await service.getAgenda(a)).events).toHaveLength(1)
    expect(client.refresh).toHaveBeenCalledOnce()
    expect(client.events).toHaveBeenCalledTimes(2)
  })
  it('binds callbacks to the initiating account while another account is read', async () => {
    const { service, a, b, complete } = setupService()
    await service.authorize(a)
    await service.getAgenda(b)
    await complete()
    expect((await service.getConnection(a)).identity?.name).toBe('新身份')
    expect((await service.getConnection(b)).identity?.name).toBe('乙')
  })
  it.each(['取消', '超时', '权限不足'])(
    'keeps original connection when reauthorization fails: %s',
    async (reason) => {
      const { service, a, fail, complete } = setupService()
      await service.authorize(a)
      if (reason === '取消') service.cancelAuthorization(a)
      else fail(reason)
      await expect(complete()).rejects.toThrow('取消')
      expect((await service.getConnection(a)).identity?.name).toBe('甲')
    },
  )
  it('checks event permission before replacing credentials', async () => {
    const { service, client, a, complete, disk } = setupService()
    await service.authorize(a)
    client.events.mockRejectedValueOnce(new FeishuError('permission', '无权限'))
    await expect(complete()).rejects.toThrow('无权限')
    expect(disk.get(a)?.authorization?.identity.name).toBe('甲')
  })
  it('disconnect cancels a late fetch and clears disk and cache for only that account', async () => {
    const { service, client, a, b, disk } = setupService()
    const late = deferred<(typeof event)[]>()
    client.events.mockImplementationOnce(() => late.promise)
    const reading = service.getAgenda(a)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await service.disconnect(a)
    late.resolve([event])
    expect((await reading).events).toEqual([])
    expect((await service.getAgenda(a)).events).toEqual([])
    expect(disk.has(a)).toBe(false)
    expect((await service.getConnection(b)).identity?.name).toBe('乙')
  })
  it('deletion invalidates callbacks and prevents a late load from resurrecting credentials', async () => {
    const { service, a, vault, accounts, complete, disk } = setupService()
    await service.authorize(a)
    await service.removeAccount(a)
    accounts.delete(a)
    await expect(complete()).rejects.toThrow('取消')
    expect(disk.has(a)).toBe(false)
    const other = setupService()
    const late = deferred<CredentialRecord | undefined>()
    other.vault.read.mockImplementationOnce(() => late.promise)
    const loading = other.service.getConnection(other.a)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const removing = other.service.disconnect(other.a)
    late.resolve(credentials())
    await Promise.all([loading, removing])
    expect((await other.service.getConnection(other.a)).identity).toBeNull()
    expect(vault.remove).toHaveBeenCalled()
  })
  it('cancelling during credential commit restores the old connection on disk', async () => {
    const { service, a, vault, disk, complete } = setupService()
    await service.authorize(a)
    const writing = deferred<void>(),
      entered = deferred<void>()
    vault.write.mockImplementationOnce(async (id, record) => {
      entered.resolve()
      await writing.promise
      disk.set(id, structuredClone(record))
    })
    const completing = complete()
    await entered.promise
    service.cancelAuthorization(a)
    writing.resolve()
    await completing
    expect(disk.get(a)?.authorization?.identity.name).toBe('甲')
    expect((await service.getConnection(a)).identity?.name).toBe('甲')
  })
  it('ignores old requests after a successful rebind to a different identity', async () => {
    const { service, client, a, complete } = setupService()
    const late = deferred<(typeof event)[]>()
    client.events.mockImplementationOnce(() => late.promise)
    const reading = service.getAgenda(a)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await service.authorize(a)
    await complete()
    late.resolve([{ ...event, title: '旧身份隐私' }])
    await reading
    expect((await service.getAgenda(a)).events[0].title).toBe('new-primary')
  })
  it('does not replace working auth when saving draft config, and cleans up failed deletes on retry', async () => {
    const { service, vault, a, disk } = setupService()
    await service.saveConfig(a, { appId: 'cli_other', appSecret: 'new-secret' })
    expect(disk.get(a)?.authorization?.application.appId).toBe('cli_test')
    vault.remove.mockRejectedValueOnce(new FeishuError('storage', '无法清理'))
    await expect(service.disconnect(a)).rejects.toThrow('无法清理')
    expect((await service.getAgenda(a)).events).toEqual([])
    await expect(service.saveConfig(a, { appId: 'cli_other', appSecret: 'new' })).rejects.toThrow(
      '清理',
    )
    await service.disconnect(a)
    expect(disk.has(a)).toBe(false)
  })
})
