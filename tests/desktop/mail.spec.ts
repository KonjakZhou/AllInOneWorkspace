import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  mailSetupGuides,
  type MailAccount,
  type MailFilter,
  type MailPage,
} from '../../src/shared/mail'

let app: ElectronApplication
let page: Page
let directory: string
const errors: string[] = []

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-mail-desktop-'))
  errors.length = 0
  app = await electron.launch({
    args: [process.env.WORKSPACE_TEST_APP ?? resolve('out/main/index.js')],
    executablePath: process.env.WORKSPACE_TEST_EXECUTABLE,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', WORKSPACE_DATA_DIR: directory },
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('heading', { name: '我的工作区.' })).toBeVisible()
  await app.evaluate(({ clipboard, safeStorage, shell }) => {
    const state = {
      url: '',
      keyword: '',
      writes: 0,
      readAttempts: 0,
      seen: new Set<string>(),
      failedDetails: new Set<string>(),
      failedReads: new Set<string>(),
    }
    Object.assign(globalThis, { __mailTest: state })
    safeStorage.isAsyncEncryptionAvailable = async () => true
    safeStorage.encryptStringAsync = async (value) =>
      Buffer.from(Buffer.from(value).map((byte) => byte ^ 0xaa))
    safeStorage.decryptStringAsync = async (value) => ({
      result: Buffer.from(Buffer.from(value).map((byte) => byte ^ 0xaa)).toString(),
      shouldReEncrypt: false,
    })
    shell.openExternal = async (url) => {
      state.url = url
    }
    clipboard.writeText = async (value) => {
      state.keyword = value
    }
    const installedFetch = globalThis.fetch
    const now = Date.now()
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      const reply = (data: unknown) => Response.json({ code: 0, data })
      if (url.href === 'https://accounts.feishu.cn/oauth/v3/token') {
        const { code } = JSON.parse(String(init?.body))
        return Response.json({
          access_token: code,
          refresh_token: 'rotating-' + code,
          expires_in: 7200,
          refresh_token_expires_in: 86400,
        })
      }
      if (url.hostname !== 'open.feishu.cn' || !url.pathname.includes('/mail/v1/'))
        return installedFetch(input, init)
      const identity = String(new Headers(init?.headers).get('authorization')).replace(
        'Bearer ',
        '',
      )
      const dates = Object.fromEntries(
        Array.from({ length: 65 }, (_, i) => [String(i).padStart(2, '0'), now - 3000 - 60000 * i]),
      )
      dates.sent = now - 5000
      const createMessage = (id: string) => ({
        message_id: id,
        subject: identity + ' 测试邮件 ' + id,
        internal_date: String(dates[id]),
        from: { name: '发件人', mail_address: 'sender@example.com' },
        to: [{ name: '收件人', mail_address: 'recipient@example.com' }],
        label_ids: id === 'sent' || state.seen.has(identity + id) ? [] : ['UNREAD'],
        folder_id: id === 'sent' ? 'SENT' : 'INBOX',
        body_preview: Buffer.from('邮件摘要 ' + id).toString('base64url'),
        body_plain_text: Buffer.from('完整的正文 ' + id).toString('base64url'),
      })
      const all =
        identity === 'second'
          ? ['00']
          : Object.keys(dates)
              .filter((id) => id !== 'sent')
              .sort()
      if (url.pathname.endsWith('/profile'))
        return reply({ primary_email_address: identity + '@example.com' })
      if (url.pathname.endsWith('/search')) {
        const { filter } = JSON.parse(String(init?.body))
        const ids = (filter.folder[0] === 'sent' ? ['sent'] : all).filter(
          (id) =>
            dates[id] >= Date.parse(filter.create_time.start_time) &&
            dates[id] <= Date.parse(filter.create_time.end_time),
        )
        const offset = Number(url.searchParams.get('page_token') || '0')
        const limit = offset + 15
        return reply({
          items: ids.slice(offset, limit).map((id) => ({ id })),
          has_more: limit < ids.length,
          page_token: String(limit),
        })
      }
      if (url.pathname.endsWith('/messages')) {
        const ids = url.searchParams.get('folder_id') === 'SENT' ? ['sent'] : all
        return reply({ items: ids.slice(0, 20), has_more: ids.length > 20, page_token: '20' })
      }
      if (url.pathname.endsWith('/batch_get')) {
        const { message_ids } = JSON.parse(String(init?.body))
        return reply({ messages: message_ids.map(createMessage) })
      }
      const parts = url.pathname.split('/')
      if (parts.at(-1) === 'batch_modify') {
        const {
          message_ids,
          remove_label_ids,
        }: { message_ids: string[]; remove_label_ids: string[] } = JSON.parse(String(init?.body))
        state.readAttempts++
        if (remove_label_ids[0] !== 'UNREAD') return Response.json({ code: 400 })
        if (message_ids.some((id) => state.failedReads.has(id))) return Response.json({ code: 400 })
        state.writes++
        for (const id of message_ids) state.seen.add(identity + id)
        return reply({})
      }
      const id = parts.at(-1)!
      if (state.failedDetails.has(id)) return Response.json({ code: 400 })
      return reply({ message: createMessage(id) })
    }
  })
})

test.afterEach(async () => {
  await app?.close().catch(() => {})
  await rm(directory, { recursive: true, force: true })
})

async function choose(owner: Page | Locator, label: string, option: string) {
  await owner.getByRole('button', { name: label, exact: true }).click()
  await owner
    .getByRole('listbox', { name: label })
    .getByRole('option', { name: option, exact: true })
    .click()
}

async function authorize(owner: Page | Locator, identity: string) {
  await owner.getByRole('button', { name: '添加邮箱账户', exact: true }).click()
  const dialog = owner.getByRole('dialog')
  await choose(dialog, '连接方式', '自建飞书应用')
  await dialog.getByLabel('App ID', { exact: true }).fill('cli_test')
  await dialog.getByLabel('App Secret', { exact: true }).fill('secret')
  const capture = () =>
    app.evaluate(() => (globalThis as unknown as { __mailTest: { url: string } }).__mailTest.url)
  const previous = await capture()
  await dialog.getByRole('button', { name: '连接邮箱', exact: true }).click()
  await expect.poll(capture).not.toBe(previous)
  const authorization = new URL(await capture())
  expect(authorization.searchParams.get('scope')).toContain('mail:user_mailbox.message:modify')
  const callback = new URL(authorization.searchParams.get('redirect_uri')!)
  callback.searchParams.set('state', authorization.searchParams.get('state')!)
  callback.searchParams.set('code', identity)
  expect((await fetch(callback)).status).toBe(200)
  await expect(dialog.getByText(identity + '@example.com', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '关闭对话框' }).click()
}

test('邮件在同一窗口打开正文后自动标为已读，并保留筛选和滚动位置', async ({}, testInfo) => {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1100, 720)
  })
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1100)
  await page.getByRole('button', { name: '为工作区再添一点可能', exact: true }).click()
  await page
    .locator('.library-card')
    .filter({ has: page.getByRole('heading', { name: '邮箱', exact: true }) })
    .getByRole('button', { name: '添加', exact: true })
    .click()
  await authorize(page, 'first')
  const card = page.getByRole('article', { name: '邮箱', exact: true })
  const cardList = card.getByRole('region', { name: '邮件列表' })
  await expect(card.getByText('邮件摘要 00', { exact: true })).toBeVisible()

  const readRow = card.getByRole('button', { name: /first 测试邮件 00/ })
  const folders = card.getByRole('button', { name: '邮件类型' })
  const accounts = card.getByRole('button', { name: '邮箱账号' })
  for (const control of [accounts, folders]) {
    const inset = await control.evaluate(
      (button) =>
        button.getBoundingClientRect().right -
        button.querySelector('svg')!.getBoundingClientRect().right,
    )
    expect(inset).toBeGreaterThanOrEqual(12)
  }
  await folders.press('ArrowDown')
  const cardMenu = card.getByRole('listbox', { name: '邮件类型' })
  await expect(cardMenu).toBeVisible()
  await expect(cardMenu.getByRole('option', { name: '全部邮件' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await cardMenu.getByRole('option', { name: '全部邮件' }).press('End')
  await expect(cardMenu.getByRole('option', { name: '发件' })).toBeFocused()
  await cardMenu.getByRole('option', { name: '发件' }).press('ArrowUp')
  await cardMenu.getByRole('option', { name: '未读' }).press('Enter')
  await expect(folders).toBeFocused()
  await expect(readRow).toBeVisible()
  await testInfo.attach('邮件卡片', {
    body: await card.screenshot(),
    contentType: 'image/png',
  })

  const url = page.url()
  await readRow.press('Enter')
  const mail = page.locator('.mail-page')
  const back = mail.getByRole('button', { name: '返回工作区' })
  await expect(back).toBeFocused()
  await expect(mail.getByRole('button', { name: '邮件类型' })).toHaveText('未读')
  await expect(mail.getByRole('heading', { name: 'first 测试邮件 00' })).toBeVisible()
  await expect(mail.getByText('完整的正文 00')).toBeVisible()
  const reply = mail.getByRole('button', { name: '在邮箱中回复', exact: true })
  await reply.hover()
  await expect(reply.getByText('打开邮箱并复制搜索关键词，找到原邮件后回复')).toBeVisible()
  await reply.click()
  await expect(mail.getByText('已打开邮箱并复制搜索关键词，请粘贴搜索后回复。')).toBeVisible()
  expect(
    await app.evaluate(() => {
      const { url, keyword } = Reflect.get(globalThis, '__mailTest')
      return { url, keyword }
    }),
  ).toEqual({ url: 'https://web.feishu.cn/mail', keyword: 'first 测试邮件 00' })
  await expect(mail.locator('.mail-row').filter({ hasText: 'first 测试邮件 00' })).toHaveCount(0)
  await expect
    .poll(() =>
      app.evaluate(
        () => (globalThis as unknown as { __mailTest: { writes: number } }).__mailTest.writes,
      ),
    )
    .toBe(1)
  await expect(mail.getByText('完整的正文 00')).toBeVisible()
  const markRead = mail
    .locator('.mail-row')
    .filter({ hasText: 'first 测试邮件 01' })
    .getByRole('button', { name: '标为已读' })
  const hint = markRead.getByText('标为已读', { exact: true })
  await expect(hint).toBeHidden()
  await markRead.hover()
  await expect(hint).toBeVisible()
  await expect(hint).toBeInViewport()
  await mail.getByRole('heading', { name: 'first 测试邮件 00' }).hover()
  await expect(hint).toBeHidden()
  await expect(page.locator('.workspace-behind-detail')).toHaveAttribute('inert', '')
  expect(page.url()).toBe(url)
  expect(app.windows()).toHaveLength(1)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1100)
  expect(await page.locator('.titlebar:visible').count()).toBe(1)

  await mail.getByRole('button', { name: '邮箱账号' }).press('Tab')
  await expect(mail.getByRole('button', { name: '邮件类型' })).toBeFocused()
  expect(
    await mail
      .getByRole('button', { name: '邮件类型' })
      .evaluate((control) => control.matches(':focus-visible')),
  ).toBe(true)
  await testInfo.attach('主窗口内的邮件详情', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })

  await back.press('Enter')
  await expect(mail).toBeHidden()
  await expect(card.getByText('first 测试邮件 00', { exact: true })).toHaveCount(0)
  const viewAll = card.getByRole('button', { name: '查看全部' })
  await expect(viewAll).toBeFocused()

  await choose(card, '邮件类型', '发件')
  await choose(card, '邮箱账号', 'first@example.com')
  await viewAll.click()
  await expect(mail.getByRole('button', { name: '邮件类型' })).toHaveText('发件')
  await expect(mail.getByRole('button', { name: '邮箱账号' })).toHaveText('first@example.com')
  await expect(mail.getByText('选择一封邮件查看详情')).toBeVisible()
  await expect(mail.getByText('first 测试邮件 sent', { exact: true })).toBeVisible()

  await authorize(mail, 'second')
  await choose(mail, '邮件类型', '未读')
  await choose(mail, '邮箱账号', 'second@example.com')
  await expect(mail.getByText('second 测试邮件 00', { exact: true })).toBeVisible()
  await expect(mail.locator('.mail-row').filter({ hasText: 'first 测试邮件' })).toHaveCount(0)
  await back.click()
  await expect(viewAll).toBeFocused()
  await choose(card, '邮件类型', '收件')
  await expect(card.getByText('first 测试邮件 01', { exact: true })).toBeVisible()
  await viewAll.click()
  const fullList = mail.getByRole('region', { name: '邮件列表' })
  await expect(fullList.getByRole('button', { name: /first 测试邮件 01/ })).toBeAttached()
  // The detail view has its own loaded pagination, independent of how far the card has been scrolled.
  await fullList.evaluate((element) => element.scrollTo(0, element.scrollHeight))
  const fullOldRow = fullList.getByRole('button', { name: /first 测试邮件 64/ })
  await expect(fullOldRow).toBeAttached()
  const loadedCount = await fullList.locator('.mail-row').count()
  expect(loadedCount).toBeGreaterThan(50)
  await back.click()
  await expect(mail).toBeHidden()
  await card.getByRole('button', { name: /first 测试邮件 01/ }).click()
  await expect(mail.getByRole('heading', { name: 'first 测试邮件 01' })).toBeVisible()
  await expect(fullList.locator('.mail-row')).toHaveCount(loadedCount)
  await expect(fullOldRow).toBeAttached()
  await back.click()

  await cardList.evaluate((element) => element.scrollTo(0, element.scrollHeight))
  const oldRow = card.getByRole('button', { name: /first 测试邮件 64/ })
  await expect(oldRow).toBeAttached()
  await oldRow.scrollIntoViewIfNeeded()
  const scrollTop = await cardList.evaluate((element) => element.scrollTop)
  expect(scrollTop).toBeGreaterThan(0)
  await oldRow.click()
  await expect(mail.getByRole('heading', { name: 'first 测试邮件 64' })).toBeVisible()
  await expect(mail.getByRole('button', { name: /first 测试邮件 64/ })).toHaveAttribute(
    'aria-current',
    'true',
  )
  await back.click()
  await expect(oldRow).toBeFocused()
  const returned = await cardList.evaluate((element) => ({
    top: element.scrollTop,
    bottom: element.scrollHeight - element.clientHeight,
  }))
  const rowHeight = (await oldRow.boundingBox())!.height
  // An exhausted history request can remove the trailing “查看更早邮件” control.
  expect(Math.abs(returned.top - Math.min(scrollTop, returned.bottom))).toBeLessThan(rowHeight)
  expect(app.windows()).toHaveLength(1)
  expect(errors).toEqual([])
})

test('正文失败时保留未读，服务器拒绝自动已读后可手动重试', async () => {
  type ReadFixture = {
    failedDetails: Set<string>
    failedReads: Set<string>
    readAttempts: number
    writes: number
  }
  await app.evaluate(() => {
    const state: ReadFixture = Reflect.get(globalThis, '__mailTest')
    state.failedDetails.add('00')
    state.failedReads.add('01')
  })
  const readCounts = () =>
    app.evaluate(() => {
      const { readAttempts, writes }: ReadFixture = Reflect.get(globalThis, '__mailTest')
      return { readAttempts, writes }
    })
  await page.getByRole('button', { name: '为工作区再添一点可能', exact: true }).click()
  await page
    .locator('.library-card')
    .filter({ has: page.getByRole('heading', { name: '邮箱', exact: true }) })
    .getByRole('button', { name: '添加', exact: true })
    .click()
  const card = page.getByRole('article', { name: '邮箱', exact: true })
  await authorize(card, 'first')
  await card.getByRole('button', { name: '查看全部' }).click()
  const mail = page.locator('.mail-page')

  const broken = mail.locator('.mail-row').filter({ hasText: 'first 测试邮件 00' })
  await broken.getByRole('button', { name: /first 测试邮件 00/ }).click()
  await expect(mail.locator('.mail-detail').getByRole('alert')).toContainText('飞书无法读取')
  await expect(broken.getByRole('button', { name: '标为已读' })).toBeVisible()
  expect(await readCounts()).toEqual({ readAttempts: 0, writes: 0 })

  const unread = mail.locator('.mail-row').filter({ hasText: 'first 测试邮件 01' })
  await unread.getByRole('button', { name: /first 测试邮件 01/ }).click()
  const detail = mail.getByRole('region', { name: '邮件详情' })
  await expect(detail.getByText('完整的正文 01')).toBeVisible()
  await expect(detail.getByRole('alert')).toContainText('未能标为已读')
  await expect(unread.getByRole('button', { name: '标为已读' })).toBeVisible()
  expect(await readCounts()).toEqual({ readAttempts: 1, writes: 0 })

  await app.evaluate(() => {
    const state: ReadFixture = Reflect.get(globalThis, '__mailTest')
    state.failedReads.delete('01')
  })
  await detail.getByRole('button', { name: '重试标为已读' }).click()
  await expect(detail.getByRole('alert')).toHaveCount(0)
  await expect(unread.getByRole('button', { name: '标为已读' })).toHaveCount(0)
  expect(await readCounts()).toEqual({ readAttempts: 2, writes: 1 })
})

test('邮箱账号弹窗使用 App 内菜单，支持键盘取消与选择必填的已发送文件夹', async ({}, testInfo) => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('mail:connect')
    ipcMain.handle('mail:connect', (_event, _workspace, input) => {
      Object.assign(globalThis, { __mailConnect: input })
      return {
        ok: true,
        value: input.sentPath ? { connected: true } : { sentFolders: ['已发送', '其他文件夹'] },
      }
    })
  })
  await page.getByRole('button', { name: '为工作区再添一点可能', exact: true }).click()
  const library = page.getByRole('dialog')
  await library
    .locator('.library-card')
    .filter({ has: page.getByRole('heading', { name: '邮箱', exact: true }) })
    .getByRole('button', { name: '添加', exact: true })
    .click()
  const card = page.getByRole('article', { name: '邮箱', exact: true })
  await expect(card.getByRole('button', { name: '邮箱账号' })).toBeDisabled()
  await card.getByRole('button', { name: '添加邮箱账户' }).click()
  const dialog = page.getByRole('dialog', { name: '邮箱账号' })
  await expect(dialog.locator('select')).toHaveCount(0)
  const provider = dialog.getByRole('button', { name: '服务商' })
  const panel = dialog.getByRole('listbox', { name: '服务商' })
  await provider.click()
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('option', { name: '飞书邮箱' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  expect(await panel.evaluate((element) => element.matches(':popover-open'))).toBe(true)
  await testInfo.attach('邮箱服务商下拉菜单', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
  await panel.getByRole('option', { name: '飞书邮箱' }).press('Escape')
  await expect(dialog).toBeVisible()
  await expect(panel).toBeHidden()
  await expect(provider).toBeFocused()
  await provider.press('ArrowDown')
  await panel.getByRole('option', { name: '飞书邮箱' }).press('Tab')
  await expect(panel).toBeHidden()
  const connectionMethod = dialog.getByRole('button', { name: '连接方式' })
  await expect(connectionMethod).toBeFocused()
  await expect(connectionMethod).toHaveText('IMAP 专用密码')
  const openedGuide = () =>
    app.evaluate(() => (globalThis as unknown as { __mailTest: { url: string } }).__mailTest.url)
  const feishuGuide = dialog.getByRole('link', { name: '查看飞书专用密码获取教程' })
  await feishuGuide.press('Enter')
  await expect.poll(openedGuide).toBe(mailSetupGuides.feishuImap)
  await testInfo.attach('飞书邮箱 IMAP 配置', {
    body: await dialog.screenshot(),
    contentType: 'image/png',
  })
  await dialog.getByLabel('飞书邮箱地址').fill('mail@example.com')
  await dialog.getByLabel('客户端专用密码').fill('simulated-password')
  const submit = dialog.getByRole('button', { name: '连接邮箱' })
  const folder = dialog.getByRole('button', { name: '已发送文件夹' })
  await submit.click()
  await expect(folder).toHaveText('请选择')
  await expect(submit).toBeDisabled()
  await choose(dialog, '已发送文件夹', '已发送')
  await submit.click()
  await expect(folder).toHaveCount(0)
  expect(await app.evaluate(() => Reflect.get(globalThis, '__mailConnect'))).toMatchObject({
    provider: 'feishu',
    method: 'imap',
    email: 'mail@example.com',
    sentPath: '已发送',
  })
  await choose(dialog, '连接方式', '飞书快捷授权')
  await dialog.getByRole('link', { name: '查看飞书应用权限申请教程' }).click()
  await expect.poll(openedGuide).toBe(mailSetupGuides.feishuOAuth)

  await choose(dialog, '服务商', '163 邮箱')
  await dialog.getByRole('link', { name: '查看 163 客户端授权码获取教程' }).click()
  await expect.poll(openedGuide).toBe(mailSetupGuides.netease)
  await dialog.getByLabel('163 邮箱地址').fill('test@163.com')
  await dialog.getByLabel('客户端授权码').fill('simulated-password')
  await submit.click()
  await expect(folder).toHaveText('请选择')
  await expect(submit).toBeDisabled()
  await choose(dialog, '已发送文件夹', '已发送')
  await expect(folder).toHaveText('已发送')
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(folder).toHaveCount(0)
  await choose(dialog, '服务商', 'Gmail')
  const gmailGuide =
    'https://developers.google.cn/workspace/guides/create-credentials?hl=zh-cn#desktop-app'
  const tutorial = dialog.getByRole('link', { name: '查看 Gmail 桌面 OAuth 配置教程' })
  await expect(tutorial).toHaveAttribute('href', gmailGuide)
  await tutorial.click()
  await expect.poll(openedGuide).toBe(gmailGuide)
  await expect(submit).toBeDisabled()
})

test('前台邮箱卡片每一分钟检查一次，半分钟不发起自动刷新', async () => {
  await app.evaluate(({ ipcMain }) => {
    const account = {
      id: '4b5756b3-6ef8-4f02-9fa8-f2be2109d53f',
      email: 'test@example.com',
      provider: 'feishu',
    }
    const state = { calls: 0 }
    Reflect.set(globalThis, '__mailPolling', state)
    ipcMain.removeHandler('mail:state')
    ipcMain.handle('mail:state', () => ({
      ok: true,
      value: { accounts: [account], gmailConfigured: false, setup: null },
    }))
    ipcMain.removeHandler('mail:list')
    ipcMain.handle('mail:list', () => {
      state.calls++
      return {
        ok: true,
        value: {
          items: [
            {
              account: account.id,
              id: 'one',
              subject: '已加载的邮件',
              time: Date.now(),
              from: [],
              to: [],
              preview: '摘要',
              inbox: true,
              sent: false,
              unread: false,
            },
          ],
          next: null,
          issues: [],
        },
      }
    })
  })
  await page.clock.install({ time: new Date('2026-11-27T04:00:00Z') })
  await page.clock.pauseAt(new Date('2026-11-27T04:00:01Z'))
  await page.evaluate(() => Object.defineProperty(document, 'hasFocus', { value: () => true }))
  await page.getByRole('button', { name: '为工作区再添一点可能', exact: true }).click()
  await page
    .locator('.library-card')
    .filter({ has: page.getByRole('heading', { name: '邮箱', exact: true }) })
    .getByRole('button', { name: '添加', exact: true })
    .click()
  const card = page.getByRole('article', { name: '邮箱', exact: true })
  await expect(card.getByText('已加载的邮件', { exact: true })).toBeVisible()
  await expect(card.getByRole('button', { name: '刷新邮件' })).toBeEnabled()
  const calls = () => app.evaluate(() => Reflect.get(globalThis, '__mailPolling').calls as number)
  const initial = await calls()
  await page.clock.runFor(59999)
  expect(await calls()).toBe(initial)
  await page.clock.runFor(1)
  await expect.poll(calls).toBe(initial + 1)
  expect(errors).toEqual([])
})

test('邮箱卡片的按钮和下拉根据筛选范围内的账号与请求同步切换', async () => {
  type RefreshFixture = {
    workspace: string
    accounts: MailAccount[]
    calls: number
    finish?: () => void
  }
  await app.evaluate(({ ipcMain }) => {
    const state: RefreshFixture = { workspace: '', accounts: [], calls: 0 }
    Reflect.set(globalThis, '__mailRefresh', state)
    ipcMain.removeHandler('mail:state')
    ipcMain.handle('mail:state', (_event, workspace: string) => {
      state.workspace = workspace
      return { ok: true, value: { accounts: state.accounts, gmailConfigured: false, setup: null } }
    })
    ipcMain.removeHandler('mail:list')
    ipcMain.handle('mail:list', async (_event, _workspace, _filter, _cursor, refresh) => {
      if (refresh) {
        state.calls++
        await new Promise<void>((resolve) => {
          state.finish = resolve
        })
        state.finish = undefined
      }
      return { ok: true, value: { items: [], next: null, issues: [] } }
    })
  })
  const changeAccounts = (accounts: MailAccount[]) =>
    app.evaluate(({ BrowserWindow }, accounts) => {
      const state: RefreshFixture = Reflect.get(globalThis, '__mailRefresh')
      state.accounts = accounts
      BrowserWindow.getAllWindows()[0].webContents.send('mail:changed', state.workspace, {
        kind: 'status',
      })
    }, accounts)
  const forcedCalls = () =>
    app.evaluate(() => (Reflect.get(globalThis, '__mailRefresh') as RefreshFixture).calls)
  const finish = () =>
    app.evaluate(() => (Reflect.get(globalThis, '__mailRefresh') as RefreshFixture).finish?.())

  await page.getByRole('button', { name: '为工作区再添一点可能', exact: true }).click()
  await page
    .locator('.library-card')
    .filter({ has: page.getByRole('heading', { name: '邮箱', exact: true }) })
    .getByRole('button', { name: '添加', exact: true })
    .click()
  const card = page.getByRole('article', { name: '邮箱', exact: true })
  const list = card.getByRole('region', { name: '邮件列表' })
  const refresh = card.getByRole('button', { name: '刷新邮件' })
  const spinner = refresh.locator('.spin')
  const pullNotice = list.locator('.mail-pull')
  const pull = () => list.dispatchEvent('wheel', { deltaY: -160, cancelable: true })

  await expect(refresh).toBeDisabled()
  await pull()
  await expect(pullNotice).toHaveCount(0)
  expect(await forcedCalls()).toBe(0)

  const retryable: MailAccount = {
    id: '4b5756b3-6ef8-4f02-9fa8-f2be2109d53f',
    email: 'retryable@163.com',
    provider: 'netease',
    issue: '临时网络故障',
  }
  const expired: MailAccount = {
    id: 'fcdc2434-dd51-495b-8cb6-153f977754af',
    email: 'expired@example.com',
    provider: 'feishu',
    reauthorize: true,
    issue: '此邮箱授权已失效。',
  }
  await changeAccounts([retryable, expired])
  await expect(refresh).toBeEnabled()
  await pull()
  await expect(pullNotice).toHaveText('松手刷新邮件')
  await expect(pullNotice).toHaveText('正在刷新…')
  await expect(refresh).toBeDisabled()
  await expect(spinner).toHaveCount(1)
  expect(await forcedCalls()).toBe(1)
  await finish()
  await expect(pullNotice).toHaveCount(0)
  await expect(spinner).toHaveCount(0)
  await expect(refresh).toBeEnabled()

  await refresh.click()
  await expect.poll(forcedCalls).toBe(2)
  await expect(spinner).toHaveCount(1)
  await pull()
  await expect(pullNotice).toHaveCount(0)
  await finish()
  await expect(refresh).toBeEnabled()

  await choose(card, '邮箱账号', expired.email)
  await expect(card.getByText(expired.issue!, { exact: true })).toBeVisible()
  await expect(refresh).toBeDisabled()
  await pull()
  await expect(pullNotice).toHaveCount(0)
  await choose(card, '邮箱账号', '全部账号')
  await expect(refresh).toBeEnabled()
  await changeAccounts([{ ...retryable, reauthorize: true, issue: '请重新输入授权码。' }, expired])
  await expect(card.getByText('需要重新授权', { exact: true })).toBeVisible()
  await expect(refresh).toBeDisabled()
  await pull()
  await expect(pullNotice).toHaveCount(0)
  await expect(spinner).toHaveCount(0)

  await card.getByRole('button', { name: '查看全部' }).click()
  const mail = page.locator('.mail-page')
  const pageRefresh = mail.getByRole('button', { name: '刷新邮件' })
  await expect(pageRefresh).toBeDisabled()
  await expect(mail.getByText('需要重新授权', { exact: true })).toBeVisible()
  await changeAccounts([retryable, expired])
  await expect(pageRefresh).toBeEnabled()
  await mail.getByRole('button', { name: '返回工作区' }).click()
  await expect(refresh).toBeEnabled()
  expect(await forcedCalls()).toBe(2)
})

test('卡片和邮件页在刷新时保留列表，连接故障提示固定在列表上方', async () => {
  const failure = '飞书邮箱 IMAP 连接或握手超时。'
  await app.evaluate(({ ipcMain }, failure) => {
    const feishu = {
      id: 'bf063dd3-bd8e-4b37-acdd-69d5ccc26e28',
      provider: 'feishu',
      email: 'offline@example.com',
      issue: failure,
    }
    const netease = {
      id: '6396cd97-2dfd-4988-b64d-a6c53cb6f499',
      provider: 'netease',
      email: 'available@163.com',
    }
    const time = Date.now()
    const items = Array.from({ length: 50 }, (_, index) => ({
      account: netease.id,
      id: String(index),
      time: time - index - 1000,
      subject: '163 已缓存邮件 ' + index,
      from: [],
      to: [],
      preview: '缓存摘要',
      inbox: true,
      sent: false,
      unread: false,
    }))
    const older = { ...items[49], id: 'older', time: time - 2000, subject: '163 历史已缓存邮件' }
    const next = { time: time - 1049, key: netease.id + ':49' }
    const unreadItems = items.map((item) => ({ ...item, unread: true }))
    const releases: (() => void)[] = []
    Reflect.set(globalThis, '__mailCacheTest', { releases })
    ipcMain.removeHandler('mail:state')
    ipcMain.handle('mail:state', () => ({
      ok: true,
      value: { accounts: [feishu, netease], gmailConfigured: false, setup: null },
    }))
    ipcMain.removeHandler('mail:cached')
    ipcMain.handle('mail:cached', (_e, _workspace, filter: MailFilter) => ({
      ok: true,
      value: filter.account === feishu.id ? [] : filter.folder === 'unread' ? unreadItems : items,
    }))
    ipcMain.removeHandler('mail:list')
    ipcMain.handle('mail:list', async (_e, _workspace, filter: MailFilter, cursor) => {
      if (filter.folder === 'unread') {
        if (cursor) {
          await new Promise<void>((resolve) => releases.push(resolve))
          return { ok: true, value: { items: unreadItems, next: null, issues: [] } }
        }
        return { ok: true, value: { items: [], next, issues: [] } }
      }
      if (!cursor && filter.account !== feishu.id)
        await new Promise<void>((resolve) => releases.push(resolve))
      const value: MailPage = {
        items: filter.account === feishu.id ? [] : cursor ? [older] : items,
        next: !cursor && filter.account !== feishu.id ? next : null,
        issues: filter.account === netease.id ? [] : [{ account: feishu.id, message: failure }],
      }
      return { ok: true, value }
    })
  }, failure)
  const release = () =>
    app.evaluate(() => {
      const { releases }: { releases: (() => void)[] } = Reflect.get(globalThis, '__mailCacheTest')
      for (const finish of releases.splice(0)) finish()
    })
  await page.getByRole('button', { name: '为工作区再添一点可能', exact: true }).click()
  await page
    .locator('.library-card')
    .filter({ has: page.getByRole('heading', { name: '邮箱', exact: true }) })
    .getByRole('button', { name: '添加', exact: true })
    .click()
  const card = page.getByRole('article', { name: '邮箱', exact: true })
  const cardList = card.getByRole('region', { name: '邮件列表' })
  await expect(card.getByText('正在读取…', { exact: true })).toBeVisible()
  await expect(cardList.getByText('163 已缓存邮件 0', { exact: true })).toBeVisible()
  await expect(card.getByText(failure, { exact: true })).toBeVisible()
  await release()
  await expect(card.getByRole('button', { name: '刷新邮件' })).toBeEnabled()
  await cardList.evaluate((element) => element.scrollTo(0, element.scrollHeight))
  await expect(cardList.getByText('163 历史已缓存邮件', { exact: true })).toBeAttached()
  await expect(card.getByText(failure, { exact: true })).toBeInViewport()

  await choose(card, '邮箱账号', 'offline@example.com')
  await expect(cardList.getByText('163 已缓存邮件 0', { exact: true })).toHaveCount(0)
  await choose(card, '邮箱账号', '全部账号')
  await expect(cardList.getByText('163 已缓存邮件 0', { exact: true })).toBeVisible()
  await release()
  await expect(card.getByRole('button', { name: '刷新邮件' })).toBeEnabled()
  await cardList.evaluate((element) => element.scrollTo(0, element.scrollHeight))
  const older = cardList.getByText('163 历史已缓存邮件', { exact: true })
  await expect(older).toBeAttached()
  await card.getByRole('button', { name: '刷新邮件' }).click()
  await expect(card.getByText('正在读取…', { exact: true })).toBeVisible()
  await expect(older).toBeAttached()
  await release()
  await expect(card.getByRole('button', { name: '刷新邮件' })).toBeEnabled()
  await card.getByRole('button', { name: '回到最新' }).click()
  await expect(older).toBeAttached()

  await card.getByRole('button', { name: '查看全部' }).click()
  const mail = page.locator('.mail-page')
  const list = mail.getByRole('region', { name: '邮件列表' })
  await expect(list.getByText('163 已缓存邮件 0', { exact: true })).toBeVisible()
  await expect(mail.getByText('正在读取…', { exact: true })).toBeVisible()
  await expect(mail.getByText(failure, { exact: true })).toBeInViewport()
  await release()
  await expect(mail.getByRole('button', { name: '刷新邮件' })).toBeEnabled()
  await choose(mail, '邮件类型', '未读')
  await expect
    .poll(() =>
      app.evaluate(() => Reflect.get(globalThis, '__mailCacheTest').releases.length as number),
    )
    .toBe(1)
  await expect(mail.getByText('正在读取…', { exact: true })).toBeVisible()
  await expect(list.getByText('163 已缓存邮件 0', { exact: true })).toBeVisible()
  await release()
  await expect(mail.getByRole('button', { name: '刷新邮件' })).toBeEnabled()
})
