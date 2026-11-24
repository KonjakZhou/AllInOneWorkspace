import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { WorkspaceController } from '../src/workspace/controller'
import { widgetRegistry } from '../src/widgets'
import { emptyWorkspace, type Snapshot, type Workspace } from '../src/shared/model'
import type { DesktopAPI } from '../src/shared/api'

function snapshot(name = '默认账号'): Snapshot {
  const id = randomUUID()
  return {
    workspace: emptyWorkspace(id),
    index: {
      schemaVersion: 1,
      activeAccountId: id,
      accounts: [{ id, name, createdAt: new Date().toISOString() }],
    },
    dataDirectory: '/test',
    notices: [],
  }
}
function setup() {
  const first = snapshot(),
    second = snapshot('工作')
  const saved: Workspace[] = []
  const api: DesktopAPI = {
    load: vi.fn(async () => first),
    save: vi.fn(async (workspace) => {
      saved.push(structuredClone(workspace))
    }),
    switchAccount: vi.fn(async () => second),
    createAccount: vi.fn(async () => second),
    renameAccount: vi.fn(async () => first),
    deleteAccount: vi.fn(async () => first),
    exportAccount: vi.fn(async () => true),
    importAccount: vi.fn(async () => null),
    onCloseRequested: () => () => {},
    finishClose: vi.fn(async () => {}),
  }
  return { api, first, second, saved, controller: new WorkspaceController(api, widgetRegistry) }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('workspace save coordination', () => {
  it('debounces edits and separates multiple instances', async () => {
    const { controller, api } = setup()
    await controller.load()
    controller.addWidget('starter.counter')
    controller.addWidget('starter.counter')
    const doc = controller.getState().snapshot!.workspace
    const [a, b] = doc.widgets
    controller.updateWidget(doc.accountId, a.id, 'data', { count: 4 })
    controller.updateWidget(doc.accountId, a.id, 'data', (value) => ({
      count: (value as { count: number }).count + 1,
    }))
    expect(api.save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(351)
    expect(api.save).toHaveBeenCalledTimes(1)
    const result = controller.getState().snapshot!.workspace
    expect(result.widgets[0].data).toEqual({ count: 5 })
    expect(result.widgets[1].data).toEqual({ count: 0 })
    expect(a.layout.x).not.toBe(b.layout.x)
    expect(controller.getState().status).toBe('saved')
  })
  it('saves before switching, ignores stale account callbacks, and retains the old account on failure', async () => {
    const { controller, api, first, second } = setup()
    await controller.load()
    controller.addWidget('starter.counter')
    const widget = controller.getState().snapshot!.workspace.widgets[0]
    vi.mocked(api.save).mockRejectedValueOnce(new Error('disk full'))
    await expect(controller.switchAccount(second.workspace.accountId)).rejects.toThrow('disk full')
    expect(api.switchAccount).not.toHaveBeenCalled()
    expect(controller.getState().snapshot!.workspace.accountId).toBe(first.workspace.accountId)
    expect(controller.getState().status).toBe('error')
    await controller.switchAccount(second.workspace.accountId)
    expect(api.switchAccount).toHaveBeenCalledOnce()
    controller.updateWidget(first.workspace.accountId, widget.id, 'data', { count: 999 })
    expect(controller.getState().snapshot!.workspace.widgets).toEqual([])
    expect(controller.getState().status).toBe('saved')
  })
  it('flushes changes made while an earlier write is in flight', async () => {
    const { controller, api, saved } = setup()
    await controller.load()
    controller.addWidget('starter.counter')
    let release!: () => void
    vi.mocked(api.save).mockImplementationOnce(async (workspace) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      saved.push(structuredClone(workspace))
    })
    const flush = controller.flush()
    const doc = controller.getState().snapshot!.workspace
    controller.updateWidget(doc.accountId, doc.widgets[0].id, 'data', { count: 8 })
    release()
    await flush
    expect(saved).toHaveLength(2)
    expect(saved[1].widgets[0].data).toEqual({ count: 8 })
    expect(controller.getState().status).toBe('saved')
  })
  it('rearranges while preserving instances, configuration and contents', async () => {
    const { controller } = setup()
    await controller.load()
    controller.addWidget('starter.counter')
    controller.addWidget('starter.text')
    const original = controller.getState().snapshot!.workspace
    controller.setLayout(
      original.widgets.map((widget, i) => ({ i: widget.id, x: i * 5, y: 10, w: 5, h: 9 })),
    )
    controller.rearrange()
    const next = controller.getState().snapshot!.workspace
    expect(next.widgets.map((widget) => ({ ...widget, layout: null }))).toEqual(
      original.widgets.map((widget) => ({ ...widget, layout: null })),
    )
    expect(next.widgets.map((widget) => widget.layout)).toEqual([
      { x: 0, y: 0, w: 4, h: 7 },
      { x: 4, y: 0, w: 4, h: 7 },
    ])
    await controller.flush()
  })
})
