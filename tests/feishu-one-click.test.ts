import { describe, expect, it, vi } from 'vitest'
import { OneClickAuth } from '../electron/feishu/one-click'
import { FEISHU_SCOPES } from '../src/shared/feishu'
import { config, credentials, deferred, now, setupService } from './feishu-fixtures'
import { FeishuError } from '../electron/feishu/errors'

const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
const begin = {
  device_code: 'private-device-code',
  user_code: 'ABCD',
  interval: 0.001,
  expires_in: 60,
}
const authBegin = {
  ...begin,
  verification_uri_complete: 'https://accounts.feishu.cn/confirm?user_code=ABCD',
}
const token = {
  access_token: 'at',
  refresh_token: 'rt',
  expires_in: 120,
  refresh_token_expires_in: 600,
  token_type: 'Bearer',
}
const signal = () => new AbortController().signal
describe('official app registration and device authorization', () => {
  it('creates credentials without any embedded application secret and opens the official confirmation page', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(begin))
      .mockResolvedValueOnce(response({ error: 'authorization_pending' }, 400))
      .mockResolvedValueOnce(
        response({
          client_id: config.appId,
          client_secret: config.appSecret,
          user_info: { tenant_brand: 'feishu' },
        }),
      )
    const open = vi.fn(async () => {}),
      prompt = vi.fn(),
      flow = new OneClickAuth(open, request, () => now)
    expect(await flow.register(prompt, signal())).toEqual(config)
    expect(request.mock.calls[0][0]).toBe('https://accounts.feishu.cn/oauth/v1/app/registration')
    expect(Object.fromEntries(request.mock.calls[0][1]!.body as URLSearchParams)).toEqual({
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id tenant_brand',
    })
    expect(open).toHaveBeenCalledWith('https://open.feishu.cn/page/cli?user_code=ABCD')
    expect(prompt.mock.calls[0][0]).toMatchObject({ phase: 'creating_app', userCode: 'ABCD' })
    expect(JSON.stringify(prompt.mock.calls)).not.toMatch(/private-device-code|test-secret/)
    expect(request.mock.calls[1][1]?.redirect).toBe('error')
  })
  it('requests exactly calendar, basic identity and offline access; exchanges only after consent', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(authBegin))
      .mockResolvedValueOnce(response({ error: 'authorization_pending' }, 400))
      .mockResolvedValueOnce(response(token))
    const open = vi.fn(async () => {}),
      flow = new OneClickAuth(open, request, () => now)
    const grant = await flow.authorize(config, () => {}, signal())
    expect(grant).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: now + 120000,
      refreshExpiresAt: now + 600000,
    })
    expect((request.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from(`${config.appId}:${config.appSecret}`).toString('base64')}`,
    )
    expect((request.mock.calls[0][1]!.body as URLSearchParams).get('scope')).toBe(
      FEISHU_SCOPES.join(' '),
    )
    expect((request.mock.calls[1][1]!.body as URLSearchParams).get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:device_code',
    )
    expect(open).toHaveBeenCalledWith(authBegin.verification_uri_complete)
  })
  it.each(['access_denied', 'expired_token', 'invalid_grant', 'unsupported_grant_type'])(
    'stops on %s and never exposes raw provider descriptions',
    async (error) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response(begin))
        .mockResolvedValueOnce(response({ error, error_description: 'SECRET-DO-NOT-DISPLAY' }, 400))
      const flow = new OneClickAuth(async () => {}, request)
      await expect(flow.register(() => {}, signal())).rejects.toThrow(/取消|过期|未允许/)
    },
  )
  it('bounds polling by expiry, honors slow_down and aborts promptly', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ ...begin, expires_in: 0.025 }))
      .mockResolvedValue(response({ error: 'slow_down' }, 429))
    const flow = new OneClickAuth(async () => {}, request)
    await expect(flow.register(() => {}, signal())).rejects.toThrow('超时')
    expect(request).toHaveBeenCalledTimes(2)
    const abort = new AbortController(),
      paused = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response(begin))
        .mockImplementation(async () => response({ error: 'authorization_pending' }, 400))
    const next = new OneClickAuth(async () => {}, paused).register(() => {}, abort.signal)
    await vi.waitFor(() => expect(paused.mock.calls.length).toBeGreaterThanOrEqual(2))
    abort.abort()
    await expect(next).rejects.toThrow('取消')
  })
  it('rejects non-Feishu brands, hostile browser links, unsupported token types and missing refresh grants', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(begin))
      .mockResolvedValueOnce(
        response({
          client_id: config.appId,
          client_secret: config.appSecret,
          user_info: { tenant_brand: 'lark' },
        }),
      )
    await expect(
      new OneClickAuth(async () => {}, request).register(() => {}, signal()),
    ).rejects.toThrow('国内版')
    const open = vi.fn(async () => {})
    for (const url of [
      'file:///etc/passwd',
      'https://accounts.feishu.cn.evil.test/a',
      'https://evil.test',
      'https://x@accounts.feishu.cn/a',
    ])
      await expect(new OneClickAuth(open).reopen(url)).rejects.toThrow('不受支持')
    expect(open).not.toHaveBeenCalled()
    for (const data of [
      { ...token, token_type: 'DPoP' },
      { access_token: 'at', expires_in: 20 },
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response(authBegin))
        .mockResolvedValueOnce(response(data))
      await expect(
        new OneClickAuth(open, fetcher).authorize(config, () => {}, signal()),
      ).rejects.toThrow(/令牌类型|离线/)
    }
  })
})

describe('one-click account binding and retries', () => {
  it('binds to the initiating account and persists a reusable device-flow application', async () => {
    const { service, oneClick, a, b, disk } = setupService(false)
    disk.delete(a)
    await service.connect(a)
    await service.getConnection(b)
    await vi.waitFor(async () => expect((await service.getConnection(a)).status).toBe('connected'))
    expect(disk.get(a)).toMatchObject({
      authMode: 'device',
      configuration: config,
      authorization: { identity: { name: '新身份' } },
    })
    expect((await service.getConnection(b)).status).toBe('unconfigured')
    await service.authorize(a)
    await vi.waitFor(async () => expect((await service.getConnection(a)).status).toBe('connected'))
    expect(oneClick.register).toHaveBeenCalledOnce()
    expect(oneClick.authorize).toHaveBeenCalledTimes(2)
  })
  it('retains created app credentials when user grant is cancelled; retry does not create another app', async () => {
    const { service, oneClick, a, disk } = setupService(false)
    disk.delete(a)
    const grant = deferred<ReturnType<typeof credentials>['authorization']>()
    oneClick.authorize.mockImplementationOnce(async (_config, prompt, signal) => {
      prompt({
        phase: 'authorizing',
        url: 'https://accounts.feishu.cn/confirm',
        userCode: 'CODE',
        expiresAt: now + 60000,
      })
      await grant.promise
      signal.throwIfAborted()
      return credentials().authorization!.token
    })
    await service.connect(a)
    await vi.waitFor(() => expect(oneClick.authorize).toHaveBeenCalledOnce())
    expect((await service.getConnection(a)).setup).toMatchObject({
      phase: 'authorizing',
      userCode: 'CODE',
    })
    await service.reopenAuthorization(a)
    expect(oneClick.reopen).toHaveBeenCalledWith('https://accounts.feishu.cn/confirm')
    service.cancelAuthorization(a)
    grant.resolve(undefined)
    expect(disk.get(a)?.configuration).toEqual(config)
    expect(disk.get(a)?.authorization).toBeUndefined()
    await service.connect(a)
    await vi.waitFor(async () => expect((await service.getConnection(a)).status).toBe('connected'))
    expect(oneClick.register).toHaveBeenCalledOnce()
  })
  it.each(['cancel', 'delete'] as const)('ignores late registration after %s', async (action) => {
    const { service, oneClick, a, disk, accounts } = setupService(false)
    disk.delete(a)
    const registration = deferred<typeof config>()
    oneClick.register.mockImplementationOnce(() => registration.promise)
    await service.connect(a)
    if (action === 'cancel') service.cancelAuthorization(a)
    else {
      await service.removeAccount(a)
      accounts.delete(a)
    }
    registration.resolve(config)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(disk.has(a)).toBe(false)
    expect(oneClick.authorize).not.toHaveBeenCalled()
  })
  it('retries failed credential persistence without creating a duplicate remote app', async () => {
    const { service, oneClick, a, disk, vault } = setupService(false)
    disk.delete(a)
    vault.write.mockRejectedValueOnce(new FeishuError('storage', '无法保存'))
    await service.connect(a)
    await vi.waitFor(async () => expect((await service.getConnection(a)).message).toBe('无法保存'))
    expect(oneClick.authorize).not.toHaveBeenCalled()
    await service.connect(a)
    await vi.waitFor(async () => expect((await service.getConnection(a)).status).toBe('connected'))
    expect(oneClick.register).toHaveBeenCalledOnce()
    expect(disk.get(a)?.authMode).toBe('device')
  })
})
