import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { FEISHU_SCOPES, feishuConfigSchema, type FeishuConfig } from '../../src/shared/feishu'
import type { Authorization } from './vault'
import { FeishuError } from './errors'
import { parseTokens } from './client'

// Protocol reference: larksuite/cli internal/auth/{app_registration,device_flow,paths}.go.
// No shared application secret, CLI process or remote workspace service is required.
const accounts = 'https://accounts.feishu.cn'
const registration = '/oauth/v1/app/registration'
export type SetupPrompt = {
  phase: 'creating_app' | 'authorizing'
  url: string
  userCode: string
  expiresAt: number
}
export interface OneClickFlow {
  register(prompt: (value: SetupPrompt) => void, signal: AbortSignal): Promise<FeishuConfig>
  authorize(
    config: FeishuConfig,
    prompt: (value: SetupPrompt) => void,
    signal: AbortSignal,
  ): Promise<Authorization['token']>
  reopen(url: string): Promise<void>
}
const startSchema = z.object({
  device_code: z.string().min(1).max(4096),
  user_code: z.string().min(1).max(256),
  interval: z.number().optional(),
  expire_in: z.number().optional(),
  expires_in: z.number().optional(),
  verification_uri: z.string().optional(),
  verification_uri_complete: z.string().optional(),
})
function seconds(value: number | undefined, fallback: number, max: number) {
  return value && Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback
}
export class OneClickAuth implements OneClickFlow {
  constructor(
    private openBrowser: (url: string) => Promise<void>,
    private request: typeof fetch = fetch,
    private now = Date.now,
  ) {}
  async reopen(value: string) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new FeishuError('api', '飞书返回了无效的授权地址，请重试。')
    }
    if (
      url.protocol !== 'https:' ||
      !['open.feishu.cn', 'accounts.feishu.cn'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    )
      throw new FeishuError('api', '飞书授权地址不受支持，请使用高级设置连接。')
    try {
      await this.openBrowser(value)
    } catch {
      throw new FeishuError('api', '无法打开系统浏览器，请重试。')
    }
  }
  private async post(
    path: string,
    fields: Record<string, string>,
    signal: AbortSignal,
    basic?: FeishuConfig,
  ) {
    signal.throwIfAborted()
    let response: Response, data: Record<string, unknown>
    try {
      response = await this.request(accounts + path, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(basic
            ? {
                Authorization: `Basic ${Buffer.from(`${basic.appId}:${basic.appSecret}`).toString('base64')}`,
              }
            : {}),
        },
        body: new URLSearchParams(fields),
      })
      signal.throwIfAborted()
    } catch {
      signal.throwIfAborted()
      throw new FeishuError('network', '暂时无法连接飞书，请检查网络后重试。')
    }
    if (response.status === 429) return { error: 'slow_down' }
    if (response.status >= 500) throw new FeishuError('network', '飞书服务暂时不可用，请稍后重试。')
    try {
      data = z.record(z.string(), z.unknown()).parse(await response.json())
    } catch {
      throw new FeishuError('api', '飞书返回了无法识别的授权响应，请重试。')
    }
    if (!response.ok && !data.error)
      throw new FeishuError('api', '飞书未能启动快捷连接，请重试或使用高级设置。')
    return data
  }
  private check(data: Record<string, unknown>) {
    if (
      data.user_info &&
      typeof data.user_info === 'object' &&
      'tenant_brand' in data.user_info &&
      data.user_info.tenant_brand &&
      data.user_info.tenant_brand !== 'feishu'
    )
      throw new FeishuError('permission', '当前仅支持飞书国内版，请使用飞书身份完成连接。')
    switch (data.error) {
      case undefined:
      case '':
        return
      case 'authorization_pending':
      case 'slow_down':
        return
      case 'access_denied':
        throw new FeishuError('authorization', '你已取消飞书确认，原有连接保持不变。')
      case 'expired_token':
      case 'invalid_grant':
        throw new FeishuError('authorization', '飞书连接确认已过期，请重新发起。')
      default:
        throw new FeishuError(
          'permission',
          '飞书未允许快捷连接。请检查企业应用创建与授权策略，或使用高级设置连接现有应用。',
        )
    }
  }
  private async poll<T>(
    path: string,
    fields: Record<string, string>,
    initial: z.infer<typeof startSchema>,
    signal: AbortSignal,
    read: (data: Record<string, unknown>) => T | undefined,
    immediate: boolean,
  ) {
    const lifetime = Math.ceil(seconds(initial.expire_in ?? initial.expires_in, 600, 600) * 1000)
    const deadline = AbortSignal.timeout(lifetime)
    const scope = AbortSignal.any([signal, deadline])
    let interval = seconds(initial.interval, 5, 60) * 1000
    try {
      for (;;) {
        if (!immediate) await delay(interval, undefined, { signal: scope })
        immediate = false
        let data: Record<string, unknown>
        try {
          data = await this.post(path, fields, scope)
        } catch (error) {
          if (error instanceof FeishuError && error.kind === 'network') {
            interval = Math.min(interval + 1000, 60000)
            continue
          }
          throw error
        }
        scope.throwIfAborted()
        this.check(data)
        if (data.error === 'slow_down') interval = Math.min(interval + 5000, 60000)
        if (data.error) continue
        const result = read(data)
        if (result !== undefined) return result
      }
    } catch (error) {
      if (signal.aborted) throw new FeishuError('authorization', '飞书连接已取消。')
      if (deadline.aborted)
        throw new FeishuError('authorization', '飞书连接确认已超时，请重新发起。')
      throw error
    }
  }
  async register(prompt: (value: SetupPrompt) => void, signal: AbortSignal) {
    const data = await this.post(
      registration,
      {
        action: 'begin',
        archetype: 'PersonalAgent',
        auth_method: 'client_secret',
        request_user_info: 'open_id tenant_brand',
      },
      signal,
    )
    this.check(data)
    const begin = startSchema.safeParse(data)
    if (!begin.success) throw new FeishuError('api', '飞书未返回完整的应用创建信息，请重试。')
    const initial = begin.data
    const url = `https://open.feishu.cn/page/cli?user_code=${encodeURIComponent(initial.user_code)}`
    signal.throwIfAborted()
    prompt({
      phase: 'creating_app',
      url,
      userCode: initial.user_code,
      expiresAt: this.now() + seconds(initial.expire_in ?? initial.expires_in, 600, 600) * 1000,
    })
    await this.reopen(url)
    return this.poll(
      registration,
      { action: 'poll', device_code: initial.device_code },
      initial,
      signal,
      (data) => {
        if (!data.client_id || !data.client_secret) return undefined
        const config = feishuConfigSchema.safeParse({
          appId: data.client_id,
          appSecret: data.client_secret,
        })
        if (!config.success) throw new FeishuError('api', '飞书返回的应用凭证无效，请重新连接。')
        return config.data
      },
      true,
    )
  }
  async authorize(config: FeishuConfig, prompt: (value: SetupPrompt) => void, signal: AbortSignal) {
    const data = await this.post(
      '/oauth/v1/device_authorization',
      { client_id: config.appId, scope: FEISHU_SCOPES.join(' ') },
      signal,
      config,
    )
    this.check(data)
    const begin = startSchema.safeParse(data)
    if (!begin.success) throw new FeishuError('api', '飞书未返回完整的用户授权信息，请重试。')
    const initial = begin.data
    const url = initial.verification_uri_complete || initial.verification_uri
    if (!url) throw new FeishuError('api', '飞书未返回授权地址，请重试。')
    signal.throwIfAborted()
    prompt({
      phase: 'authorizing',
      url,
      userCode: initial.user_code,
      expiresAt: this.now() + seconds(initial.expires_in, 600, 600) * 1000,
    })
    await this.reopen(url)
    return this.poll(
      '/oauth/v3/token',
      {
        client_id: config.appId,
        client_secret: config.appSecret,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: initial.device_code,
      },
      initial,
      signal,
      (data) => {
        if (!data.access_token) return undefined
        if (typeof data.token_type === 'string' && data.token_type.toLowerCase() !== 'bearer')
          throw new FeishuError('api', '当前授权令牌类型不受支持，请使用高级设置。')
        return parseTokens(data, this.now())
      },
      false,
    )
  }
}
