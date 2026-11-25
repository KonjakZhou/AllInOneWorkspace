import type { TelegraphHistoryPage } from '../../shared/telegraph'

export type HistoryWindow = {
  showHead: boolean
  cursors: number[]
  start: number
  end: number
  next: number | null | undefined
  pages: TelegraphHistoryPage[]
}

export const INITIAL_HISTORY: HistoryWindow = {
  showHead: true,
  cursors: [],
  start: 0,
  end: 0,
  next: undefined,
  pages: [],
}

export function olderCursor(window: HistoryWindow, headCursor: number | null | undefined) {
  return window.cursors[window.end] ?? (window.next === undefined ? headCursor : window.next)
}

export function includeOlder(window: HistoryWindow, page: TelegraphHistoryPage): HistoryWindow {
  const { cursors, end } = window
  // Retain the return route when the source still agrees with the recorded page boundaries.
  const sameRoute =
    cursors[end] === page.cursor &&
    (end + 1 < cursors.length
      ? cursors[end + 1] === page.nextCursor
      : window.next === page.nextCursor)
  return {
    ...window,
    cursors: sameRoute ? cursors : [...cursors.slice(0, end), page.cursor],
    end: end + 1,
    next: sameRoute ? window.next : page.nextCursor,
    pages: page.items.length ? [...window.pages, page] : window.pages,
  }
}

export function includeNewer(window: HistoryWindow, page?: TelegraphHistoryPage): HistoryWindow {
  return page
    ? {
        ...window,
        start: window.start - 1,
        pages: page.items.length ? [page, ...window.pages] : window.pages,
      }
    : { ...window, showHead: true }
}

export function trimHistory(
  window: HistoryWindow,
  direction: 'older' | 'newer',
  headCount: number,
  limit: number,
): HistoryWindow {
  let { showHead, start, end, pages } = window
  let count = pages.reduce((total, page) => total + page.items.length, showHead ? headCount : 0)
  while (count > limit && pages.length) {
    if (direction === 'older' && showHead) {
      showHead = false
      count -= headCount
    } else if (direction === 'older') {
      start = window.cursors.indexOf(pages[0].cursor, start) + 1
      count -= pages[0].items.length
      pages = pages.slice(1)
    } else {
      const last = pages[pages.length - 1]
      end = window.cursors.indexOf(last.cursor, start)
      count -= last.items.length
      pages = pages.slice(0, -1)
    }
  }
  return { ...window, showHead, start, end, pages }
}
