import type { DesktopAPI } from '../shared/api'
import {
  errorMessage,
  jsonSchema,
  workspaceSchema,
  type Json,
  type Snapshot,
  type WidgetInstance,
  type Workspace,
} from '../shared/model'
import { prepareWidget } from '../sdk/registry'
import type { AnyWidgetDefinition, Update } from '../sdk/types'

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error'
export type ControllerState = {
  snapshot: Snapshot | null
  status: SaveStatus
  error: string | null
  busy: boolean
  notice: string | null
}
export class WorkspaceController {
  private state: ControllerState = {
    snapshot: null,
    status: 'saved',
    error: null,
    busy: false,
    notice: null,
  }
  private listeners = new Set<() => void>()
  private revision = 0
  private savedRevision = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<void> | null = null
  constructor(
    private api: DesktopAPI,
    readonly registry: Map<string, AnyWidgetDefinition>,
  ) {}
  getState = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private emit(patch: Partial<ControllerState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }
  dismissNotice = () => this.emit({ notice: null })
  showError = (error: unknown) => this.emit({ error: errorMessage(error) })
  private accept(snapshot: Snapshot) {
    const widgets = snapshot.workspace.widgets.map((widget) => {
      try {
        return prepareWidget(widget, this.registry.get(widget.type))
      } catch {
        return widget
      }
    })
    const migrated = JSON.stringify(widgets) !== JSON.stringify(snapshot.workspace.widgets)
    this.revision = migrated ? 1 : 0
    this.savedRevision = 0
    this.emit({
      snapshot: { ...snapshot, workspace: { ...snapshot.workspace, widgets } },
      status: migrated ? 'dirty' : 'saved',
      error: null,
      notice: snapshot.notices.join(' ') || null,
    })
    if (migrated) this.schedule()
  }
  async load() {
    this.emit({ busy: true, error: null })
    try {
      this.accept(await this.api.load())
    } catch (error) {
      this.showError(error)
    } finally {
      this.emit({ busy: false })
    }
  }
  private schedule() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.flush().catch(() => undefined)
    }, 350)
  }
  private change(update: (workspace: Workspace) => Workspace) {
    if (!this.state.snapshot || this.state.busy) return
    const workspace = workspaceSchema.parse(update(this.state.snapshot.workspace))
    this.revision++
    this.emit({ snapshot: { ...this.state.snapshot, workspace }, status: 'dirty', error: null })
    this.schedule()
  }
  flush = async (): Promise<void> => {
    clearTimeout(this.timer)
    if (this.saving) {
      await this.saving
      return this.flush()
    }
    if (!this.state.snapshot || this.revision === this.savedRevision) return
    const workspace = this.state.snapshot.workspace
    const revision = this.revision
    this.emit({ status: 'saving' })
    this.saving = this.api
      .save(workspace)
      .then(() => {
        this.savedRevision = revision
        this.emit({ status: this.revision === revision ? 'saved' : 'dirty', error: null })
      })
      .catch((error) => {
        this.emit({ status: 'error', error: errorMessage(error) })
        throw error
      })
      .finally(() => {
        this.saving = null
      })
    await this.saving
    if (this.revision !== this.savedRevision) return this.flush()
  }
  async transaction(action: () => Promise<Snapshot | null>): Promise<void> {
    if (this.state.busy) return
    this.emit({ busy: true, error: null })
    try {
      await this.flush()
      const snapshot = await action()
      if (snapshot) this.accept(snapshot)
    } catch (error) {
      this.showError(error)
      throw error
    } finally {
      this.emit({ busy: false })
    }
  }
  switchAccount(id: string) {
    return this.transaction(() => this.api.switchAccount(id))
  }
  createAccount(name: string) {
    return this.transaction(() => this.api.createAccount(name))
  }
  renameAccount(id: string, name: string) {
    return this.transaction(() => this.api.renameAccount(id, name))
  }
  deleteAccount(id: string) {
    return this.transaction(() => this.api.deleteAccount(id))
  }
  importAccount() {
    return this.transaction(() => this.api.importAccount())
  }
  async exportAccount() {
    const id = this.state.snapshot?.workspace.accountId
    if (!id) return
    await this.transaction(async () => {
      if (await this.api.exportAccount(id))
        this.emit({ notice: '账号已导出，可以在另一台设备导入。' })
      return null
    })
  }
  addWidget(type: string) {
    const definition = this.registry.get(type)
    if (!definition) return
    this.change((workspace) => ({
      ...workspace,
      widgets: [
        ...workspace.widgets,
        {
          id: crypto.randomUUID(),
          type,
          version: definition.version,
          config: jsonSchema.parse(definition.configSchema.parse(definition.defaultConfig)),
          data: jsonSchema.parse(definition.dataSchema.parse(definition.defaultData)),
          layout: availablePosition(workspace.widgets, definition.defaultSize),
        },
      ],
    }))
  }
  removeWidget(id: string) {
    this.change((workspace) => ({
      ...workspace,
      widgets: workspace.widgets.filter((widget) => widget.id !== id),
    }))
  }
  updateWidget(accountId: string, id: string, field: 'config' | 'data', value: Update<Json>) {
    if (this.state.snapshot?.workspace.accountId !== accountId) return
    this.change((workspace) => ({
      ...workspace,
      widgets: workspace.widgets.map((widget) => {
        if (widget.id !== id) return widget
        const definition = this.registry.get(widget.type)
        if (!definition) return widget
        const next = typeof value === 'function' ? value(widget[field]) : value
        const parsed = (field === 'config' ? definition.configSchema : definition.dataSchema).parse(
          next,
        )
        return { ...widget, [field]: jsonSchema.parse(parsed) }
      }),
    }))
  }
  setLayout(layout: { i: string; x: number; y: number; w: number; h: number }[]) {
    this.change((workspace) => ({
      ...workspace,
      widgets: workspace.widgets.map((widget) => {
        const item = layout.find((item) => item.i === widget.id)
        return item ? { ...widget, layout: { x: item.x, y: item.y, w: item.w, h: item.h } } : widget
      }),
    }))
  }
  rearrange() {
    this.change((workspace) => {
      let x = 0,
        y = 0,
        rowHeight = 0
      const widgets: WidgetInstance[] = workspace.widgets.map((widget) => {
        const size = this.registry.get(widget.type)?.defaultSize ?? {
          w: widget.layout.w,
          h: widget.layout.h,
        }
        if (x + size.w > 12) {
          x = 0
          y += rowHeight
          rowHeight = 0
        }
        const next = { ...widget, layout: { x, y, ...size } }
        x += size.w
        rowHeight = Math.max(rowHeight, size.h)
        return next
      })
      return { ...workspace, widgets }
    })
  }
}

function availablePosition(widgets: WidgetInstance[], size: { w: number; h: number }) {
  const rows = [
    ...new Set([0, ...widgets.map((widget) => widget.layout.y + widget.layout.h)]),
  ].sort((a, b) => a - b)
  for (const y of rows)
    for (let x = 0; x <= 12 - size.w; x++) {
      if (
        !widgets.some(
          ({ layout: b }) => x < b.x + b.w && x + size.w > b.x && y < b.y + b.h && y + size.h > b.y,
        )
      )
        return { x, y, ...size }
    }
  throw new Error('当前工作区没有可用的布局位置')
}
