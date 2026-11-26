import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('Chinese menus retain editing and save before closing or quitting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-menu-'))
  await writeFile(join(directory, 'update-settings.json'), '{"automatic":false}')
  const app = await electron.launch({
    args: [process.env.WORKSPACE_TEST_APP ?? resolve('out/main/index.js')],
    executablePath: process.env.WORKSPACE_TEST_EXECUTABLE,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', WORKSPACE_DATA_DIR: directory },
  })
  try {
    let page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: '我的工作区.' })).toBeVisible()
    const menus = await app.evaluate(({ Menu, app }) => ({
      packaged: app.isPackaged,
      items: Menu.getApplicationMenu()!.items.map((item) => ({
        label: item.label,
        children: item
          .submenu!.items.filter((child) => child.type !== 'separator')
          .map((child) => ({ label: child.label, role: child.role })),
      })),
    }))
    expect(menus.items.map((item) => item.label)).toEqual(['All In One Workspace', '编辑', '窗口'])
    const children = menus.items.flatMap((item) => item.children)
    expect(children.every((item) => /^[\u3400-\u9fff]+$/.test(item.label))).toBe(true)
    const roles = children.map((item) => item.role).filter(Boolean)
    expect(new Set(roles).size).toBe(roles.length)
    if (menus.packaged) expect(roles).not.toContain('toggledevtools')

    // Capture the actual native-dialog request without leaving a modal open in CI.
    const about = await app.evaluate(({ Menu, dialog, BrowserWindow, app }) => {
      const original = dialog.showMessageBox
      let options: unknown
      dialog.showMessageBox = (async (...args: unknown[]) => {
        options = args.at(-1)
        return { response: 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
      try {
        const item = Menu.getApplicationMenu()!.getMenuItemById('about-workspace')!
        item.click(item, BrowserWindow.getAllWindows()[0], {})
        return { options, version: app.getVersion() }
      } finally {
        dialog.showMessageBox = original
      }
    })
    expect(about.options).toMatchObject({
      title: '关于工作区',
      detail: expect.stringContaining(`版本 ${about.version}`),
      buttons: ['好'],
    })

    await page.getByRole('button', { name: '为工作区再添一点可能', exact: true }).click()
    await page
      .locator('.library-card')
      .filter({ has: page.getByRole('heading', { name: '文本卡片', exact: true }) })
      .getByRole('button', { name: '添加', exact: true })
      .click()
    await page.getByRole('button', { name: '组件设置' }).click()
    const title = page.getByLabel('卡片标题')
    await title.fill('菜单验证测')
    await title.press('End')
    await title.pressSequentially('试')
    await title.press('Meta+z')
    await expect(title).toHaveValue('菜单验证测')
    await title.press('Meta+Shift+z')
    await expect(title).toHaveValue('菜单验证测试')

    // Close immediately after an edit: the menu must use the existing save handshake.
    // macOS executes the close role in Cocoa, not MenuItem.click's JS callback.
    expect(roles).toContain('close')
    await app.evaluate(({ Menu }) => Menu.sendActionToFirstResponder('performClose:'))
    await expect.poll(() => app.windows().length).toBe(0)
    const reopened = app.waitForEvent('window')
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()!.getMenuItemById('show-workspace')!
      item.click(item, null, {})
    })
    page = await reopened
    await expect(page.getByRole('heading', { name: '菜单验证测试' })).toBeVisible()
    const exited = app.waitForEvent('close')
    expect(roles).toContain('quit')
    await app.evaluate(({ app }) => app.quit())
    await exited
  } finally {
    await app.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})
