// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { formatWidgetUpdateTime, WidgetScrollFooter } from '../src/components/WidgetScrollFooter'

afterEach(cleanup)

it('uses a shared second-precision update time and footer structure', () => {
  const updatedAt = new Date(2026, 10, 24, 7, 8, 9).getTime()
  render(
    <WidgetScrollFooter updatedAt={updatedAt} fallback="尚未更新">
      <button>刷新</button>
    </WidgetScrollFooter>,
  )

  expect(formatWidgetUpdateTime(updatedAt)).toBe('07:08:09')
  expect(screen.getByText('更新于 07:08:09').classList).toContain('widget-scroll-footer-status')
  expect(screen.getByRole('button', { name: '刷新' }).parentElement?.classList).toContain(
    'widget-scroll-footer-actions',
  )
})

it('keeps stale and fallback labels consistent', () => {
  const updatedAt = new Date(2026, 10, 24, 17, 18, 19).getTime()
  const { rerender } = render(
    <WidgetScrollFooter updatedAt={updatedAt} stale fallback="尚未更新" />,
  )
  expect(screen.getByText('上次更新 17:18:19')).toBeTruthy()

  rerender(<WidgetScrollFooter fallback="尚未更新" />)
  expect(screen.getByText('尚未更新')).toBeTruthy()
})
