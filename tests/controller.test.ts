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
    updates: {} as DesktopAPI['updates'],
    feishu: {} as DesktopAPI['feishu'], // Workspace persistence never calls external connections.
    telegraph: {} as DesktopAPI['telegraph'], // Workspace persistence never calls public news.
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

describe('saved card records', () => {
  it('keeps same-type instances independently and restores only the chosen record into free space', async () => {
    const { controller, saved } = setup()
    await controller.load()
    controller.addWidget('starter.counter')
    controller.addWidget('starter.counter')
    const {
      accountId,
      widgets: [a, b],
    } = controller.getState().snapshot!.workspace
    controller.updateWidget(accountId, a.id, 'data', { count: 3 })
    controller.updateWidget(accountId, b.id, 'data', { count: 17 })
    controller.updateWidget(accountId, a.id, 'config', { title: '阅读', step: 2 })
    controller.removeWidget(a.id, 'keep', '阅读进度')
    controller.removeWidget(b.id, 'keep', '锻炼次数')
    const records = controller.getState().snapshot!.workspace.savedWidgets
    expect(records.map((record) => record.widget.data)).toEqual([{ count: 3 }, { count: 17 }])
    expect(new Set(records.map((record) => record.id)).size).toBe(2)
    controller.addWidget('starter.text')
    controller.restoreWidget(records[0].id)
    const restored = controller.getState().snapshot!.workspace
    expect(restored.savedWidgets).toEqual([records[1]])
    expect(restored.widgets[1]).toMatchObject({
      config: { title: '阅读', step: 2 },
      data: { count: 3 },
      layout: { x: 4, y: 0, w: 4, h: 7 },
    })
    expect(restored.widgets[1].id).not.toBe(a.id)
    controller.updateWidget(accountId, a.id, 'data', { count: 999 })
    expect(controller.getState().snapshot!.workspace).toBe(restored)
    await controller.flush()
    expect(saved.at(-1)).toEqual(restored)
  })

  it('deletes only the selected card or saved record and permits adding a fresh instance', async () => {
    const { controller } = setup()
    await controller.load()
    controller.addWidget('starter.counter')
    controller.addWidget('starter.counter')
    const [a, b] = controller.getState().snapshot!.workspace.widgets
    controller.removeWidget(a.id, 'keep', '保留')
    controller.removeWidget(b.id, 'delete')
    let doc = controller.getState().snapshot!.workspace
    expect(doc.widgets).toEqual([])
    expect(doc.savedWidgets.map((record) => record.widget.id)).toEqual([a.id])
    controller.addWidget('starter.counter')
    expect(controller.getState().snapshot!.workspace.savedWidgets).toHaveLength(1)
    controller.deleteSavedWidget(doc.savedWidgets[0].id)
    doc = controller.getState().snapshot!.workspace
    expect(doc.savedWidgets).toEqual([])
    expect(doc.widgets[0].data).toEqual({ count: 0 })
    await controller.flush()
  })

  it('keeps records isolated to their account and flushes them before switching', async () => {
    const { controller, api, saved, first, second } = setup()
    await controller.load()
    controller.addWidget('starter.counter')
    controller.removeWidget(
      controller.getState().snapshot!.workspace.widgets[0].id,
      'keep',
      '账号一的记录',
    )
    const record = controller.getState().snapshot!.workspace.savedWidgets[0]
    await controller.switchAccount(second.workspace.accountId)
    expect(saved[0].savedWidgets).toEqual([record])
    expect(controller.getState().snapshot!.workspace.savedWidgets).toEqual([])
    expect(() => controller.restoreWidget(record.id)).toThrow('已不存在')
    vi.mocked(api.switchAccount).mockResolvedValueOnce({ ...first, workspace: saved[0] })
    await controller.switchAccount(first.workspace.accountId)
    controller.restoreWidget(record.id)
    expect(controller.getState().snapshot!.workspace.widgets[0].id).not.toBe(record.widget.id)
    await controller.flush()
  })

  it('retains removal edits on failed save and does not switch until retry succeeds', async () => {
    const { controller, api, second, saved } = setup()
    await controller.load()
    controller.addWidget('starter.counter')
    await controller.flush()
    controller.removeWidget(
      controller.getState().snapshot!.workspace.widgets[0].id,
      'keep',
      '稍后继续',
    )
    vi.mocked(api.save).mockRejectedValueOnce(new Error('disk full'))
    await expect(controller.switchAccount(second.workspace.accountId)).rejects.toThrow('disk full')
    expect(controller.getState().snapshot!.workspace.savedWidgets).toHaveLength(1)
    expect(api.switchAccount).not.toHaveBeenCalled()
    await controller.flush()
    expect(saved.at(-1)?.savedWidgets[0].name).toBe('稍后继续')
  })

  it('migrates records on restoration, preserves failed migrations, and restores missing types as placeholders', async () => {
    const { api, first } = setup()
    const definition = widgetRegistry.get('starter.counter')!
    const widget = {
      id: randomUUID(),
      type: definition.type,
      version: 1,
      config: definition.defaultConfig,
      data: { count: 12 },
      layout: { x: 0, y: 0, w: 4, h: 7 },
    }
    const records = [
      { id: randomUUID(), name: '旧记录', savedAt: new Date().toISOString(), widget },
      {
        id: randomUUID(),
        name: '新版记录',
        savedAt: new Date().toISOString(),
        widget: { ...widget, id: randomUUID(), version: 99 },
      },
      {
        id: randomUUID(),
        name: '缺失组件',
        savedAt: new Date().toISOString(),
        widget: {
          ...widget,
          id: randomUUID(),
          type: 'custom.missing',
          data: { nested: ['原始数据'] },
        },
      },
    ]
    first.workspace.savedWidgets = records
    const migrate = vi.fn(() => ({ config: definition.defaultConfig, data: { count: 24 } }))
    const controller = new WorkspaceController(
      api,
      new Map([[definition.type, { ...definition, version: 2, minSize: { w: 5, h: 8 }, migrate }]]),
    )
    await controller.load()
    expect(migrate).not.toHaveBeenCalled()
    expect(() => controller.restoreWidget(records[1].id)).toThrow('更新版本')
    expect(controller.getState().snapshot!.workspace.savedWidgets).toEqual(records)
    controller.restoreWidget(records[0].id)
    expect(controller.getState().snapshot!.workspace.widgets[0]).toMatchObject({
      version: 2,
      data: { count: 24 },
      layout: { w: 5, h: 8 },
    })
    controller.restoreWidget(records[2].id)
    expect(controller.getState().snapshot!.workspace.widgets[1].data).toEqual({
      nested: ['原始数据'],
    })
    expect(controller.getState().snapshot!.workspace.savedWidgets).toEqual([records[1]])
    await controller.flush()
  })
})

it('locks edits before update flush, cancels installation on save failure, and stays locked on success', async () => {
  const { controller, api } = setup()
  api.updates.install = vi.fn(async () => {})
  await controller.load()
  controller.addWidget('starter.counter')
  vi.mocked(api.save).mockRejectedValueOnce(new Error('disk full'))
  await expect(controller.installUpdate()).rejects.toThrow('disk full')
  expect(api.updates.install).not.toHaveBeenCalled()
  expect(controller.getState().busy).toBe(false)
  let finish!: () => void
  vi.mocked(api.save).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const pending = controller.installUpdate()
  const before = controller.getState().snapshot!.workspace.widgets.length
  controller.addWidget('starter.counter')
  expect(controller.getState().snapshot!.workspace.widgets).toHaveLength(before)
  finish()
  await pending
  expect(api.updates.install).toHaveBeenCalledOnce()
  expect(controller.getState().busy).toBe(true)
})
