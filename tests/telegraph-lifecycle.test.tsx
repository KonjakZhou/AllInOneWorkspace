// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTelegraph } from '../src/widgets/cls-telegraph/use-telegraph'
import type { TelegraphFeed } from '../src/shared/telegraph'

let intersect: (visible: boolean) => void
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        intersect = (visible) => callback([{ isIntersecting: visible }])
      }
      observe() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const result = (revision = 0): TelegraphFeed => ({
  revision,
  items: [],
  updatedAt: Date.now(),
  stale: false,
  error: null,
  historyCursor: null,
})
function harness() {
  let listener = () => {}
  const getFeed = vi.fn(async () => result())
  Object.assign(window, {
    workspace: {
      telegraph: {
        getFeed,
        loadOlder: vi.fn(async () => result()),
        openItem: vi.fn(),
        onChanged: (callback: () => void) => {
          listener = callback
          return () => {
            listener = () => {}
          }
        },
      },
    },
  })
  return { getFeed, changed: () => listener() }
}
function View({ signal }: { signal: AbortSignal }) {
  const state = useTelegraph(signal)
  return (
    <div ref={state.root}>
      <output>{state.feed?.revision ?? 'loading'}</output>
    </div>
  )
}

it('polls every 30 seconds only while visible, refreshes on focus and cleans up', async () => {
  const { getFeed } = harness()
  const view = render(<View signal={new AbortController().signal} />)
  await act(async () => {})
  expect(getFeed).toHaveBeenCalledOnce()
  await act(async () => vi.advanceTimersByTimeAsync(30000))
  expect(getFeed).toHaveBeenCalledTimes(2)
  act(() => intersect(false))
  await act(async () => vi.advanceTimersByTimeAsync(30000))
  expect(getFeed).toHaveBeenCalledTimes(2)
  await act(async () => intersect(true))
  expect(getFeed).toHaveBeenCalledTimes(3)
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(getFeed).toHaveBeenCalledTimes(4)
  view.unmount()
  await act(async () => vi.advanceTimersByTimeAsync(30000))
  expect(getFeed).toHaveBeenCalledTimes(4)
})

it('keeps the newest revision and ignores callbacks after abort', async () => {
  const { getFeed, changed } = harness()
  const abort = new AbortController()
  const view = render(<View signal={abort.signal} />)
  await act(async () => {})
  getFeed.mockResolvedValueOnce(result(3))
  await act(async () => changed())
  getFeed.mockResolvedValueOnce(result(2))
  await act(async () => changed())
  expect(view.getByRole('status').textContent).toBe('3')
  abort.abort()
  const calls = getFeed.mock.calls.length
  await act(async () => changed())
  expect(getFeed).toHaveBeenCalledTimes(calls)
})

it('releases the renderer feed after 15 minutes offscreen and fetches on return', async () => {
  const { getFeed } = harness()
  const view = render(<View signal={new AbortController().signal} />)
  await act(async () => {})
  act(() => intersect(false))
  await act(async () => vi.advanceTimersByTimeAsync(15 * 60 * 1000))
  expect(view.getByRole('status').textContent).toBe('loading')
  expect(getFeed).toHaveBeenCalledOnce()
  await act(async () => intersect(true))
  expect(view.getByRole('status').textContent).toBe('0')
  expect(getFeed).toHaveBeenCalledTimes(2)
})
