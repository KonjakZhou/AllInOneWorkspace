import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from '../electron/storage/workspace-store'
import { JsonFiles } from '../electron/storage/json-files'
import { parseIndex, parseWorkspace, type WidgetInstance } from '../src/shared/model'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-test-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})
function sample(count = 0): WidgetInstance {
  return {
    id: randomUUID(),
    type: 'starter.counter',
    version: 1,
    config: { title: '计数', step: 1 },
    data: { count },
    layout: { x: 0, y: 0, w: 4, h: 7 },
  }
}

describe('local account persistence', () => {
  it('creates one default workspace and restores it across processes', async () => {
    const store = new WorkspaceStore(directory)
    const initial = await store.load()
    expect(initial.index.accounts[0].name).toBe('默认账号')
    initial.workspace.widgets = [sample(42)]
    await store.save(initial.workspace)
    const restored = await new WorkspaceStore(directory).load()
    expect(restored.workspace).toEqual(initial.workspace)
  })
  it('isolates data and layout even when accounts have the same instance ID', async () => {
    const store = new WorkspaceStore(directory)
    const first = await store.load()
    first.workspace.widgets = [sample(3)]
    await store.save(first.workspace)
    const second = await store.createAccount('工作')
    second.workspace.widgets = [
      { ...first.workspace.widgets[0], data: { count: 99 }, layout: { x: 6, y: 2, w: 5, h: 8 } },
    ]
    await store.save(second.workspace)
    expect((await store.switchAccount(first.workspace.accountId)).workspace).toEqual(
      first.workspace,
    )
    expect((await store.switchAccount(second.workspace.accountId)).workspace).toEqual(
      second.workspace,
    )
    expect((await new WorkspaceStore(directory).load()).index.activeAccountId).toBe(
      second.workspace.accountId,
    )
  })
  it('serializes concurrent saves and continues the queue after a failure', async () => {
    const store = new WorkspaceStore(directory)
    const initial = await store.load()
    await expect(store.save({ ...initial.workspace, accountId: randomUUID() })).rejects.toThrow(
      '账号不存在',
    )
    const widget = sample()
    await Promise.all(
      [1, 2, 3].map((count) =>
        store.save({ ...initial.workspace, widgets: [{ ...widget, data: { count } }] }),
      ),
    )
    expect((await store.load()).workspace.widgets[0].data).toEqual({ count: 3 })
  })
  it('renames, deletes safely, rejects missing accounts and keeps at least one account', async () => {
    const store = new WorkspaceStore(directory)
    const first = await store.load()
    await expect(store.deleteAccount(first.workspace.accountId)).rejects.toThrow('至少')
    const second = await store.createAccount('生活')
    await store.renameAccount(second.workspace.accountId, '灵感空间')
    expect((await store.load()).index.accounts[1].name).toBe('灵感空间')
    await expect(store.renameAccount(second.workspace.accountId, '默认账号')).rejects.toThrow(
      '同名',
    )
    const result = await store.deleteAccount(second.workspace.accountId)
    expect(result.index.activeAccountId).toBe(first.workspace.accountId)
    expect(
      (await readdir(join(directory, 'accounts'))).some((file) =>
        file.startsWith(second.workspace.accountId),
      ),
    ).toBe(false)
    await expect(store.switchAccount('../../elsewhere')).rejects.toThrow()
    await expect(store.save(second.workspace)).rejects.toThrow('账号不存在')
  })
})

describe('import, migration and recovery', () => {
  it('imports into a new account and preserves unknown component data', async () => {
    const store = new WorkspaceStore(directory)
    const original = await store.load()
    original.workspace.widgets = [
      { ...sample(7), type: 'custom.unknown', version: 12, config: { nested: ['future', 1] } },
    ]
    await store.save(original.workspace)
    const exported = await store.exportAccount(original.workspace.accountId)
    const imported = await store.importAccount(exported)
    expect(imported.workspace.accountId).not.toBe(original.workspace.accountId)
    expect(imported.index.accounts[1].name).toBe('默认账号 (2)')
    expect(imported.workspace.widgets).toEqual(original.workspace.widgets)
    expect((await store.switchAccount(original.workspace.accountId)).workspace).toEqual(
      original.workspace,
    )
  })
  it('rejects invalid/future imports without changing existing files', async () => {
    const store = new WorkspaceStore(directory)
    const original = await store.load()
    const data = await store.exportAccount(original.workspace.accountId)
    const before = await readFile(join(directory, 'accounts.json'), 'utf8')
    await expect(store.importAccount({ ...data, schemaVersion: 99 })).rejects.toThrow('更新版本')
    await expect(
      store.importAccount({
        ...data,
        workspace: { ...data.workspace, widgets: [sample(), { ...sample(), id: 'bad' }] },
      }),
    ).rejects.toThrow()
    await expect(
      store.importAccount({
        ...data,
        workspace: { ...data.workspace, widgets: [sample(), sample()] },
      }),
    ).rejects.toThrow()
    expect(await readFile(join(directory, 'accounts.json'), 'utf8')).toBe(before)
    expect((await readdir(join(directory, 'accounts'))).length).toBe(1)
  })
  it('migrates v0 workspace and import envelopes', async () => {
    const store = new WorkspaceStore(directory)
    const original = await store.load()
    const exported = await store.exportAccount(original.workspace.accountId)
    const widget = sample(8)
    const { version: _version, ...legacyWidget } = widget
    const result = await store.importAccount({
      ...exported,
      schemaVersion: 0,
      workspace: { ...original.workspace, schemaVersion: 0, widgets: [legacyWidget] },
    })
    expect(result.workspace.schemaVersion).toBe(2)
    expect(result.workspace.savedWidgets).toEqual([])
    expect(result.workspace.widgets[0]).toEqual(widget)
  })
  it('restores validated backup, preserves damaged original and reports recovery', async () => {
    const store = new WorkspaceStore(directory)
    const initial = await store.load()
    const path = join(directory, 'accounts', `${initial.workspace.accountId}.json`)
    const widget = sample(1)
    await store.save({ ...initial.workspace, widgets: [widget] })
    await store.save({ ...initial.workspace, widgets: [{ ...widget, data: { count: 2 } }] })
    await writeFile(path, '{broken')
    const restored = await new WorkspaceStore(directory).load()
    expect(restored.workspace.widgets[0].data).toEqual({ count: 1 })
    expect(restored.notices[0]).toContain('备份恢复')
    const corrupt = (await readdir(join(directory, 'accounts'))).find((file) =>
      file.includes('.corrupt-'),
    )!
    expect(await readFile(join(directory, 'accounts', corrupt), 'utf8')).toBe('{broken')
  })
  it('does not overwrite an unreadable or future-version document', async () => {
    const store = new WorkspaceStore(directory)
    const initial = await store.load()
    const path = join(directory, 'accounts', `${initial.workspace.accountId}.json`)
    await writeFile(path, '{broken')
    await expect(new WorkspaceStore(directory).load()).rejects.toThrow('原文件已保留')
    expect(await readFile(path, 'utf8')).toBe('{broken')
    await writeFile(path, JSON.stringify({ ...initial.workspace, schemaVersion: 9 }))
    await writeFile(path + '.bak', JSON.stringify(initial.workspace))
    await expect(new WorkspaceStore(directory).load()).rejects.toThrow('更新版本')
    expect(JSON.parse(await readFile(path, 'utf8')).schemaVersion).toBe(9)
  })
  it('preserves the previous value when a write fails and permits a later retry', async () => {
    class FailingFiles extends JsonFiles {
      fail = false
      override async write(path: string, value: unknown, previous?: unknown) {
        if (this.fail && path.includes('/accounts/')) throw new Error('disk full')
        return super.write(path, value, previous)
      }
    }
    const files = new FailingFiles(),
      store = new WorkspaceStore(directory, files)
    const initial = await store.load()
    files.fail = true
    await expect(store.save({ ...initial.workspace, widgets: [sample()] })).rejects.toThrow(
      'disk full',
    )
    expect((await store.load()).workspace.widgets).toEqual([])
    files.fail = false
    await store.save({ ...initial.workspace, widgets: [sample()] })
    expect((await store.load()).workspace.widgets).toHaveLength(1)
  })
})

describe('retained card persistence', () => {
  const record = (name = '计数进度') => ({
    id: randomUUID(),
    name,
    savedAt: new Date().toISOString(),
    widget: sample(42),
  })

  it('migrates v1 files and exports to v2 with no records; index still rejects newer versions', async () => {
    const store = new WorkspaceStore(directory)
    const initial = await store.load()
    const legacy = {
      schemaVersion: 1,
      accountId: initial.workspace.accountId,
      widgets: [sample(10)],
    }
    await writeFile(join(directory, 'accounts', `${legacy.accountId}.json`), JSON.stringify(legacy))
    expect((await store.load()).workspace).toEqual({
      ...legacy,
      schemaVersion: 2,
      savedWidgets: [],
    })
    const imported = await store.importAccount({
      ...(await store.exportAccount(legacy.accountId)),
      schemaVersion: 1,
      workspace: legacy,
    })
    expect(imported.workspace.widgets).toEqual(legacy.widgets)
    expect(imported.workspace.savedWidgets).toEqual([])
    expect(() => parseIndex({ ...initial.index, schemaVersion: 2 })).toThrow('更新版本')
  })

  it('persists independent records across restart/export/import without changing the source account', async () => {
    const store = new WorkspaceStore(directory)
    const initial = await store.load()
    const savedWidgets = [record('阅读'), record('运动')]
    const workspace = { ...initial.workspace, savedWidgets }
    await store.save(workspace)
    expect((await new WorkspaceStore(directory).load()).workspace).toEqual(workspace)
    const exported = await store.exportAccount(workspace.accountId)
    expect(exported.schemaVersion).toBe(2)
    const imported = await store.importAccount(exported)
    expect(imported.workspace.savedWidgets).toEqual(savedWidgets)
    await store.save({ ...imported.workspace, savedWidgets: [savedWidgets[1]] })
    expect((await store.switchAccount(workspace.accountId)).workspace.savedWidgets).toEqual(
      savedWidgets,
    )
  })

  it('prevents removed cards and deleted records from returning through recovery backups', async () => {
    const store = new WorkspaceStore(directory)
    const initial = await store.load()
    const widget = sample(18)
    const path = join(directory, 'accounts', `${initial.workspace.accountId}.json`)
    await store.save({ ...initial.workspace, widgets: [widget] })
    const retained = { ...record(), widget }
    await store.save({ ...initial.workspace, savedWidgets: [retained] })
    await writeFile(path, '{broken')
    const recovered = (await store.load()).workspace
    expect(recovered.widgets).toEqual([])
    expect(recovered.savedWidgets).toEqual([retained])
    // Restore consumes the record and assigns a fresh instance identity.
    await store.save({ ...initial.workspace, widgets: [{ ...widget, id: randomUUID() }] })
    expect(JSON.parse(await readFile(path + '.bak', 'utf8')).savedWidgets).toEqual([])
    await store.save(initial.workspace)
    for (const suffix of ['', '.bak']) {
      const file = await readFile(path + suffix, 'utf8')
      expect(JSON.parse(file)).toEqual(initial.workspace)
      expect(file).not.toContain('"count"')
    }
    await writeFile(path, '{broken')
    expect((await store.load()).workspace).toEqual(initial.workspace)
    await store.save({ ...initial.workspace, savedWidgets: [record()] })
    await store.save(initial.workspace)
    expect(JSON.parse(await readFile(path + '.bak', 'utf8')).savedWidgets).toEqual([])
  })

  it('rejects invalid records and duplicate identities but allows overlap between retained layouts', async () => {
    const initial = await new WorkspaceStore(directory).load()
    const a = record(),
      b = record()
    expect(
      parseWorkspace({ ...initial.workspace, savedWidgets: [a, b] }).savedWidgets,
    ).toHaveLength(2)
    for (const savedWidgets of [
      [a, a],
      [{ ...a, savedAt: 'bad' }],
      [{ ...a, name: '' }],
      [{ ...a, widget: { ...a.widget, data: undefined } }],
    ])
      expect(() => parseWorkspace({ ...initial.workspace, savedWidgets })).toThrow()
    expect(() =>
      parseWorkspace({ ...initial.workspace, widgets: [a.widget], savedWidgets: [a] }),
    ).toThrow('重复')
  })
})
