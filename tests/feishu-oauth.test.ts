import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { LoopbackOAuth } from '../electron/feishu/oauth'

const flows: LoopbackOAuth[] = []
afterEach(() => {
  flows.splice(0).forEach((flow) => flow.cancel())
})
// Find a loopback port without exposing a production redirect override.
async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
describe('loopback OAuth state and lifecycle', () => {
  it('uses PKCE, rejects wrong state without consuming session, and binds the callback', async () => {
    const port = await availablePort(),
      open = vi.fn(async (_url: string) => {})
    const flow = new LoopbackOAuth(open, port)
    flows.push(flow)
    const complete = vi.fn(async (_code: string, _verifier: string, _signal: AbortSignal) => {})
    const failed = vi.fn()
    await flow.start('account-a', 'cli_test', { complete, failed })
    const auth = new URL(open.mock.calls[0][0]),
      state = auth.searchParams.get('state')!
    expect(auth.origin).toBe('https://accounts.feishu.cn')
    expect(auth.searchParams.get('scope')?.split(' ')).toEqual([
      'calendar:calendar.calendar:readonly',
      'calendar:calendar.event:read',
      'contact:user.base:readonly',
      'offline_access',
    ])
    expect(auth.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:43821/oauth/feishu/callback',
    )
    expect(state.length).toBeGreaterThan(32)
    const wrong = await fetch(`http://127.0.0.1:${port}/oauth/feishu/callback?state=wrong&code=bad`)
    expect(wrong.status).toBe(400)
    await wrong.text()
    expect(complete).not.toHaveBeenCalled()
    flow.cancel('other-account')
    const result = await fetch(
      `http://127.0.0.1:${port}/oauth/feishu/callback?state=${state}&code=secret-code`,
    )
    expect(await result.text()).not.toContain('secret-code')
    expect(result.status).toBe(200)
    expect(complete.mock.calls[0][0]).toBe('secret-code')
    expect(createHash('sha256').update(complete.mock.calls[0][1]).digest('base64url')).toBe(
      auth.searchParams.get('code_challenge'),
    )
    expect(failed).not.toHaveBeenCalled()
  })
  it('expires in the configured interval and closes the callback listener', async () => {
    const port = await availablePort(),
      failed = vi.fn()
    const flow = new LoopbackOAuth(async () => {}, port, 25)
    flows.push(flow)
    await flow.start('a', 'cli_test', { complete: async () => {}, failed })
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith(expect.stringContaining('超时')))
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow()
  })
  it('cancel aborts in-progress completion and frees the port', async () => {
    const port = await availablePort(),
      open = vi.fn(async (_url: string) => {})
    const flow = new LoopbackOAuth(open, port)
    flows.push(flow)
    let aborted = false
    const complete = vi.fn(async (_code: string, _verifier: string, signal: AbortSignal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true
            resolve()
          },
          { once: true },
        ),
      )
    })
    await flow.start('a', 'cli_test', { complete, failed: vi.fn() })
    const state = new URL(open.mock.calls[0][0]).searchParams.get('state')
    const pending = fetch(
      `http://127.0.0.1:${port}/oauth/feishu/callback?state=${state}&code=c`,
    ).catch(() => null)
    await vi.waitFor(() => expect(complete).toHaveBeenCalled())
    flow.cancel('a')
    await pending
    expect(aborted).toBe(true)
  })
  it('reports occupied ports and browser-open failures', async () => {
    const port = await availablePort(),
      first = new LoopbackOAuth(async () => {}, port),
      second = new LoopbackOAuth(async () => {}, port)
    flows.push(first, second)
    const callbacks = { complete: async () => {}, failed: vi.fn() }
    await first.start('a', 'cli_test', callbacks)
    await expect(second.start('b', 'cli_test', callbacks)).rejects.toThrow('端口被占用')
    first.cancel()
    const failed = new LoopbackOAuth(
      async () => {
        throw new Error('fail')
      },
      await availablePort(),
    )
    flows.push(failed)
    await expect(failed.start('a', 'cli_test', callbacks)).rejects.toThrow('系统浏览器')
  })
})
