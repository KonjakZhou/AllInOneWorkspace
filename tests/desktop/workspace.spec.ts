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
  await page.getByRole('button', { name: '为工作区再添一点可能', exact: true }).click()
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
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 960),
  )
  await expect.poll(() => page.evaluate(() => innerHeight)).toBeGreaterThan(900)
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
  // The compact header lets one row fit without scrolling. Use the expanded,
  // rearranged layout to verify that the window controls stay clear on scroll.
  await expect.poll(() => page.evaluate(() => innerHeight)).toBe(720)
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
  await expect
    .poll(() =>
      page.evaluate(() => {
        const titlebar = document.querySelector<HTMLElement>('.titlebar')!
        const style = getComputedStyle(titlebar)
        return {
          scrolled: scrollY > 0,
          top: titlebar.getBoundingClientRect().top,
          height: titlebar.getBoundingClientRect().height,
          position: style.position,
          background: style.backgroundColor,
        }
      }),
    )
    .toEqual({
      scrolled: true,
      top: 0,
      height: 52,
      position: 'sticky',
      background: 'rgba(244, 243, 239, 0.92)',
    })
  await page.screenshot({ path: 'test-results/workspace-titlebar-safe-area.png' })
  await page.evaluate(() => scrollTo(0, 0))
  await page.screenshot({ path: 'test-results/workspace-minimum-window.png', fullPage: true })
  expect(errors).toEqual([])
})

test('dragging over a card aligns the occupied card with the dragged lower edge', async () => {
  await add('文本卡片')
  await add('计数器')
  const movingCard = page.getByRole('article', { name: '文本卡片', exact: true })
  const occupiedCard = page.getByRole('article', { name: '计数器', exact: true })
  await page.getByRole('button', { name: '编辑布局', exact: true }).click()
  const movingHandle = movingCard.locator('.drag-handle')
  const occupiedHandle = occupiedCard.locator('.drag-handle')
  const startBox = (await movingHandle.boundingBox())!
  const targetBox = (await occupiedHandle.boundingBox())!
  await page.mouse.move(startBox.x + startBox.width / 2, startBox.y + startBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
    steps: 20,
  })
  await page.mouse.up()

  await expect
    .poll(async () => {
      const [moving, occupied] = (await readWorkspace()).widgets
      if (!moving || !occupied) return null
      return {
        movingX: moving.layout.x,
        occupiedX: occupied.layout.x,
        gap: occupied.layout.y - (moving.layout.y + moving.layout.h),
      }
    })
    .toEqual({ movingX: 4, occupiedX: 4, gap: 0 })
  await expect(page.getByRole('alert')).toHaveCount(0)
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

test('card removal keeps independent records, restores a chosen copy, and deletes only the selected data', async () => {
  const topAdd = page.locator('.toolbar').getByRole('button', { name: '添加组件', exact: true })
  await expect(topAdd).toHaveCount(0)
  await expect(page.getByRole('button', { name: '为工作区再添一点可能' })).toBeVisible()
  await add('计数器')
  await add('计数器')
  const counters = () => page.getByRole('article', { name: '计数器', exact: true })
  await counters().nth(0).getByRole('button', { name: '增加计数' }).click({ clickCount: 3 })
  await counters().nth(1).getByRole('button', { name: '增加计数' }).click({ clickCount: 5 })
  await counters().nth(0).getByRole('button', { name: '组件设置' }).click()
  await page.getByLabel('计数器标题').fill('读书进度')
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await page.getByRole('button', { name: '编辑布局', exact: true }).click()
  await expect(topAdd).toBeVisible()
  await topAdd.click()
  await expect(page.getByRole('dialog')).toContainText('全部组件')
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await counters().nth(0).getByRole('button', { name: '移除组件' }).click()
  await expect(page.getByRole('radio', { name: /仅移除卡片，保留数据/ })).toBeChecked()
  await page.getByLabel('记录名称', { exact: false }).fill('阅读计划')
  await page.screenshot({ path: 'test-results/remove-card-modes.png' })
  await page.getByRole('button', { name: '移除并保留记录' }).click()
  await expect(counters()).toHaveCount(1)
  await expect(counters().first().getByLabel('当前计数')).toHaveText('5')
  await counters().first().getByRole('button', { name: '移除组件' }).click()
  await page.getByLabel('记录名称', { exact: false }).fill('运动计划')
  await page.getByRole('button', { name: '移除并保留记录' }).click()
  await close()
  await launch()
  expect((await readWorkspace()).savedWidgets.map((item: { name: string }) => item.name)).toEqual([
    '阅读计划',
    '运动计划',
  ])
  await expect(
    page.locator('.toolbar').getByRole('button', { name: '添加组件', exact: true }),
  ).toHaveCount(0)
  await add('计数器')
  const reading = page.getByRole('region', { name: '本地记录：阅读计划', exact: true })
  const exercise = page.getByRole('region', { name: '本地记录：运动计划', exact: true })
  await expect(reading).toBeVisible()
  await expect(exercise).toBeVisible()
  await page.screenshot({ path: 'test-results/restore-card-records.png' })
  // Choosing a new card leaves both retained copies untouched.
  await page.getByRole('button', { name: '添加全新卡片' }).click()
  await expect(counters().first().getByLabel('当前计数')).toHaveText('0')
  await add('计数器')
  await reading.getByRole('button', { name: '恢复这份记录' }).click()
  await expect(counters()).toHaveCount(2)
  await expect(counters().nth(1).getByRole('heading', { name: '读书进度' })).toBeVisible()
  await expect(counters().nth(1).getByLabel('当前计数')).toHaveText('3')
  await add('计数器')
  await expect(reading).toHaveCount(0)
  await exercise.getByRole('button', { name: '删除记录：运动计划' }).click()
  await exercise.getByRole('button', { name: '保留记录' }).click()
  await expect(exercise).toBeVisible()
  await exercise.getByRole('button', { name: '删除记录：运动计划' }).click()
  await exercise.getByRole('button', { name: '确认删除记录' }).click()
  await expect(page.getByText('暂无保留的记录。', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await page.getByRole('button', { name: '编辑布局', exact: true }).click()
  await counters().nth(1).getByRole('button', { name: '移除组件' }).click()
  await page.getByRole('radio', { name: /删除卡片及其设置和数据/ }).check()
  await page.getByRole('button', { name: '删除卡片和数据' }).click()
  await page.getByRole('button', { name: '完成编辑' }).click()
  await expect(counters()).toHaveCount(1)
  await close()
  await launch()
  const doc = await readWorkspace()
  expect(doc.savedWidgets).toEqual([])
  expect(doc.widgets).toHaveLength(1)
  expect(doc.widgets[0].data).toEqual({ count: 0 })
  const backup = JSON.parse(
    await readFile(join(directory, 'accounts', doc.accountId + '.json.bak'), 'utf8'),
  )
  expect(backup.savedWidgets).toEqual([])
  expect(backup.widgets).toHaveLength(1)
  expect(errors).toEqual([])
})

test('saved records follow account boundaries and are included in account export and import', async () => {
  await add('文本卡片')
  await page.getByRole('button', { name: '组件设置' }).click()
  await page.getByLabel('正文').fill('只属于这个账号的灵感')
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await page.getByRole('button', { name: '编辑布局', exact: true }).click()
  await page.getByRole('button', { name: '移除组件' }).click()
  await page.getByLabel('记录名称', { exact: false }).fill('灵感收藏')
  await page.getByRole('button', { name: '移除并保留记录' }).click()
  await page.getByRole('button', { name: '完成编辑' }).click()
  const exportPath = join(directory, 'retained-export.json')
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
  }, exportPath)
  await page.getByRole('button', { name: '应用设置' }).click()
  await page.getByRole('button', { name: '导出当前账号' }).click()
  await expect(page.getByRole('dialog')).toContainText('账号已导出')
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await page.getByRole('button', { name: '管理账号' }).click()
  await page.getByLabel('创建一个新的空间').fill('独立空间')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect(page.locator('.account-row.selected')).toContainText('独立空间')
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await add('文本卡片')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect((await readWorkspace()).savedWidgets).toEqual([])
  await page.getByRole('button', { name: '应用设置' }).click()
  await page.getByRole('button', { name: '导入账号' }).click()
  await expect(page.getByRole('button', { name: '管理账号' })).toContainText('默认账号 (2)')
  await add('文本卡片')
  await page
    .getByRole('region', { name: '本地记录：灵感收藏' })
    .getByRole('button', { name: '恢复这份记录' })
    .click()
  await expect(page.getByText('只属于这个账号的灵感', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '管理账号' }).click()
  await page.getByRole('button', { name: '默认账号 点击切换工作区' }).click()
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await add('文本卡片')
  await expect(page.getByRole('region', { name: '本地记录：灵感收藏' })).toBeVisible()
  expect(errors).toEqual([])
})
