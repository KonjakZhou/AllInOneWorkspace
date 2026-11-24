import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

let application: ElectronApplication
let directory: string
let page: Page
const errors: string[] = []

async function launch() {
  application = await electron.launch({
    args: [process.env.WORKSPACE_TEST_APP ?? resolve('out/main/index.js')],
    executablePath: process.env.WORKSPACE_TEST_EXECUTABLE,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', WORKSPACE_DATA_DIR: directory },
  })
  page = await application.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('heading', { name: '我的工作区.' })).toBeVisible()
}
async function close() {
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close()
  })
  await expect.poll(() => application.windows().length).toBe(0)
  await application.close()
}
async function readWorkspace() {
  const index = JSON.parse(await readFile(join(directory, 'accounts.json'), 'utf8'))
  return JSON.parse(
    await readFile(join(directory, 'accounts', index.activeAccountId + '.json'), 'utf8'),
  )
}
async function add(name: '文本卡片' | '计数器') {
  await page.getByRole('button', { name: '添加组件', exact: true }).click()
  await page
    .locator('.library-card')
    .filter({ has: page.getByRole('heading', { name, exact: true }) })
    .getByRole('button', { name: '添加', exact: true })
    .click()
}

test.beforeEach(async () => {
  errors.length = 0
  directory = await mkdtemp(join(tmpdir(), 'workspace-desktop-'))
  await launch()
})
test.afterEach(async () => {
  if (application) await application.close().catch(() => undefined)
  await rm(directory, { recursive: true, force: true })
})

test('desktop lifecycle: edit, drag, resize, isolate accounts, close and restore', async () => {
  await expect(page.getByRole('heading', { name: '你的空间，由你来定义' })).toBeVisible()
  await page.screenshot({ path: 'test-results/workspace-empty.png' })
  await add('文本卡片')
  await add('计数器')
  await add('计数器')
  const text = page.getByRole('article', { name: '文本卡片', exact: true })
  const counters = page.getByRole('article', { name: '计数器', exact: true })
  await counters.nth(0).getByRole('button', { name: '增加计数' }).click({ clickCount: 3 })
  await expect(counters.nth(0).getByLabel('当前计数')).toHaveText('3')
  await expect(counters.nth(1).getByLabel('当前计数')).toHaveText('0')
  await text.getByRole('button', { name: '组件设置' }).click()
  await page.getByLabel('卡片标题').fill('我的第一张卡片')
  await page.getByLabel('正文').fill('工作区的每一点改变，都会留在这里。')
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await expect(text.getByRole('heading', { name: '我的第一张卡片' })).toBeVisible()
  await page.getByRole('button', { name: '编辑布局', exact: true }).click()
  const handle = text.locator('.drag-handle')
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 16, box.y + 365, { steps: 20 })
  await page.mouse.up()
  await expect
    .poll(async () => (await readWorkspace()).widgets[0]?.layout.y ?? 0)
    .toBeGreaterThan(0)
  const resize = text.locator('..').locator('.react-resizable-handle')
  await resize.scrollIntoViewIfNeeded()
  // Wait for scrolling and the grid's transform transition before taking pointer coordinates.
  await resize.hover()
  const resizeBox = (await resize.boundingBox())!
  await page.mouse.move(resizeBox.x + 12, resizeBox.y + 12)
  await page.mouse.down()
  await page.mouse.move(resizeBox.x + 120, resizeBox.y + 60, { steps: 15 })
  await page.mouse.up()
  await expect
    .poll(async () => (await readWorkspace()).widgets[0]?.layout.w ?? 4)
    .toBeGreaterThan(4)
  await page.getByRole('button', { name: '完成编辑' }).click()
  const savedLayout = (await readWorkspace()).widgets[0].layout
  await page.screenshot({ path: 'test-results/workspace-populated.png', fullPage: true })
  await page.getByRole('button', { name: '管理账号' }).click()
  await page.getByLabel('创建一个新的空间').fill('生活')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect(page.locator('.account-row.selected')).toContainText('生活')
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await expect(page.getByRole('heading', { name: '你的空间，由你来定义' })).toBeVisible()
  await add('计数器')
  await page.getByRole('button', { name: '增加计数' }).click()
  await page.getByRole('button', { name: '管理账号' }).click()
  await page.getByRole('button', { name: '默认账号 点击切换工作区' }).click()
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await expect(counters.nth(0).getByLabel('当前计数')).toHaveText('3')
  await expect(text.getByRole('heading', { name: '我的第一张卡片' })).toBeVisible()
  // Close immediately after a mutation, before the debounce timer fires.
  await counters.nth(0).getByRole('button', { name: '增加计数' }).click()
  await close()
  await launch()
  await expect(
    page.getByRole('article', { name: '计数器', exact: true }).nth(0).getByLabel('当前计数'),
  ).toHaveText('4')
  expect((await readWorkspace()).widgets[0].layout).toEqual(savedLayout)
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1100, 720),
  )
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true)
  await page.screenshot({ path: 'test-results/workspace-minimum-window.png', fullPage: true })
  expect(errors).toEqual([])
})

test('failed saves keep edits and block switching until retry succeeds', async () => {
  await add('计数器')
  await expect.poll(async () => (await readWorkspace()).widgets.length).toBe(1)
  await chmod(join(directory, 'accounts'), 0o500)
  try {
    await page.getByRole('button', { name: '增加计数' }).click()
    await expect(page.getByRole('button', { name: '保存失败 · 点击重试' })).toBeVisible()
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect(page.getByRole('button', { name: '保存失败 · 点击重试' })).toBeVisible()
    expect(application.windows()).toHaveLength(1)
    await page.getByRole('button', { name: '管理账号' }).click()
    await page.getByLabel('创建一个新的空间').fill('不应创建')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible()
    expect(
      JSON.parse(await readFile(join(directory, 'accounts.json'), 'utf8')).accounts,
    ).toHaveLength(1)
    await page.getByRole('button', { name: '关闭对话框' }).click()
    await expect(page.getByLabel('当前计数')).toHaveText('1')
  } finally {
    await chmod(join(directory, 'accounts'), 0o700)
  }
  await page.getByRole('button', { name: '保存失败 · 点击重试' }).click()
  await expect(page.getByRole('button', { name: '所有更改已保存' })).toBeVisible()
  expect((await readWorkspace()).widgets[0].data.count).toBe(1)
  expect(errors).toEqual([])
})

test('import and export through native dialog IPC, missing component and invalid import', async () => {
  await add('计数器')
  await page.getByRole('button', { name: '增加计数' }).click()
  const exportPath = join(directory, 'export.json')
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
  }, exportPath)
  await page.getByRole('button', { name: '应用设置' }).click()
  await page.getByRole('button', { name: '导出当前账号' }).click()
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(exportPath, 'utf8')).workspace.widgets.length
      } catch {
        return 0
      }
    })
    .toBe(1)
  const data = JSON.parse(await readFile(exportPath, 'utf8'))
  data.workspace.widgets.push({
    id: randomUUID(),
    type: 'future.component',
    version: 1,
    config: { future: true },
    data: { count: 8 },
    layout: { x: 4, y: 0, w: 4, h: 7 },
  })
  await writeFile(exportPath, JSON.stringify(data))
  await page.getByRole('button', { name: '导入账号' }).click()
  await expect(page.getByRole('button', { name: '管理账号' })).toContainText('默认账号 (2)')
  await expect(page.getByText('这个组件尚未安装')).toBeVisible()
  await expect(page.getByLabel('当前计数')).toHaveText('1')
  await page.getByRole('button', { name: '应用设置' }).click()
  await writeFile(exportPath, JSON.stringify({ ...data, schemaVersion: 88 }))
  await page.getByRole('button', { name: '导入账号' }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('更新版本')
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await expect(page.getByText('这个组件尚未安装')).toBeVisible()
  expect(errors).toEqual([])
})
