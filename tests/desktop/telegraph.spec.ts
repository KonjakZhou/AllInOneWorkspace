import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication, page: Page, directory: string
const errors: string[] = []

async function addWidget(name: '财联社 7×24' | '飞书日历') {
  await page.getByRole('button', { name: '为工作区再添一点可能', exact: true }).click()
  await page
    .locator('.library-card')
    .filter({ has: page.getByRole('heading', { name, exact: true }) })
    .getByRole('button', { name: '添加', exact: true })
    .click()
}
const add = () => addWidget('财联社 7×24')

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-telegraph-desktop-'))
  errors.length = 0
  app = await electron.launch({
    args: [process.env.WORKSPACE_TEST_APP ?? resolve('out/main/index.js')],
    executablePath: process.env.WORKSPACE_TEST_EXECUTABLE,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', WORKSPACE_DATA_DIR: directory },
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('heading', { name: '我的工作区.' })).toBeVisible()
  await app.evaluate(({ shell }) => {
    const state = { calls: [] as Array<{ cursor: number; direction: number }>, opened: '' }
    Object.assign(globalThis, { __telegraphTest: state })
    shell.openExternal = async (url) => {
      state.opened = url
    }
    const at = Math.floor(Date.now() / 1000) - 1000
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (!url.startsWith('https://www.cls.cn/v1/roll/get_roll_list?'))
        throw new Error(`Unexpected test request: ${url}`)
      const params = new URL(url).searchParams
      const cursor = Number(params.get('last_time'))
      const direction = Number(params.get('refresh_type'))
      state.calls.push({ cursor, direction })
      const raw = (id: number, title: string, important = false) => ({
        id,
        ctime: at + id,
        modified_time: at + id,
        title,
        brief: `【${title}】正文`,
        content: `【${title}】这是完整正文。`,
        level: important ? 'B' : 'C',
        recommend: important ? 1 : 0,
        jpush: 0,
        bold: 0,
        status: 1,
        is_ad: 0,
        subjects: [{ subject_name: important ? '重点主题' : '普通主题' }],
      })
      if (direction === 0) await new Promise((done) => setTimeout(done, 350))
      const updates = state.calls.filter((call) => call.direction === 0).length
      return Response.json({
        errno: 0,
        msg: '',
        data: {
          roll_data:
            direction === 0
              ? [raw(750 + updates, updates === 1 ? '刚刚更新' : '再次更新', true)]
              : cursor > at + 750
                ? [
                    raw(750, '重点快讯', true),
                    raw(749, '普通快讯'),
                    ...Array.from({ length: 48 }, (_, index) => {
                      const id = 748 - index
                      return raw(id, `历史快讯 ${id}`, id % 10 === 0 || id === 701)
                    }),
                  ]
                : Array.from({ length: Math.min(50, Math.max(0, cursor - at - 1)) }, (_, index) => {
                    const id = cursor - at - 1 - index
                    return raw(id, `更早历史 ${id}`, id <= 500 && id % 10 === 0)
                  }),
        },
      })
    }
  })
})

test.afterEach(async () => {
  await app?.close().catch(() => {})
  await rm(directory, { recursive: true, force: true })
})

const articles = () => page.getByRole('article', { name: '财联社 7×24', exact: true })
const historyItem = (id: number) =>
  articles().getByRole('button', { name: new RegExp(`更早历史 ${id}$`) })
const calls = () =>
  app.evaluate(
    () =>
      (
        globalThis as unknown as {
          __telegraphTest: { calls: { cursor: number; direction: number }[] }
        }
      ).__telegraphTest.calls,
  )

test('reuses deep history in both scroll directions and only jumps on request', async () => {
  await add()
  const card = articles()
  await expect(card.getByText('普通快讯')).toBeVisible()
  await expect(card.getByText('重点快讯')).toBeVisible()
  await expect(card.locator('.telegraph-level').first()).toHaveText('B')
  await card.getByText('重点快讯').click()
  await expect(card.getByText('【重点快讯】这是完整正文。')).toBeVisible()
  await card.getByRole('button', { name: /打开财联社原文/ }).click()
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          (globalThis as unknown as { __telegraphTest: { opened: string } }).__telegraphTest.opened,
      ),
    )
    .toBe('https://www.cls.cn/detail/750')
  const list = card.getByLabel('财联社快讯列表')
  const jump = card.getByRole('button', { name: '回到最新', exact: true })
  await list.evaluate((element) => {
    element.scrollTop = element.clientHeight
    element.dispatchEvent(new Event('scroll'))
  })
  await expect(jump).toHaveCount(0)
  await list.evaluate((element) => {
    element.scrollTop = element.clientHeight + 1
    element.dispatchEvent(new Event('scroll'))
  })
  await expect(jump).toBeInViewport()
  await list.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll'))
  })
  await expect(jump).toHaveCount(0)
  await list.hover()
  await page.mouse.wheel(0, 20000)
  await expect(historyItem(700)).toBeVisible()
  const olderButton = card.getByRole('button', { name: '继续下拉，加载更早快讯' })
  for (let id = 650; id >= 150; id -= 50) {
    await olderButton.evaluate((button: HTMLButtonElement) => button.click())
    await expect(historyItem(id)).toBeVisible()
  }
  await expect(historyItem(700)).toHaveCount(0)
  await expect(card.getByText('重点快讯')).toHaveCount(0)
  const historyCalls = await calls()
  expect(historyCalls).toHaveLength(13)
  expect(
    historyCalls
      .slice(2)
      .every((call, index) => call.cursor === historyCalls[index + 1].cursor - 50),
  ).toBe(true)
  await page.waitForTimeout(5100)
  await list.evaluate((node) => {
    node.scrollTop = 140
  })
  await list.hover()
  await page.mouse.wheel(0, -2500)
  await expect(historyItem(300)).toBeVisible()
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(1000)
  await page.mouse.wheel(0, -3000)
  await expect(historyItem(350)).toBeVisible()
  await expect(card.locator('.telegraph-pull')).toHaveAttribute('data-phase', 'idle')
  expect(await calls()).toHaveLength(13)
  await page.mouse.wheel(0, 20000)
  await expect(historyItem(200)).toBeVisible()
  expect(await calls()).toHaveLength(13)
  await expect(card.getByText('重点快讯')).toHaveCount(0)
  await expect(card.getByRole('button', { name: '加载较新快讯' })).toHaveCount(0)
  await expect(jump).toBeInViewport()
  await jump.click()
  await expect(card.getByText('刚刚更新')).toBeVisible()
  expect((await calls()).at(-1)?.direction).toBe(0)
  await expect(historyItem(350)).toHaveCount(0)
  expect(await list.evaluate((element) => element.scrollTop)).toBe(0)
  expect(errors).toEqual([])
})

test('automatically fills sparse important results on filter, jump and live refresh', async () => {
  await add()
  const card = articles()
  const list = card.getByLabel('财联社快讯列表')
  const full = () =>
    list.evaluate(
      (element) =>
        element.querySelector('.telegraph-rows')!.getBoundingClientRect().height >=
        element.clientHeight,
    )
  await expect(card.getByText('普通快讯')).toBeVisible()
  await card.getByRole('button', { name: '重点', exact: true }).click()
  await expect(card.getByText('普通快讯')).toHaveCount(0)
  await expect(card.locator('.telegraph-item-summary b')).toHaveCount(0)
  await expect.poll(full).toBe(true)
  expect((await calls()).filter((call) => call.direction === 1).length).toBeGreaterThan(4)
  await expect(card.getByText('重点快讯')).toBeVisible()

  const olderButton = card.getByRole('button', { name: '继续下拉，加载更早快讯' })
  for (let index = 0; index < 4; index++)
    await olderButton.evaluate((button: HTMLButtonElement) => button.click())
  await expect
    .poll(() => list.evaluate((element) => element.scrollHeight > element.clientHeight * 2))
    .toBe(true)
  await list.evaluate((element) => {
    element.scrollTop = element.clientHeight + 1
    element.dispatchEvent(new Event('scroll'))
  })
  await expect(card.getByRole('button', { name: '回到最新', exact: true })).toBeInViewport()
  await page.waitForTimeout(5100)
  await card.getByRole('button', { name: '回到最新', exact: true }).click()
  await expect(card.getByText('刚刚更新')).toBeVisible()
  await expect.poll(full).toBe(true)
  expect(await list.evaluate((element) => element.scrollTop)).toBe(0)
  const liveCalls = (await calls()).filter((call) => call.direction === 0).length

  await page.waitForTimeout(5100)
  await list.hover()
  await page.mouse.wheel(0, -50)
  await expect(card.getByText('下拉刷新快讯', { exact: true })).toBeVisible()
  await expect(card.locator('.telegraph-pull')).toHaveAttribute('data-phase', 'idle')
  expect((await calls()).filter((call) => call.direction === 0)).toHaveLength(liveCalls)
  await page.mouse.wheel(0, -145)
  await expect(card.getByText('松手刷新快讯')).toBeVisible()
  await expect(card.getByText('再次更新')).toBeVisible()
  await expect(card.locator('.telegraph-pull')).toHaveAttribute('data-phase', 'idle')
  await expect.poll(full).toBe(true)
  await card.screenshot({ path: 'test-results/cls-telegraph.png' })
  expect(errors).toEqual([])
})

test('scrolling cards share footer geometry while keeping their theme colors', async () => {
  await add()
  await addWidget('飞书日历')
  const telegraph = articles()
  const calendar = page.getByRole('article', { name: '飞书日历', exact: true })
  await expect(telegraph.locator('.widget-scroll-footer')).toContainText(/更新于 \d{2}:\d{2}:\d{2}/)

  const metrics = (card: ReturnType<typeof articles>) =>
    card.locator('.widget-scroll-footer').evaluate((footer) => {
      const cardElement = footer.closest<HTMLElement>('.widget-card')!
      const footerBounds = footer.getBoundingClientRect()
      const cardBounds = cardElement.getBoundingClientRect()
      const style = getComputedStyle(footer)
      return {
        height: footerBounds.height,
        leftInset: footerBounds.left - cardBounds.left,
        rightInset: cardBounds.right - footerBounds.right,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        borderTopWidth: style.borderTopWidth,
        borderTopStyle: style.borderTopStyle,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
      }
    })

  expect(await metrics(calendar)).toEqual(await metrics(telegraph))
  await expect(telegraph.locator('.widget-scroll-footer')).not.toHaveCSS(
    'background-color',
    await calendar
      .locator('.widget-scroll-footer')
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  )
  await page.screenshot({ path: 'test-results/scrolling-widget-footers.png', fullPage: true })
  expect(errors).toEqual([])
})
