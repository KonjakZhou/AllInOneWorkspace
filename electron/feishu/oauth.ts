import { createServer, type Server } from 'node:http'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { FEISHU_REDIRECT_URI, FEISHU_SCOPES } from '../../src/shared/feishu'

export interface OAuthCallbacks {
  complete(code: string, verifier: string, signal: AbortSignal): Promise<void>
  failed(message: string): void
}
export interface OAuthFlow {
  start(accountId: string, appId: string, callbacks: OAuthCallbacks): Promise<void>
  cancel(accountId?: string): void
}
type Session = {
  accountId: string
  server: Server
  abort: AbortController
  timer?: ReturnType<typeof setTimeout>
  used: boolean
  callbacks: OAuthCallbacks
}
export class LoopbackOAuth implements OAuthFlow {
  private session?: Session
  constructor(
    private openBrowser: (url: string) => Promise<void>,
    private port = 43821,
    private timeoutMs = 300000,
  ) {}
  async start(accountId: string, appId: string, callbacks: OAuthCallbacks): Promise<void> {
    if (this.session) throw new Error('已有飞书授权正在进行，请先完成或取消。')
    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(48).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const session: Session = {
      accountId,
      server: createServer(),
      abort: new AbortController(),
      used: false,
      callbacks,
    }
    this.session = session
    session.server.on('request', async (request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Referrer-Policy', 'no-referrer')
      response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
      let url: URL
      try {
        url = new URL(request.url ?? '/', FEISHU_REDIRECT_URI)
      } catch {
        response.writeHead(400).end('授权回调无效。')
        return
      }
      const supplied = url.searchParams.get('state') ?? ''
      const expectedHost = `127.0.0.1:${(session.server.address() as { port: number } | null)?.port}`
      if (
        request.method !== 'GET' ||
        request.headers.host !== expectedHost ||
        url.pathname !== '/oauth/feishu/callback' ||
        Buffer.byteLength(supplied) !== Buffer.byteLength(state) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(state))
      ) {
        response.writeHead(400).end('授权回调无效，请返回应用重新发起授权。')
        return
      }
      if (session.used || session.abort.signal.aborted) {
        response.writeHead(409).end('此授权回调已处理。')
        return
      }
      session.used = true
      try {
        const code = url.searchParams.get('code')
        if (url.searchParams.has('error') || !code)
          throw new Error('你已取消飞书授权，原有连接保持不变。')
        await callbacks.complete(code, verifier, session.abort.signal)
        response.end(
          '<!doctype html><html lang="zh-CN"><title>飞书已连接</title><body style="font:18px system-ui;padding:60px;color:#48694f"><h1>飞书已连接</h1><p>现在可以关闭此页面，返回 All In One Workspace。</p></body></html>',
        )
      } catch (error) {
        if (!session.abort.signal.aborted)
          callbacks.failed(error instanceof Error ? error.message : '授权失败，请返回应用重试。')
        response.writeHead(400).end('授权未完成，请返回 All In One Workspace 查看原因并重试。')
      } finally {
        this.finish(session)
      }
    })
    try {
      await new Promise<void>((resolve, reject) => {
        session.server.once('error', reject)
        session.server.listen(this.port, '127.0.0.1', () => {
          session.server.removeListener('error', reject)
          resolve()
        })
      })
      if (session.abort.signal.aborted) {
        this.finish(session)
        return
      }
      session.timer = setTimeout(() => {
        callbacks.failed('飞书授权已超时，请重新发起授权。')
        this.cancel(accountId)
      }, this.timeoutMs)
      session.timer.unref()
      const url = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize')
      url.search = new URLSearchParams({
        client_id: appId,
        redirect_uri: FEISHU_REDIRECT_URI,
        response_type: 'code',
        scope: FEISHU_SCOPES.join(' '),
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'consent',
      }).toString()
      await this.openBrowser(url.href)
    } catch (error) {
      this.cancel(accountId)
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
        throw new Error('本机 43821 端口被占用，请关闭占用该端口的程序后重试。')
      throw new Error('无法启动飞书授权，请确认系统浏览器可用并重试。')
    }
  }
  private finish(session: Session) {
    clearTimeout(session.timer)
    session.server.close()
    session.server.closeIdleConnections()
    if (this.session === session) this.session = undefined
  }
  cancel(accountId?: string) {
    const session = this.session
    if (!session || (accountId && session.accountId !== accountId)) return
    session.abort.abort()
    session.server.closeAllConnections()
    this.finish(session)
  }
}
