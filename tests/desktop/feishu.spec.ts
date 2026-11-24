import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication, page: Page, directory: string
const errors: string[] = []
async function add() {
  await page.getByRole('button', { name: '添加组件', exact: true }).click()
  await page
    .locator('.library-card')
    .filter({ has: page.getByRole('heading', { name: '飞书日历', exact: true }) })
    .getByRole('button', { name: '添加', exact: true })
    .click()
}
async function injectMocks() {
  await app.evaluate(({ safeStorage, shell }) => {
    const state = {
      url: '',
      eventCalls: 0,
      failure: 0,
      registrationBegins: 0,
      registrationConfirmed: false,
      grantConfirmed: false,
      browserOpens: 0,
    }
    Object.assign(globalThis, { __feishuTest: state })
    // Test-only boundary replacements in the real Electron process. Production has no bypass.
    safeStorage.isAsyncEncryptionAvailable = async () => true
    safeStorage.encryptStringAsync = async (value) =>
      Buffer.from(Buffer.from(value).map((byte) => byte ^ 0xaa))
    safeStorage.decryptStringAsync = async (value) => ({
      result: Buffer.from(value)
        .map((byte) => byte ^ 0xaa)
        .toString(),
      shouldReEncrypt: false,
    })
    shell.openExternal = async (url) => {
      state.url = url
      state.browserOpens++
    }
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      const reply = (data: unknown) => new Response(JSON.stringify({ code: 0, data }))
      const raw = (data: unknown) => new Response(JSON.stringify(data))
      if (url.endsWith('/oauth/v1/app/registration')) {
        const body = new URLSearchParams(String(init?.body))
        if (body.get('action') === 'begin') {
          state.registrationBegins++
          return raw({
            device_code: 'registration-code',
            user_code: 'CREATE',
            expires_in: 60,
            interval: 1,
          })
        }
        return raw(
          state.registrationConfirmed
            ? {
                client_id: 'cli_created',
                client_secret: 'created-secret-never-export',
                user_info: { tenant_brand: 'feishu' },
              }
            : { error: 'authorization_pending' },
        )
      }
      if (url.endsWith('/oauth/v1/device_authorization')) {
        const scopes = new URLSearchParams(String(init?.body)).get('scope')?.split(' ').sort()
        const allowed = [
          'calendar:calendar.calendar:readonly',
          'calendar:calendar.event:read',
          'contact:user.base:readonly',
          'offline_access',
        ].sort()
        // Model an enterprise that allows event reads but rejects broad/busy permissions.
        if (JSON.stringify(scopes) !== JSON.stringify(allowed))
          return raw({ error: 'invalid_scope' })
        return raw({
          device_code: 'device-code',
          user_code: 'GRANT',
          expires_in: 60,
          interval: 1,
          verification_uri_complete: 'https://accounts.feishu.cn/confirm?code=GRANT',
        })
      }
      if (
        url.endsWith('/oauth/v3/token') &&
        new URLSearchParams(String(init?.body)).get('grant_type') ===
          'urn:ietf:params:oauth:grant-type:device_code' &&
        !state.grantConfirmed
      )
        return raw({ error: 'authorization_pending' })
      if (url === 'https://accounts.feishu.cn/oauth/v3/token')
        return new Response(
          JSON.stringify({
            access_token: 'fake-access',
            refresh_token: 'fake-refresh',
            expires_in: 7200,
            refresh_token_expires_in: 86400,
          }),
        )
      if (url.endsWith('/authen/v1/user_info'))
        return reply({ open_id: 'test-user', name: '日历测试用户' })
      if (url.includes('/calendars/primary?'))
        return reply({
          calendars: [{ calendar: { calendar_id: 'primary', type: 'primary', role: 'owner' } }],
        })
      if (url.includes('/events/instance_view')) {
        state.eventCalls++
        if (state.failure)
          return new Response(JSON.stringify({ code: state.failure }), { status: state.failure })
        const now = new Date(),
          base = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const timed = (id: string, title: string, start: number, end: number) => ({
          event_id: id,
          summary: title,
          start_time: { timestamp: String(Math.floor(start / 1000)) },
          end_time: { timestamp: String(Math.floor(end / 1000)) },
        })
        const items: unknown[] = [
          timed('past', '已完成 · 晨间计划', base.getTime(), base.getTime() + 60000),
          timed('ongoing', '进行中 · 产品讨论', now.getTime() - 60000, now.getTime() + 300000),
          {
            ...timed('next', '下一场 · 设计评审', now.getTime() + 600000, now.getTime() + 2400000),
            attendees: [
              { type: 'resource', display_name: '上海 · 浦江会议室', rsvp_status: 'accept' },
              { type: 'resource', display_name: '北京 · 山海会议室', rsvp_status: 'needs_action' },
              { type: 'user', display_name: '不应显示的参会人' },
            ],
            location: { name: '创作中心', address: '二层' },
          },
        ]
        for (let day = 1; day < 8; day++)
          for (const hour of [10, 14, 17]) {
            const start = new Date(base)
            start.setDate(start.getDate() + day)
            start.setHours(hour)
            items.push(
              timed(
                `day-${day}-${hour}`,
                ['项目同步', '专注时间', '团队复盘'][[10, 14, 17].indexOf(hour)],
                start.getTime(),
                start.getTime() + 3600000,
              ),
            )
          }
        const key = (date: Date) =>
          `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        const tomorrow = new Date(base)
        tomorrow.setDate(tomorrow.getDate() + 1)
        items.push({
          event_id: 'all-day',
          summary: '全天 · 留给创作',
          start_time: { date: key(base) },
          end_time: { date: key(tomorrow) },
        })
        return reply({ items })
      }
      throw new Error('Unexpected test request')
    }
  })
}
async function authorize() {
  await page.getByRole('button', { name: '应用设置' }).click()
  await page.getByRole('button', { name: '高级设置：连接已有应用' }).click()
  await page.getByLabel('飞书 App ID', { exact: true }).fill('cli_test')
  await page.getByLabel('飞书 App Secret', { exact: true }).fill('test-secret-never-export')
  await page.getByRole('button', { name: '保存应用配置' }).click()
  await page.getByRole('button', { name: '授权连接飞书' }).click()
  await expect
    .poll(() =>
      app.evaluate(
        () => (globalThis as unknown as { __feishuTest: { url: string } }).__feishuTest.url,
      ),
    )
    .toContain('/open-apis/authen/v1/authorize?')
  const url = await app.evaluate(
    () => (globalThis as unknown as { __feishuTest: { url: string } }).__feishuTest.url,
  )
  const state = new URL(url).searchParams.get('state')!
  expect(new URL(url).searchParams.get('scope')?.split(' ')).toEqual([
    'calendar:calendar.calendar:readonly',
    'calendar:calendar.event:read',
    'contact:user.base:readonly',
    'offline_access',
  ])
  return async () => {
    const reply = await fetch(
      `http://127.0.0.1:43821/oauth/feishu/callback?state=${encodeURIComponent(state)}&code=fake-code`,
    )
    expect(reply.status).toBe(200)
    await reply.text()
  }
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-feishu-desktop-'))
  errors.length = 0
  app = await electron.launch({
    args: [process.env.WORKSPACE_TEST_APP ?? resolve('out/main/index.js')],
    executablePath: process.env.WORKSPACE_TEST_EXECUTABLE,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', WORKSPACE_DATA_DIR: directory },
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('heading', { name: '我的工作区.' })).toBeVisible()
  await injectMocks()
})
test.afterEach(async () => {
  await app?.close().catch(() => {})
  await rm(directory, { recursive: true, force: true })
})

test('one-click creates an app, resumes cancelled consent without creating another, and reads the calendar', async () => {
  await add()
  await page.getByRole('button', { name: '应用设置' }).click()
  await expect(page.getByLabel('飞书 App ID', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('飞书 App Secret', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '一键连接飞书', exact: true }).click()
  await expect(page.getByText('① 确认创建应用', { exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/feishu-one-click-setup.png' })
  await page.getByRole('button', { name: '重新打开飞书确认页' }).click()
  expect(
    await app.evaluate(
      () =>
        (globalThis as unknown as { __feishuTest: { browserOpens: number } }).__feishuTest
          .browserOpens,
    ),
  ).toBe(2)
  await app.evaluate(() => {
    ;(
      globalThis as unknown as { __feishuTest: { registrationConfirmed: boolean } }
    ).__feishuTest.registrationConfirmed = true
  })
  await expect(page.getByText('② 授权读取日历', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '取消授权', exact: true }).click()
  await expect(page.getByRole('button', { name: '授权连接飞书', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '授权连接飞书', exact: true }).click()
  await expect(page.getByText('② 授权读取日历', { exact: true })).toBeVisible()
  await app.evaluate(() => {
    ;(
      globalThis as unknown as { __feishuTest: { grantConfirmed: boolean } }
    ).__feishuTest.grantConfirmed = true
  })
  await expect(page.getByRole('dialog')).toContainText('日历测试用户')
  expect(
    await app.evaluate(
      () =>
        (globalThis as unknown as { __feishuTest: { registrationBegins: number } }).__feishuTest
          .registrationBegins,
    ),
  ).toBe(1)
  const index = JSON.parse(await readFile(join(directory, 'accounts.json'), 'utf8'))
  const vault = await readFile(
    join(directory, 'connections/feishu', index.activeAccountId + '.json'),
    'utf8',
  )
  expect(vault).not.toMatch(/created-secret|fake-access|fake-refresh/)
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await expect(page.locator('.calendar-event.is-next')).toContainText('设计评审')
  expect(errors).toEqual([])
})

test('calendar OAuth follows its original account, shares connections, exports no secrets and disconnects all instances', async () => {
  await add()
  await add()
  const cards = page.getByRole('article', { name: '飞书日历', exact: true })
  await expect(cards).toHaveCount(2)
  await expect(cards.first().getByRole('button', { name: '连接飞书', exact: true })).toBeVisible()
  const complete = await authorize()
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await page.getByRole('button', { name: '管理账号' }).click()
  await page.getByLabel('创建一个新的空间').fill('另一工作区')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await add()
  await complete()
  await expect(cards.first().getByRole('button', { name: '连接飞书', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '管理账号' }).click()
  await page.getByRole('button', { name: '默认账号 点击切换工作区' }).click()
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await expect(cards.first().locator('.calendar-event.is-next')).toContainText('设计评审')
  await expect(cards.nth(1).locator('.calendar-event.is-next')).toContainText('设计评审')
  expect(
    await app.evaluate(
      () =>
        (globalThis as unknown as { __feishuTest: { eventCalls: number } }).__feishuTest.eventCalls,
    ),
  ).toBe(1)
  await cards.first().screenshot({ path: 'test-results/feishu-calendar.png' })
  await expect(cards.first().locator('.calendar-event.is-past')).toContainText('晨间计划')
  await expect(
    cards
      .first()
      .locator('.calendar-event')
      .filter({ hasText: '进行中 · 产品讨论' })
      .locator('.calendar-event-tag'),
  ).toHaveText('TODAY')
  expect(
    await cards
      .first()
      .locator('.calendar-scroll')
      .evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true)
  await page.getByRole('button', { name: '应用设置' }).click()
  await expect(page.getByRole('dialog')).toContainText('日历测试用户')
  const exported = join(directory, 'export.json')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
  }, exported)
  await page.getByRole('button', { name: '导出当前账号' }).click()
  await expect
    .poll(async () => {
      try {
        return (await readFile(exported, 'utf8')).length
      } catch {
        return 0
      }
    })
    .toBeGreaterThan(0)
  const content = await readFile(exported, 'utf8')
  expect(content).not.toMatch(/test-secret|fake-access|fake-refresh|设计评审|日历测试用户/)
  await page.getByRole('button', { name: '导入账号', exact: true }).click()
  await expect(page.getByRole('button', { name: '管理账号' })).toContainText('默认账号 (2)')
  await expect(cards.first().getByRole('button', { name: '连接飞书', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '管理账号' }).click()
  await page.getByRole('button', { name: '默认账号 点击切换工作区' }).click()
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await page.getByRole('button', { name: '应用设置' }).click()
  await page.getByRole('button', { name: '断开连接', exact: true }).click()
  await page.getByRole('button', { name: '确认断开飞书' }).click()
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await expect(cards.first().getByRole('button', { name: '连接飞书', exact: true })).toBeVisible()
  await expect(cards.nth(1).getByRole('button', { name: '连接飞书', exact: true })).toBeVisible()
  await expect(page.getByText('设计评审', { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('calendar shows relative tags and hover details with rooms, keyboard access and no clipping', async () => {
  await add()
  const complete = await authorize()
  await complete()
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 720))
  const card = page.getByRole('article', { name: '飞书日历', exact: true })
  const tags = await card.locator('.calendar-event-tag').allTextContents()
  expect(tags).toContain('TODAY')
  expect(tags).toContain('NEXT')
  expect(tags).toContain('TOMORROW')
  expect(tags.every((tag) => ['TODAY', 'NEXT', 'TOMORROW'].includes(tag))).toBe(true)
  await expect(card.locator('.calendar-day').nth(2).locator('.calendar-event-tag')).toHaveCount(0)
  const row = card.locator('.calendar-event.is-next')
  await row.hover()
  const detail = page.getByRole('tooltip')
  await expect(detail).toContainText('下一场 · 设计评审')
  await expect(detail).toContainText('上海 · 浦江会议室')
  await expect(detail).toContainText('北京 · 山海会议室（预约中）')
  await expect(detail).toContainText('地点：创作中心 · 二层')
  await expect(detail).toContainText(/\d{2}:\d{2}–\d{2}:\d{2}|\d{2}:\d{2} — /)
  await expect(detail).not.toContainText('不应显示的参会人')
  const bounds = (await detail.boundingBox())!
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height)
  await detail.hover()
  await expect(detail).toBeVisible()
  await page.screenshot({ path: 'test-results/feishu-calendar-details.png' })
  await page.mouse.move(5, 5)
  await expect(detail).toHaveCount(0)
  await row.focus()
  await expect(detail).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(detail).toHaveCount(0)
  const allDay = card.locator('.calendar-event').filter({ hasText: '全天 · 留给创作' })
  await allDay.hover()
  await expect(detail).toContainText('全天')
  await expect(detail).toContainText('飞书未提供会议室信息')
  await card.locator('.calendar-scroll').evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(detail).toHaveCount(0)
  const last = card.locator('.calendar-event').last()
  await last.hover()
  await expect(detail).toBeVisible()
  await page.getByRole('button', { name: '应用设置' }).click()
  await expect(detail).toHaveCount(0)
  expect(errors).toEqual([])
})

test('calendar fits the minimum window and card, retains editing controls and shows authorization loss', async () => {
  await add()
  const complete = await authorize()
  await complete()
  await page.getByRole('button', { name: '关闭对话框' }).click()
  const card = page.getByRole('article', { name: '飞书日历', exact: true })
  await expect(card.locator('.calendar-event.is-next')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 720))
  await page.getByRole('button', { name: '编辑布局', exact: true }).click()
  await expect(card.locator('.drag-handle')).toBeVisible()
  await expect(card.getByRole('button', { name: '移除组件' })).toBeVisible()
  const handle = card.locator('..').locator('.react-resizable-handle')
  await handle.scrollIntoViewIfNeeded()
  await handle.hover()
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + 12, box.y + 12)
  await page.mouse.down()
  await page.mouse.move(box.x - 120, box.y - 300, { steps: 20 })
  await page.mouse.up()
  await page.getByRole('button', { name: '完成编辑' }).click()
  await expect
    .poll(async () => {
      const index = JSON.parse(await readFile(join(directory, 'accounts.json'), 'utf8'))
      const workspace = JSON.parse(
        await readFile(join(directory, 'accounts', index.activeAccountId + '.json'), 'utf8'),
      )
      return workspace.widgets[0].layout.h
    })
    .toBe(8)
  await expect(card.locator('.widget-header')).toHaveCount(0)
  expect(
    await card.locator('.calendar-scroll').evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await card.screenshot({ path: 'test-results/feishu-calendar-minimum.png' })
  await app.evaluate(() => {
    ;(globalThis as unknown as { __feishuTest: { failure: number } }).__feishuTest.failure = 401
  })
  await card.getByRole('button', { name: '刷新飞书日历' }).click()
  await expect(card.getByText('请重新授权飞书', { exact: true })).toBeVisible()
  await expect(card.locator('.calendar-event')).toHaveCount(0)
  expect(errors).toEqual([])
})
