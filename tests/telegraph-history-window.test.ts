import { expect, it } from 'vitest'
import type { TelegraphHistoryPage, TelegraphItem } from '../src/shared/telegraph'
import {
  INITIAL_HISTORY,
  includeNewer,
  includeOlder,
  olderCursor,
  trimHistory,
} from '../src/widgets/cls-telegraph/history-window'

function page(cursor: number, count = 0): TelegraphHistoryPage {
  const items: TelegraphItem[] = Array.from({ length: count }, (_, index) => {
    const id = cursor - index - 1
    return {
      id,
      headline: `快讯 ${id}`,
      content: '',
      level: 'B',
      publishedAt: id * 1000,
      modifiedAt: id * 1000,
      important: true,
      subjects: [],
      url: `https://www.cls.cn/detail/${id}`,
    }
  })
  return { cursor, nextCursor: cursor - 50, items }
}

it('keeps sparse matches while continuing across source pages that render no rows', () => {
  let history = INITIAL_HISTORY
  for (let i = 0; i < 10; i++) {
    history = trimHistory(
      includeOlder(history, page(1000 - i * 50, i % 3 === 0 ? 1 : 0)),
      'older',
      6,
      150,
    )
  }
  expect(history.showHead).toBe(true)
  expect(history.pages.map(({ cursor }) => cursor)).toEqual([1000, 850, 700, 550])
  expect(olderCursor(history, 1000)).toBe(500)
})

it('restores the discarded range page by page and keeps its older boundary connected', () => {
  let history = INITIAL_HISTORY
  for (let i = 0; i < 140; i++) {
    history = trimHistory(includeOlder(history, page(10000 - i * 50, 50)), 'older', 50, 150)
  }
  expect(history.showHead).toBe(false)
  expect(history.pages).toHaveLength(3)
  expect(history.cursors.slice(0, 2)).toEqual([10000, 9950])
  while (history.start > 0) {
    const cursor = history.cursors[history.start - 1]
    history = trimHistory(includeNewer(history, page(cursor, 50)), 'newer', 50, 150)
  }
  history = trimHistory(includeNewer(history), 'newer', 50, 150)
  expect(history.showHead).toBe(true)
  expect(history.pages.map(({ cursor }) => cursor)).toEqual([10000, 9950])
  expect(olderCursor(history, 10000)).toBe(9900)
})
