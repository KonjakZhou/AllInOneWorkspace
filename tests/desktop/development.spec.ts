import { test, expect, chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'

test('pnpm dev opens the real application with the Vite refresh preamble allowed by CSP', async () => {
  test.skip(
    !!process.env.WORKSPACE_TEST_EXECUTABLE,
    'Development is tested separately from the packaged app',
  )
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const directory = await mkdtemp(join(tmpdir(), 'workspace-dev-'))
  const child = spawn('pnpm', ['dev', '--remoteDebuggingPort', String(port)], {
    detached: true,
    env: { ...process.env, WORKSPACE_DATA_DIR: directory, ELECTRON_RUN_AS_NODE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (data) => {
    output += String(data)
  })
  child.stderr.on('data', (data) => {
    output += String(data)
  })
  const exited = once(child, 'exit')
  try {
    await expect
      .poll(
        async () => {
          if (child.exitCode !== null) throw new Error(output)
          try {
            return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok
          } catch {
            return false
          }
        },
        { timeout: 30000 },
      )
      .toBe(true)
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const page = browser.contexts()[0].pages()[0]
    await expect(page.getByRole('heading', { name: '我的工作区.' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '你的空间，由你来定义' })).toBeVisible()
    await page.getByRole('button', { name: '为工作区再添一点可能' }).click()
    await expect(page.getByRole('dialog')).toContainText('文本卡片')
  } finally {
    if (child.pid && child.exitCode === null) process.kill(-child.pid, 'SIGTERM')
    await exited
    await rm(directory, { recursive: true, force: true })
  }
})
