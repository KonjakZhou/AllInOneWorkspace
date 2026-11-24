// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CalendarEventRow } from '../src/widgets/feishu-calendar/event-row'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('removes hover details immediately on leaving or blurring, without overlapping the next row', () => {
  vi.useFakeTimers()
  const day = new Date(2026, 10, 24)
  const event = {
    id: 'a',
    title: '日程 A',
    start: day.getTime(),
    end: day.getTime() + 3600000,
    allDay: false,
  }
  render(
    <>
      <CalendarEventRow event={event} day={day} tag="TODAY" past={false} />
      <CalendarEventRow
        event={{ ...event, id: 'b', title: '日程 B' }}
        day={day}
        tag="TODAY"
        past={false}
      />
    </>,
  )
  const first = screen.getByRole('button', { name: /日程 A/ })
  const second = screen.getByRole('button', { name: /日程 B/ })
  fireEvent.mouseMove(first)
  expect(screen.getByRole('tooltip').textContent).toContain('日程 A')
  fireEvent.mouseLeave(first)
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.mouseEnter(second)
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.mouseMove(second)
  expect(screen.getAllByRole('tooltip')).toHaveLength(1)
  expect(screen.getByRole('tooltip').textContent).toContain('日程 B')
  fireEvent.mouseLeave(second)
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.focus(first)
  expect(screen.getByRole('tooltip').textContent).toContain('日程 A')
  fireEvent.blur(first)
  expect(screen.queryByRole('tooltip')).toBeNull()
})
