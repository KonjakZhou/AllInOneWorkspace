import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { UpdateState } from '../../src/shared/updates'

test('updates stay discoverable through the toolbar, progress, dismissal and settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-updates-desktop-'))
  const app = await electron.launch({
    args: [process.env.WORKSPACE_TEST_APP ?? resolve('out/main/index.js')],
    executablePath: process.env.WORKSPACE_TEST_EXECUTABLE,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', WORKSPACE_DATA_DIR: directory },
  })
  try {
    const page = await app.firstWindow()
    const entry = page.getByRole('button', { name: '应用更新', exact: true })
    await expect(page.getByRole('heading', { name: '我的工作区.' })).toBeVisible()
    await page.evaluate(() => window.workspace.updates.setAutomatic(false))
    await expect(entry).toBeVisible()
    await entry.click()
    await expect(page.getByRole('dialog', { name: '版本与更新' })).toBeVisible()
    await expect(page.getByRole('button', { name: '检查更新', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '关闭对话框' }).click()

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 720))
    await page.getByRole('button', { name: '编辑布局', exact: true }).click()
    await expect(entry).toBeVisible()
    await expect(page.getByRole('button', { name: '添加组件', exact: true })).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true)
    await page.getByRole('button', { name: '完成编辑' }).click()

    // The existing settings path still provides the same controls.
    await page.getByRole('button', { name: '应用设置' }).click()
    await expect(page.getByRole('heading', { name: '应用更新' })).toBeVisible()
    await expect(page.getByLabel('自动检查并下载更新')).not.toBeChecked()
    expect(JSON.parse(await readFile(join(directory, 'update-settings.json'), 'utf8'))).toEqual({
      automatic: false,
    })
    await page.getByRole('button', { name: '关闭对话框' }).click()

    const publish = (patch: Partial<UpdateState>) =>
      app.evaluate(({ BrowserWindow }, patch) => {
        BrowserWindow.getAllWindows()[0].webContents.send('updates:changed', {
          phase: 'available',
          currentVersion: '1.1.0',
          version: '1.2.0',
          automatic: false,
          canInstall: true,
          ...patch,
        })
      }, patch)
    await publish({ phase: 'available' })
    await expect(entry).toContainText('有新版')
    await publish({ phase: 'downloading', progress: 42 })
    await expect(entry).toContainText('42%')
    await publish({ phase: 'ready' })
    await expect(entry).toContainText('可安装')
    await expect(page.getByText('v1.2.0 已下载', { exact: false })).toBeVisible()
    await page.screenshot({ path: 'test-results/update-toolbar.png' })
    await page.getByRole('button', { name: '查看更新', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '版本与更新' })).toBeVisible()
    await expect(page.getByRole('button', { name: '重启并安装' })).toBeVisible()
    await page.screenshot({ path: 'test-results/update-settings.png' })
    await page.getByRole('button', { name: '关闭对话框' }).click()
    await page.getByRole('button', { name: '稍后更新' }).click()
    await expect(page.getByRole('button', { name: '查看更新', exact: true })).toHaveCount(0)
    await expect(entry).toContainText('可安装')
    await entry.click()
    await expect(page.getByRole('button', { name: '重启并安装' })).toBeVisible()
    await page.getByRole('button', { name: '关闭对话框' }).click()
    await publish({ phase: 'ready', canInstall: false })
    await expect(entry).toContainText('已下载')
    await publish({ phase: 'error' })
    await expect(entry).toContainText('需重试')
    const index = JSON.parse(await readFile(join(directory, 'accounts.json'), 'utf8'))
    const workspace = JSON.parse(
      await readFile(join(directory, 'accounts', index.activeAccountId + '.json'), 'utf8'),
    )
    expect(workspace).not.toHaveProperty('updates')
    expect(workspace).not.toHaveProperty('automatic')
  } finally {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  }
})
