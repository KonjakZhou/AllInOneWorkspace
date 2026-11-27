// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { expect, it, vi } from 'vitest'
import { useEdgeGestures } from '../src/widgets/cls-telegraph/use-edge-gestures'

it('keeps the same upward gesture in history mode when the live head returns', async () => {
  vi.useFakeTimers()
  const refresh = vi.fn(async () => {})
  const newer = vi.fn()
  const older = vi.fn()

  function Fixture({ history }: { history: boolean }) {
    const list = useRef<HTMLDivElement>(null)
    const pull = useEdgeGestures(list, { refresh, older, newer: history ? newer : undefined })
    return <div ref={list} aria-label="快讯" data-phase={pull.phase} />
  }

  const view = render(<Fixture history />)
  try {
    const list = view.getByLabelText('快讯')
    fireEvent.wheel(list, { deltaY: -200 })
    expect(newer).toHaveBeenCalledOnce()
    view.rerender(<Fixture history={false} />)
    fireEvent.wheel(list, { deltaY: -160 })
    expect(list.dataset.phase).toBe('idle')
    await act(async () => vi.advanceTimersByTimeAsync(150))
    expect(refresh).not.toHaveBeenCalled()

    fireEvent.wheel(list, { deltaY: -140 })
    expect(list.dataset.phase).toBe('dragging')
    await act(async () => vi.advanceTimersByTimeAsync(150))
    expect(refresh).toHaveBeenCalledOnce()
  } finally {
    view.unmount()
    vi.useRealTimers()
  }
})

it('checks refresh availability during both the pull and the release', async () => {
  vi.useFakeTimers()
  const refresh = vi.fn(async () => {})
  const older = vi.fn()
  let available = false

  function Fixture() {
    const list = useRef<HTMLDivElement>(null)
    const pull = useEdgeGestures(list, {
      refresh,
      canRefresh: () => available,
      minRefreshMs: 0,
      older,
    })
    return <div ref={list} aria-label="邮件列表" data-phase={pull.phase} />
  }

  const view = render(<Fixture />)
  try {
    const list = view.getByLabelText('邮件列表')
    expect(fireEvent.wheel(list, { deltaY: -160, cancelable: true })).toBe(true)
    expect(list.dataset.phase).toBe('idle')
    await act(async () => vi.advanceTimersByTimeAsync(150))
    expect(refresh).not.toHaveBeenCalled()
    expect(fireEvent.wheel(list, { deltaY: 160, cancelable: true })).toBe(true)
    expect(older).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTimeAsync(150))

    available = true
    fireEvent.wheel(list, { deltaY: -160 })
    expect(list.dataset.phase).toBe('dragging')
    available = false
    await act(async () => vi.advanceTimersByTimeAsync(150))
    expect(list.dataset.phase).toBe('idle')
    expect(refresh).not.toHaveBeenCalled()

    available = true
    fireEvent.wheel(list, { deltaY: -160 })
    await act(async () => vi.advanceTimersByTimeAsync(150))
    expect(refresh).toHaveBeenCalledOnce()
    expect(list.dataset.phase).toBe('idle')
  } finally {
    view.unmount()
    vi.useRealTimers()
  }
})
