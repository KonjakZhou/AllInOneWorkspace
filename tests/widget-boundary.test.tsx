// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { randomUUID } from 'node:crypto'
import { WidgetErrorBoundary } from '../src/sdk/components'
import { WidgetCard } from '../src/components/WidgetCard'
import type { WidgetContext } from '../src/sdk/types'
import type { WorkspaceController } from '../src/workspace/controller'
import { widgetRegistry } from '../src/widgets'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
describe('component failure and lifecycle isolation', () => {
  it('contains a rendering failure, keeps a neighbor alive, and retries', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let shouldFail = true
    function Unstable() {
      if (shouldFail) throw new Error('example component failed')
      return <span>恢复成功</span>
    }
    render(
      <>
        <WidgetErrorBoundary>
          <Unstable />
        </WidgetErrorBoundary>
        <WidgetErrorBoundary>
          <button>正常组件</button>
        </WidgetErrorBoundary>
      </>,
    )
    expect(screen.getByRole('alert').textContent).toContain('example component failed')
    expect(screen.getByRole('button', { name: '正常组件' })).toBeDefined()
    shouldFail = false
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(screen.getByText('恢复成功')).toBeDefined()
  })
  it('aborts an unmounted instance and ignores a callback retained by an old component', () => {
    let captured!: WidgetContext
    const updateWidget = vi.fn()
    const controller = { updateWidget, showError: vi.fn() } as unknown as WorkspaceController
    const definition = {
      ...widgetRegistry.get('starter.counter')!,
      Component: (context: WidgetContext) => {
        captured = context
        return <div>sample</div>
      },
    }
    const instance = {
      id: randomUUID(),
      type: definition.type,
      version: 1,
      config: definition.defaultConfig,
      data: definition.defaultData,
      layout: { x: 0, y: 0, w: 4, h: 7 },
    }
    const result = render(
      <WidgetCard
        widget={instance}
        accountId={randomUUID()}
        definition={definition}
        controller={controller}
        editing={false}
        busy={false}
        onRemove={() => {}}
      />,
    )
    captured.updateData({ count: 1 })
    expect(updateWidget).toHaveBeenCalledOnce()
    result.unmount()
    expect(captured.signal.aborted).toBe(true)
    captured.updateData({ count: 2 })
    expect(updateWidget).toHaveBeenCalledOnce()
  })
})
