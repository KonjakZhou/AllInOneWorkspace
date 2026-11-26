import { test, expect, _electron as electron } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceStore } from '../../electron/storage/workspace-store'
import { IdeaArchive } from '../../electron/trading-ideas/archive'
import { manualContent } from '../../electron/trading-ideas/content'
import { latestCollectionSlot } from '../../electron/trading-ideas/service'
import { chinaDay } from '../../src/shared/trading-ideas'

async function seedWorkspace(directory: string, y = 22) {
  const store = new WorkspaceStore(directory)
  const { workspace: savedWorkspace } = await store.load()
  await store.save({
    ...savedWorkspace,
    widgets: [
      {
        id: randomUUID(),
        type: 'trading-ideas',
        version: 1,
        config: {},
        data: null,
        layout: { x: 0, y, w: 5, h: 7 },
      },
    ],
  })
}

function enabledArchive(directory: string, now: number) {
  const archive = new IdeaArchive(join(directory, 'trading-ideas'))
  archive.set('enabled', '1')
  for (const source of ['jisilu', 'arxiv', 'repec']) {
    archive.set('slot:' + source, String(latestCollectionSlot(now)))
  }
  return archive
}

test('opens in the workspace window, restores scroll and focus, and isolates notes', async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'ideas-desktop-'))
  await seedWorkspace(directory)
  const now = Date.now()
  const yesterday = chinaDay(now - 86400000)
  const olderDay = chinaDay(now - 2 * 86400000)
  const fullSummary =
    '观察行业流动性与短期动量之间的关系。'.repeat(16) + '后续结果比较了不同持仓期限和交易成本。'
  const shortSummary = fullSummary.slice(0, 240)
  const archive = enabledArchive(directory, now)
  archive.recordCollection(
    [
      {
        ...manualContent({
          url: 'https://arxiv.org/abs/2601.12345',
          title: '行业 ETF 动量的研究线索',
          author: 'Research team',
          category: '论文',
          evidence: '研究摘要',
          summary: shortSummary,
          publishedDay: yesterday,
          eventDay: '',
        }),
        sourceVersion: 1,
      },
      manualContent({
        url: 'https://example.com/today-undated',
        title: '缺少发布日期的 ETF 轮动方案',
        author: '',
        category: '公开社区与开源',
        evidence: '作者观点',
        summary: '',
        publishedDay: '',
        eventDay: '',
      }),
    ],
    {
      id: 'arxiv',
      label: 'arXiv 量化金融',
      outcome: '无新增',
      attemptedAt: now,
      lastSuccess: now,
      added: 0,
      details: '',
    },
    3,
  )
  archive.recordCollection(
    [
      manualContent({
        url: 'https://example.com/older-announcement',
        title: '前天的指数调仓回测',
        author: '',
        category: '公开社区与开源',
        evidence: '作者观点',
        summary: '',
        publishedDay: olderDay,
        eventDay: '',
      }),
    ],
    {
      id: 'jisilu',
      label: '集思录 ETF 话题',
      outcome: '无新增',
      attemptedAt: now - 2 * 86400000,
      lastSuccess: now,
      added: 0,
      details: '',
    },
    2,
  )
  archive.close()
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, WORKSPACE_DATA_DIR: directory, ELECTRON_RUN_AS_NODE: '' },
  })
  try {
    await app.evaluate((_electron, summary) => {
      const fetchOriginal = globalThis.fetch
      globalThis.fetch = (resource, options) =>
        String(resource) === 'https://arxiv.org/abs/2601.12345v1'
          ? Promise.resolve(
              new Response('<meta name="citation_abstract" content="' + summary + '">'),
            )
          : fetchOriginal(resource, options)
    }, fullSummary)
    const workspace = await app.firstWindow()
    const card = workspace.getByRole('article', { name: '交易灵感' })
    const firstItem = card.getByRole('button', { name: /行业 ETF 动量的研究线索/ })
    await firstItem.scrollIntoViewIfNeeded()
    await workspace.evaluate(() => {
      document.addEventListener(
        'click',
        () => {
          document.body.dataset.ideaEntryScroll = String(window.scrollY)
        },
        { capture: true, once: true },
      )
    })
    await firstItem.click()
    const originalScroll = await workspace.evaluate(() =>
      Number(document.body.dataset.ideaEntryScroll),
    )
    expect(originalScroll).toBeGreaterThan(0)
    const back = workspace.getByRole('button', { name: '返回工作区' })
    await expect(back).toBeFocused()
    await expect(workspace.getByRole('heading', { name: /我的工作区/ })).toHaveCount(0)
    await expect(workspace.getByRole('heading', { name: '行业 ETF 动量的研究线索' })).toBeVisible()
    expect(app.windows()).toHaveLength(1)

    await expect(workspace.getByRole('button', { name: '补全摘要' })).toHaveCount(0)
    await expect(workspace.locator('.ideas-summary')).toContainText(
      '后续结果比较了不同持仓期限和交易成本。',
    )

    const priority = workspace.getByRole('button', { name: '优先级', exact: true })
    await priority.click()
    const high = workspace.getByRole('option', { name: '高', exact: true })
    await expect(high).toBeVisible()
    await priority.click()
    await expect(high).toBeHidden()
    await priority.click()
    await expect(high).toBeVisible()
    await workspace.screenshot({ path: testInfo.outputPath('dropdown.png') })
    await workspace.getByRole('option', { name: '未标记', exact: true }).press('ArrowDown')
    await expect(high).toBeFocused()
    await high.press('Enter')
    await expect(priority).toHaveText('高')
    const checkbox = workspace.getByRole('checkbox', { name: '加入待研究' })
    const label = workspace.locator('.ideas-check')
    const bounds = (await label.boundingBox())!
    const noteForm = (await workspace.locator('.ideas-notes').boundingBox())!
    expect(bounds.width).toBeLessThan(120)
    expect(bounds.width + 30).toBeLessThan(noteForm.width)
    await workspace.mouse.click(bounds.x + bounds.width + 30, bounds.y + bounds.height / 2)
    await expect(checkbox).not.toBeChecked()
    await label.click()
    await expect(checkbox).toBeChecked()
    await workspace.getByLabel('可以研究的问题').fill('换手率能解释动量衰减吗？')
    await workspace.getByRole('button', { name: '保存标记与笔记' }).click()
    await expect(workspace.locator('.ideas-saved')).toHaveText('已保存')
    const header = workspace.locator('.ideas-page-title')
    expect(
      await header
        .locator('h1')
        .evaluate((node) => node.nextElementSibling?.classList.contains('ideas-back')),
    ).toBe(true)
    await workspace.screenshot({ path: testInfo.outputPath('details.png') })
    await back.click()
    await expect(firstItem).toBeFocused()
    await expect(firstItem).toContainText('高优先级')
    await expect.poll(() => workspace.evaluate(() => window.scrollY)).toBe(originalScroll)
    await workspace.screenshot({ path: testInfo.outputPath('card.png') })

    const all = card.getByRole('button', { name: '查看全部' })
    await all.click()
    const tabs = workspace.getByRole('navigation', { name: '资料视图' })
    await expect(tabs.getByRole('button')).toHaveText([
      '全部历史',
      '今日新收录',
      '待研究',
      '按日看',
    ])
    await expect(tabs.getByRole('button', { name: '全部历史', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(app.windows()).toHaveLength(1)
    const list = workspace.getByRole('region', { name: '灵感列表' })
    const shownTitles = () => list.locator('button.ideas-list-item strong').allTextContents()
    const verifyTitles = async (titles: string[]) => {
      await expect.poll(async () => (await shownTitles()).sort()).toEqual(titles.sort())
    }
    const viewTab = (name: string) => tabs.getByRole('button', { name, exact: true })
    await verifyTitles([
      '行业 ETF 动量的研究线索',
      '缺少发布日期的 ETF 轮动方案',
      '前天的指数调仓回测',
    ])
    await viewTab('今日新收录').click()
    await verifyTitles(['行业 ETF 动量的研究线索', '缺少发布日期的 ETF 轮动方案'])
    await viewTab('按日看').click()
    await verifyTitles(['行业 ETF 动量的研究线索'])
    await expect(list.getByRole('heading')).toHaveText(yesterday)
    const dailyDate = workspace.getByRole('button', { name: '日报日期' })
    await dailyDate.click()
    const calendar = workspace.getByRole('dialog', { name: '日报日期' })
    await expect(calendar).toBeVisible()
    await workspace.screenshot({ path: testInfo.outputPath('calendar.png') })
    await calendar.getByRole('button', { name: olderDay, exact: true }).click()
    await verifyTitles(['前天的指数调仓回测'])
    await expect(list.getByRole('heading')).toHaveText(olderDay)

    await viewTab('全部历史').click()
    await verifyTitles([
      '行业 ETF 动量的研究线索',
      '缺少发布日期的 ETF 轮动方案',
      '前天的指数调仓回测',
    ])
    await expect(list.getByRole('heading')).toHaveText([chinaDay(now), olderDay])
    await viewTab('待研究').click()
    await verifyTitles(['行业 ETF 动量的研究线索'])
    await viewTab('按日看').click()
    await viewTab('今日新收录').click()
    await viewTab('全部历史').click()
    await verifyTitles([
      '行业 ETF 动量的研究线索',
      '缺少发布日期的 ETF 轮动方案',
      '前天的指数调仓回测',
    ])
    await expect(list.getByRole('heading')).toHaveText([chinaDay(now), olderDay])
    const category = workspace.getByRole('button', { name: '来源类别', exact: true })
    await category.click()
    await workspace.getByRole('option', { name: '论文', exact: true }).click()
    await verifyTitles(['行业 ETF 动量的研究线索'])
    await viewTab('按日看').click()
    await expect(list.getByText('这个视图暂时没有条目。')).toBeVisible()
    await expect(list.getByRole('heading')).toHaveCount(0)

    await workspace.getByRole('button', { name: '采集状态' }).click()
    await expect(workspace.getByRole('region', { name: '采集状态' })).toContainText('06:00')

    await workspace.getByRole('button', { name: '手动收录', exact: true }).click()
    await workspace.getByLabel('原文链接').fill('https://example.com/private')
    await workspace.getByLabel('标题', { exact: true }).fill('个人收藏的行业观察')
    await workspace.getByRole('button', { name: '发布日期', exact: true }).click()
    const manualDate = workspace.getByRole('dialog', { name: '发布日期', exact: true })
    await manualDate.getByRole('textbox', { name: '输入日期' }).fill(yesterday)
    await manualDate.getByRole('button', { name: '确定', exact: true }).click()
    await workspace.getByRole('button', { name: '保存条目' }).click()
    await expect(workspace.getByRole('heading', { name: '个人收藏的行业观察' })).toBeVisible()
    await back.click()
    await expect(all).toBeFocused()

    await workspace.getByRole('button', { name: '管理账号' }).click()
    await workspace.getByLabel('创建一个新的空间').fill('另一个账号')
    await workspace.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect(workspace.locator('.account-row.selected')).toContainText('另一个账号')
    await workspace.getByRole('button', { name: '关闭对话框' }).click()
    await workspace.getByRole('button', { name: '为工作区再添一点可能', exact: true }).click()
    await workspace
      .locator('.library-card')
      .filter({ has: workspace.getByRole('heading', { name: '交易灵感', exact: true }) })
      .getByRole('button', { name: '添加', exact: true })
      .click()
    await all.click()
    await expect(workspace.getByText('个人收藏的行业观察')).toHaveCount(0)
    await expect(workspace.getByRole('button', { name: /行业 ETF 动量的研究线索/ })).toBeVisible()
    await workspace.getByRole('button', { name: '待研究', exact: true }).click()
    await expect(workspace.getByText('这个视图暂时没有条目。')).toBeVisible()
  } finally {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('scrolls through the full local ideas list and keeps the update footer in view', async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'ideas-card-scroll-'))
  const now = Date.now()
  await seedWorkspace(directory, 0)
  const archive = enabledArchive(directory, now)
  archive.recordCollection(
    Array.from({ length: 24 }, (_, index) =>
      manualContent({
        url: 'https://example.com/strategy-' + index,
        title: 'ETF 轮动策略 ' + (index + 1),
        author: '',
        category: '公开社区与开源',
        evidence: '作者观点',
        summary: '',
        publishedDay: chinaDay(now - index * 86400000),
        eventDay: '',
      }),
    ),
    {
      id: 'jisilu',
      label: '集思录 ETF 话题',
      outcome: '无新增',
      attemptedAt: now,
      lastSuccess: now,
      added: 0,
      details: '',
    },
    1,
  )
  archive.close()
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, WORKSPACE_DATA_DIR: directory, ELECTRON_RUN_AS_NODE: '' },
  })
  try {
    await app.evaluate(() => {
      // This fixture has already completed the current collection slot.
      Reflect.set(globalThis, 'ideaScrollRequests', 0)
      globalThis.fetch = () => {
        Reflect.set(
          globalThis,
          'ideaScrollRequests',
          Number(Reflect.get(globalThis, 'ideaScrollRequests')) + 1,
        )
        throw new Error('Unexpected remote request')
      }
    })
    const workspace = await app.firstWindow()
    const card = workspace.getByRole('article', { name: '交易灵感', exact: true })
    const list = card.getByRole('region', { name: '交易灵感列表' })
    const items = list.getByRole('button')
    await expect(items).toHaveCount(24)
    await expect(items.first()).toContainText('ETF 轮动策略 1')
    await expect(items.last()).toContainText('ETF 轮动策略 24')
    const footer = card.locator('.widget-scroll-footer')
    await expect(footer).toContainText('更新于')
    const footerPosition = await footer.boundingBox()
    await list.hover()
    await workspace.mouse.wheel(0, 3000)
    await expect(items.last()).toBeInViewport()
    await workspace.mouse.wheel(0, -3000)
    await expect(items.first()).toBeInViewport()
    expect(await footer.boundingBox()).toEqual(footerPosition)
    await expect(card.getByText('今日新收录 24 条')).toBeVisible()
    await expect(card.getByRole('alert')).toHaveCount(0)
    expect(await app.evaluate(() => Reflect.get(globalThis, 'ideaScrollRequests'))).toBe(0)
    await workspace.screenshot({ path: testInfo.outputPath('scrolling-card.png') })
  } finally {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  }
})
