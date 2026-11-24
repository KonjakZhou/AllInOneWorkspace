// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAgenda } from '../src/widgets/feishu-calendar/use-agenda'
import type { CalendarAgenda } from '../src/shared/feishu'
import { deferred } from './feishu-fixtures'

let intersect: (visible: boolean) => void
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 24, 12))
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
function result(accountId = 'a', revision = 0): CalendarAgenda {
  return {
    accountId,
    revision,
    connection: {
      accountId,
      appId: null,
      configured: false,
      status: 'unconfigured',
      identity: null,
      message: null,
      revision,
    },
    events: [],
    updatedAt: null,
    rangeStart: 0,
    rangeEnd: 0,
    stale: false,
    error: null,
  }
}
function harness() {
  const listeners = new Map<string, () => void>()
  const getAgenda = vi.fn(async (accountId: string, _force?: boolean) => result(accountId))
  Object.assign(window, {
    workspace: {
      feishu: {
        getAgenda,
        onChanged: (id: string, callback: () => void) => {
          listeners.set(id, callback)
          return () => listeners.delete(id)
        },
      },
    },
  })
  return { getAgenda, listeners }
}
function View({ accountId, signal }: { accountId: string; signal: AbortSignal }) {
  const state = useAgenda(accountId, signal)
  return (
    <div ref={state.root}>
      <output>
        {state.agenda ? `${state.agenda.accountId}:${state.agenda.revision}` : 'loading'}
      </output>
    </div>
  )
}
it('polls only visible cards, refreshes on focus and unsubscribes on unmount', async () => {
  const { getAgenda, listeners } = harness(),
    signal = new AbortController().signal
  const view = render(<View accountId="a" signal={signal} />)
  await act(async () => {})
  expect(getAgenda).toHaveBeenCalledOnce()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300000)
  })
  expect(getAgenda).toHaveBeenCalledTimes(2)
  act(() => intersect(false))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300000)
  })
  expect(getAgenda).toHaveBeenCalledTimes(2)
  await act(async () => {
    intersect(true)
  })
  expect(getAgenda).toHaveBeenCalledTimes(3)
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  expect(getAgenda).toHaveBeenCalledTimes(4)
  view.unmount()
  expect(listeners.size).toBe(0)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300000)
  })
  expect(getAgenda).toHaveBeenCalledTimes(4)
})
it('ignores late account results, older connection revisions and callbacks after abort', async () => {
  const { getAgenda, listeners } = harness(),
    first = deferred<CalendarAgenda>(),
    abort = new AbortController()
  getAgenda.mockImplementationOnce(() => first.promise)
  const view = render(<View key="a" accountId="a" signal={abort.signal} />)
  await act(async () => {})
  view.rerender(<View key="b" accountId="b" signal={abort.signal} />)
  await act(async () => {
    first.resolve(result('a'))
  })
  expect(view.getByRole('status').textContent).toBe('b:0')
  getAgenda.mockResolvedValueOnce(result('b', 3))
  await act(async () => {
    listeners.get('b')!()
  })
  getAgenda.mockResolvedValueOnce(result('b', 2))
  await act(async () => {
    listeners.get('b')!()
  })
  expect(view.getByRole('status').textContent).toBe('b:3')
  abort.abort()
  const calls = getAgenda.mock.calls.length
  await act(async () => {
    listeners.get('b')!()
  })
  expect(getAgenda).toHaveBeenCalledTimes(calls)
})
it('forces a new date range on local midnight without waiting for five-minute polling', async () => {
  vi.setSystemTime(new Date(2026, 10, 24, 23, 59, 50))
  const { getAgenda } = harness()
  render(<View accountId="a" signal={new AbortController().signal} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000)
  })
  expect(getAgenda).toHaveBeenLastCalledWith('a', true)
})
