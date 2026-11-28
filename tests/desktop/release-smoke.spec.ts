import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('packaged release starts with an isolated workspace and exposes updates', async () => {
  test.skip(!process.env.WORKSPACE_TEST_EXECUTABLE, 'Requires a freshly packaged app')
  const directory = await mkdtemp(join(tmpdir(), 'aio-release-smoke-'))
  await writeFile(join(directory, 'update-settings.json'), JSON.stringify({ automatic: false }))
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    app = await electron.launch({
      args: [resolve(process.env.WORKSPACE_TEST_APP!)],
      executablePath: resolve(process.env.WORKSPACE_TEST_EXECUTABLE!),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', WORKSPACE_DATA_DIR: directory },
    })
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: '我的工作区.' })).toBeVisible()
    expect(await app.evaluate(({ app }) => app.getVersion())).toBe(pkg.version)
    await page.getByRole('button', { name: '应用更新', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '版本与更新' })).toBeVisible()
    await expect(page.getByRole('button', { name: '检查更新', exact: true })).toBeVisible()
    const index = JSON.parse(await readFile(join(directory, 'accounts.json'), 'utf8'))
    expect(index.accounts).toHaveLength(1)
    expect(index.accounts[0].name).toBe('默认账号')
  } finally {
    await app?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
