// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useRef, useState } from 'react'
import definition from '../src/widgets/cls-telegraph/widget'
import type { TelegraphFeed, TelegraphItem } from '../src/shared/telegraph'

const normal: TelegraphItem = {
  id: 1,
  headline: '普通消息',
  content: '普通消息的完整正文。',
  level: 'C',
  publishedAt: new Date(2026, 10, 24, 12).getTime(),
  modifiedAt: new Date(2026, 10, 24, 12).getTime(),
  important: false,
  subjects: ['市场'],
  url: 'https://www.cls.cn/detail/1',
}
const important: TelegraphItem = {
  ...normal,
  id: 2,
  headline: '重点消息',
  content: '重点消息的完整正文。',
  level: 'B',
  important: true,
  url: 'https://www.cls.cn/detail/2',
}
const feed = (items = [important, normal], revision = 1): TelegraphFeed => ({
  revision,
  items,
  updatedAt: Date.now(),
  stale: false,
  error: null,
  historyCursor: 1795492799,
})

beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('switches views, expands content and opens only by numeric item id', async () => {
  let changed = () => {}
  const getFeed = vi.fn(async () => feed())
  const loadOlder = vi.fn(async (cursor: number) => ({
    page: {
      cursor,
      nextCursor: cursor - 50,
      items: [{ ...important, id: cursor, headline: '更早消息' }],
    },
  }))
  const openItem = vi.fn(async () => {})
  Object.assign(window, {
    workspace: {
      telegraph: {
        getFeed,
        loadOlder,
        openItem,
        onChanged: (callback: () => void) => {
          changed = callback
          return () => {
            changed = () => {}
          }
        },
      },
    },
  })
  const Component = definition.Component
  function View() {
    const [config, setConfig] = useState<{ view: 'all' | 'important' }>({ view: 'all' })
    const signal = useRef(new AbortController().signal).current
    return (
      <Component
        accountId="account"
        instanceId="instance"
        config={config}
        data={null}
        signal={signal}
        updateConfig={(value) =>
          setConfig((previous) =>
            typeof value === 'function' ? value(previous) : (value as typeof previous),
          )
        }
        updateData={() => {}}
        openAccountSettings={() => {}}
      />
    )
  }
  render(<View />)
  expect(await screen.findByText('普通消息')).toBeTruthy()
  expect(screen.getByText('B')).toBeTruthy()
  expect(document.querySelector('.telegraph-item-summary b')?.textContent).toBe('重点')
  fireEvent.click(screen.getByRole('button', { name: '重点' }))
  expect(screen.queryByText('普通消息')).toBeNull()
  expect(document.querySelector('.telegraph-item-summary b')).toBeNull()
  fireEvent.click(screen.getByText('重点消息'))
  expect(screen.getByText('重点消息的完整正文。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /打开财联社原文/ }))
  expect(openItem).toHaveBeenCalledWith(2)

  fireEvent.click(screen.getByRole('button', { name: '继续下拉，加载更早快讯' }))
  expect(loadOlder).toHaveBeenCalledWith(feed().historyCursor)
  expect(await screen.findByText('更早消息')).toBeTruthy()

  const withNewItem = feed([{ ...important, id: 3, headline: '刚刚发生' }, important], 3)
  getFeed.mockResolvedValueOnce(withNewItem).mockResolvedValueOnce(withNewItem)
  const list = screen.getByLabelText('财联社快讯列表')
  Object.defineProperties(list, {
    scrollTop: { configurable: true, writable: true, value: 100 },
    scrollHeight: { configurable: true, value: 500 },
    clientHeight: { configurable: true, value: 200 },
  })
  fireEvent.scroll(list)
  await act(async () => changed())
  expect(screen.queryByRole('button', { name: /回到最新/ })).toBeNull()
  list.scrollTop = 201
  fireEvent.scroll(list)
  const notice = await screen.findByRole('button', { name: /回到最新.*1 条新快讯/ })
  fireEvent.click(notice)
  await act(async () => {})
  expect(getFeed).toHaveBeenLastCalledWith(true)
  expect(await screen.findByText('刚刚发生')).toBeTruthy()
})
