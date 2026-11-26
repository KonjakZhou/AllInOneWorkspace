import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from 'react'
import GridLayout, { useContainerWidth, type Compactor, type Layout } from 'react-grid-layout'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  CircleHelp,
  Columns3,
  Grid2X2,
  LayoutGrid,
  LoaderCircle,
  Pencil,
  Plus,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { version } from '../package.json'
import { widgetRegistry } from './widgets'
import { WorkspaceController } from './workspace/controller'
import { UpdateEntry } from './components/UpdateEntry'
import { UpdateSettings, useUpdates } from './components/UpdateSettings'
import { Modal } from './components/Modal'
import { WidgetCard } from './components/WidgetCard'
import { WidgetLibrary } from './components/WidgetLibrary'
import { RemoveWidgetDialog } from './components/RemoveWidgetDialog'
import { FeishuConnectionSettings } from './components/FeishuConnectionSettings'
import type { Account } from './shared/model'
import { errorMessage } from './shared/model'
import { alignDisplacedCards } from './workspace/layout'
import type { IdeaView } from './shared/trading-ideas'
import IdeasPage from './trading-ideas/IdeasPage'
import { OpenIdeasPage } from './trading-ideas/navigation'

const api = window.workspace
const controller = api ? new WorkspaceController(api, widgetRegistry) : null
type Dialog =
  | null
  | 'library'
  | 'accounts'
  | 'settings'
  | 'updates'
  | { kind: 'remove-widget'; id: string }
  | { kind: 'delete-account'; account: Account }

export default function App() {
  if (!controller)
    return (
      <div className="fatal-screen">
        <LayoutGrid size={32} />
        <h1>请在桌面应用中打开</h1>
        <p>这个工作区需要本地桌面服务。请使用 pnpm dev 启动应用。</p>
      </div>
    )
  return <WorkspaceNavigation controller={controller} />
}

function WorkspaceNavigation({ controller }: { controller: WorkspaceController }) {
  const [selection, setSelection] = useState<IdeaView | null>(null)
  const returnPoint = useRef<{ trigger: HTMLButtonElement; x: number; y: number } | null>(null)
  const accountId = useSyncExternalStore(
    controller.subscribe,
    () => controller.getState().snapshot?.index.activeAccountId,
  )
  const view = selection?.accountId === accountId ? selection : null

  const open = useCallback((next: IdeaView, trigger: HTMLButtonElement) => {
    returnPoint.current = { trigger, x: window.scrollX, y: window.scrollY }
    setSelection(next)
  }, [])

  useLayoutEffect(() => {
    if (view) {
      const root = document.documentElement
      const oldOverflow = root.style.overflow
      root.style.overflow = 'hidden'
      return () => {
        root.style.overflow = oldOverflow
      }
    }
    if (selection) setSelection(null)
    const previous = returnPoint.current
    if (!previous) return
    returnPoint.current = null
    window.scrollTo({ left: previous.x, top: previous.y, behavior: 'instant' })
    if (previous.trigger.isConnected) previous.trigger.focus({ preventScroll: true })
  }, [selection, view])

  return (
    <OpenIdeasPage.Provider value={open}>
      <div className={view ? 'workspace-behind-ideas' : undefined} inert={Boolean(view)}>
        <WorkspaceApp controller={controller} />
      </div>
      {view && (
        <div className="ideas-screen">
          <WorkspaceTitlebar />
          <IdeasPage key={view.accountId} view={view} onBack={() => setSelection(null)} />
        </div>
      )}
    </OpenIdeasPage.Provider>
  )
}

function WorkspaceTitlebar() {
  return (
    <div className="titlebar">
      <span>
        ALL IN ONE <span className="titlebar-divider">/</span> YOUR PERSONAL SPACE
      </span>
      <span className="local-indicator">
        <i />
        LOCAL FIRST
      </span>
    </div>
  )
}

function WorkspaceApp({ controller }: { controller: WorkspaceController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [editing, setEditing] = useState(false)
  const updateState = useUpdates(api.updates)
  const [dismissedUpdate, setDismissedUpdate] = useState<string | undefined>()
  const dragOrigin = useRef<{ id: string; layout: Layout } | null>(null)
  const displacementCompactor = useMemo<Compactor>(
    () => ({
      type: null,
      allowOverlap: false,
      compact(next) {
        const origin = dragOrigin.current
        return origin
          ? alignDisplacedCards(next, origin.layout, origin.id)
          : next.map((item) => ({ ...item }))
      },
    }),
    [],
  )
  useEffect(() => {
    // Modal restoration must know the input method even if :focus-visible is still sticky.
    const root = document.documentElement
    const pointer = () => {
      root.dataset.inputMethod = 'pointer'
    }
    const keyboard = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey && !event.altKey) root.dataset.inputMethod = 'keyboard'
    }
    document.addEventListener('pointerdown', pointer, true)
    document.addEventListener('keydown', keyboard, true)
    return () => {
      document.removeEventListener('pointerdown', pointer, true)
      document.removeEventListener('keydown', keyboard, true)
      delete root.dataset.inputMethod
    }
  }, [])
  useEffect(() => {
    void controller.load()
    return api.onCloseRequested(async () => {
      try {
        await controller.flush()
        await api.finishClose()
      } catch {
        /* The save error remains visible; closing is cancelled. */
      }
    })
  }, [controller])
  const snapshot = state.snapshot
  const perform = async (action: () => Promise<unknown>, close = false) => {
    try {
      await action()
      if (close) setDialog(null)
    } catch {
      /* Controller publishes actionable errors. */
    }
  }
  const local = (action: () => void) => {
    try {
      action()
    } catch (error) {
      controller.showError(error)
    }
  }
  if (!snapshot)
    return (
      <div className="fatal-screen">
        <div className="brand-mark large">
          <LayoutGrid size={30} />
        </div>
        <h1>{state.error ? '暂时无法打开工作区' : '正在准备你的工作区'}</h1>
        <p>{state.error ?? '所有美好的开始，都需要一点空间。'}</p>
        {state.error ? (
          <button className="button primary" onClick={() => void controller.load()}>
            重新读取
          </button>
        ) : (
          <LoaderCircle className="spin" size={20} />
        )}
      </div>
    )
  const account = snapshot.index.accounts.find(
    (account) => account.id === snapshot.index.activeAccountId,
  )!
  const widgets = snapshot.workspace.widgets
  const today = new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date())
  const saveLabels = {
    saved: '所有更改已保存',
    dirty: '有待保存的更改',
    saving: '正在保存…',
    error: '保存失败 · 点击重试',
  }
  const layout = widgets.map((widget) => ({
    i: widget.id,
    ...widget.layout,
    minW: widgetRegistry.get(widget.type)?.minSize.w ?? 1,
    minH: widgetRegistry.get(widget.type)?.minSize.h ?? 2,
  }))
  const commitLayout = (next: Layout) => local(() => controller.setLayout([...next]))
  return (
    <div className="app-shell">
      <WorkspaceTitlebar />
      {updateState?.phase === 'ready' && updateState.version !== dismissedUpdate && (
        <aside className="update-banner" role="status">
          <span>
            v{updateState.version} 已下载
            {updateState.canInstall
              ? '，准备好后可以重启安装。'
              : '，请安装到可写的应用程序目录后更新。'}
          </span>
          <button className="button" disabled={state.busy} onClick={() => setDialog('updates')}>
            查看更新
          </button>
          <button
            className="icon-button"
            aria-label="稍后更新"
            onClick={() => setDismissedUpdate(updateState.version)}
          >
            <X size={16} />
          </button>
        </aside>
      )}
      <header className="toolbar">
        <div className="brand">
          <div className="brand-mark">
            <LayoutGrid size={23} strokeWidth={1.8} />
          </div>
          <div>
            <h1>
              我的工作区<span className="brand-dot">.</span>
            </h1>
            <p>给想法和日常，一个刚刚好的位置。</p>
          </div>
        </div>
        <div className="toolbar-actions">
          <button
            className={`button ${editing ? 'editing-button' : ''}`}
            onClick={() => setEditing(!editing)}
            disabled={state.busy}
            aria-pressed={editing}
          >
            {editing ? <Check size={16} /> : <SlidersHorizontal size={16} />}
            {editing ? '完成编辑' : '编辑布局'}
          </button>
          {editing && (
            <button
              className="button primary"
              onClick={() => setDialog('library')}
              disabled={state.busy}
            >
              <Plus size={17} />
              添加组件
            </button>
          )}
          <UpdateEntry
            state={updateState}
            disabled={state.busy}
            onClick={() => setDialog('updates')}
          />
          <span className="toolbar-separator" />
          <button
            className="icon-button settings-button"
            aria-label="应用设置"
            onClick={() => setDialog('settings')}
            disabled={state.busy}
          >
            <Settings2 size={20} />
          </button>
          <button
            className="account-button"
            onClick={() => setDialog('accounts')}
            disabled={state.busy}
            aria-label="管理账号"
          >
            <span className="avatar">{account.name.slice(0, 1)}</span>
            <span className="account-name">{account.name}</span>
            <ChevronDown size={14} />
          </button>
        </div>
      </header>
      <main className="workspace-main" aria-busy={state.busy}>
        <section className="workspace-heading">
          <div>
            <span className="eyebrow">YOUR WORKSPACE</span>
            <h2>
              {account.name === '默认账号' ? '从这里，开始今天' : `${account.name}的工作区`}
              <span className="heading-dot" />
            </h2>
            <p>
              {widgets.length
                ? `${widgets.length} 个组件，各就各位。按自己的节奏，做重要的事。`
                : '一张空白画布，无限种属于你的可能。'}
            </p>
          </div>
          <div className="workspace-meta">
            <span>{today}</span>
            <button
              className={`save-state ${state.status === 'error' ? 'save-error' : ''}`}
              onClick={() => void perform(controller.flush)}
              aria-label={saveLabels[state.status]}
              disabled={state.status !== 'error'}
            >
              {state.status === 'saving' ? <LoaderCircle size={12} className="spin" /> : <i />}
              {saveLabels[state.status]}
            </button>
          </div>
        </section>
        {(state.error || state.notice) && (
          <div
            className={`notice ${state.error ? 'notice-error' : ''}`}
            role={state.error ? 'alert' : 'status'}
          >
            <span>{state.error ?? state.notice}</span>
            {state.status === 'error' && (
              <button className="quiet-button" onClick={() => void perform(controller.flush)}>
                重试保存
              </button>
            )}
            {!state.error && (
              <button
                className="icon-button compact"
                aria-label="关闭提示"
                onClick={controller.dismissNotice}
              >
                <X size={16} />
              </button>
            )}
          </div>
        )}
        {editing && (
          <div className="edit-banner">
            <span>
              <Grid2X2 size={16} />
              正在编辑布局{' '}
              <small>拖动卡片左上角调整位置，拖动右下角调整大小。更改会自动保存。</small>
            </span>
            <button
              className="quiet-button"
              onClick={() => local(() => controller.rearrange())}
              disabled={state.busy || !widgets.length}
            >
              重新整理布局
            </button>
          </div>
        )}
        <Canvas
          className={`canvas ${editing ? 'canvas-editing' : ''} ${state.busy ? 'canvas-busy' : ''}`}
        >
          {({ width, mounted }) =>
            !widgets.length ? (
              <section className="empty-workspace">
                <div className="canvas-illustration" aria-hidden="true">
                  <div className="mini-card mini-note">
                    <span />
                    <i />
                    <i />
                    <i />
                  </div>
                  <div className="mini-card mini-count">
                    <span />
                    <b>01</b>
                    <i />
                  </div>
                  <div className="mini-plus">
                    <Plus size={19} />
                  </div>
                  <span className="illustration-spark one">✦</span>
                  <span className="illustration-spark two">✧</span>
                </div>
                <span className="eyebrow">MAKE ROOM FOR WHAT MATTERS</span>
                <h3>你的空间，由你来定义</h3>
                <p>
                  把需要的小工具放在一起，
                  <br />
                  让工作和生活，慢慢长成喜欢的样子。
                </p>
                <div className="empty-capabilities">
                  <span>
                    <Columns3 size={14} />
                    自由编排
                  </span>
                  <span>
                    <ShieldCheck size={14} />
                    本地保存
                  </span>
                  <span>
                    <Users size={14} />
                    独立账号
                  </span>
                </div>
              </section>
            ) : (
              mounted && (
                <GridLayout
                  key={account.id}
                  width={width}
                  layout={layout}
                  gridConfig={{
                    cols: 12,
                    rowHeight: 32,
                    margin: [16, 16],
                    containerPadding: [0, 0],
                  }}
                  dragConfig={{ enabled: editing && !state.busy, handle: '.drag-handle' }}
                  resizeConfig={{ enabled: editing && !state.busy, handles: ['se'] }}
                  compactor={displacementCompactor}
                  onDragStart={(current, _oldItem, item) => {
                    if (item)
                      dragOrigin.current = {
                        id: item.i,
                        layout: current.map((entry) => ({ ...entry })),
                      }
                  }}
                  onDragStop={(next) => {
                    dragOrigin.current = null
                    commitLayout(next)
                  }}
                  onResizeStop={commitLayout}
                >
                  {widgets.map((widget) => (
                    <div key={widget.id}>
                      <WidgetCard
                        key={`${account.id}:${widget.id}`}
                        widget={widget}
                        accountId={account.id}
                        definition={widgetRegistry.get(widget.type)}
                        controller={controller}
                        editing={editing}
                        busy={state.busy}
                        onOpenAccountSettings={() => setDialog('settings')}
                        onRemove={() => setDialog({ kind: 'remove-widget', id: widget.id })}
                      />
                    </div>
                  ))}
                </GridLayout>
              )
            )
          }
        </Canvas>
        <button className="add-another" onClick={() => setDialog('library')} disabled={state.busy}>
          <Plus size={16} />
          为工作区再添一点可能
        </button>
      </main>
      <footer className="app-footer">
        <span>
          <span className="footer-logo">◈</span> ALL IN ONE WORKSPACE{' '}
          <span className="version-tag">v{version}</span>
        </span>
        <span>
          <ShieldCheck size={12} />
          只在你的设备上，属于你的空间。
        </span>
      </footer>
      {dialog === 'library' && (
        <WidgetLibrary
          key={account.id}
          controller={controller}
          records={snapshot.workspace.savedWidgets}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'accounts' && (
        <Modal
          title="你的不同日常，各有空间"
          subtitle="每个账号独立保存布局、组件设置和内容。"
          onClose={() => setDialog(null)}
          locked={state.busy}
        >
          <AccountManager
            accounts={snapshot.index.accounts}
            activeId={account.id}
            busy={state.busy}
            error={state.error}
            controller={controller}
            onDelete={(account) => setDialog({ kind: 'delete-account', account })}
          />
        </Modal>
      )}
      {dialog === 'updates' && (
        <Modal
          title="版本与更新"
          subtitle="检查新版本，选择合适的时间重启安装。"
          onClose={() => setDialog(null)}
          locked={state.busy}
        >
          <UpdateSettings
            state={updateState}
            api={api.updates}
            busy={state.busy}
            install={() => controller.installUpdate()}
          />
        </Modal>
      )}
      {dialog === 'settings' && (
        <Modal
          title="工作区设置"
          subtitle="管理应用更新、当前账号的连接与数据。"
          onClose={() => setDialog(null)}
          locked={state.busy}
        >
          <UpdateSettings
            state={updateState}
            api={api.updates}
            busy={state.busy}
            install={() => controller.installUpdate()}
          />
          <FeishuConnectionSettings
            key={account.id}
            accountId={account.id}
            accountName={account.name}
          />
          <div className="settings-section">
            <span className="eyebrow">DATA & PORTABILITY</span>
            <h3>账号迁移</h3>
            <p>
              导出当前账号的布局、组件配置、内容及保留的本地记录。导入会创建一个新账号，不会覆盖已有数据。
            </p>
            <div className="button-row">
              <button
                className="button"
                disabled={state.busy}
                onClick={() => void perform(() => controller.exportAccount())}
              >
                <ArrowUpFromLine size={16} />
                导出当前账号
              </button>
              <button
                className="button"
                disabled={state.busy}
                onClick={() => void perform(() => controller.importAccount(), true)}
              >
                <ArrowDownToLine size={16} />
                导入账号
              </button>
            </div>
          </div>
          <div className="settings-section">
            <span className="eyebrow">ON THIS DEVICE</span>
            <h3>本地数据目录</h3>
            <code className="path-display">{snapshot.dataDirectory}</code>
            <p>
              数据独立于源码仓库。普通更改保留上一份有效备份；移除、恢复或删除记录时同步更新备份。
            </p>
          </div>
          {state.error && (
            <p className="inline-error" role="alert">
              {state.error}
            </p>
          )}
          {state.notice && <p className="field-hint">{state.notice}</p>}
          <div className="settings-about">
            <div className="brand-mark small">
              <LayoutGrid size={18} />
            </div>
            <div>
              <strong>All In One Workspace</strong>
              <p>版本 {version} · 为你的日常，留一块空间。</p>
            </div>
          </div>
        </Modal>
      )}
      {dialog &&
        typeof dialog === 'object' &&
        dialog.kind === 'remove-widget' &&
        widgets.some((widget) => widget.id === dialog.id) && (
          <RemoveWidgetDialog
            key={dialog.id}
            widget={widgets.find((widget) => widget.id === dialog.id)!}
            controller={controller}
            onClose={() => setDialog(null)}
          />
        )}
      {dialog && typeof dialog === 'object' && dialog.kind === 'delete-account' && (
        <Modal
          title={`删除“${dialog.account.name}”？`}
          subtitle="此账号的布局、组件设置、内容和保留的本地记录会一起删除。你可以先导出备份。"
          onClose={() => setDialog(null)}
          locked={state.busy}
        >
          {state.error && <p className="inline-error">{state.error}</p>}
          <div className="button-row align-end">
            <button className="button" disabled={state.busy} onClick={() => setDialog(null)}>
              取消
            </button>
            <button
              className="button danger"
              disabled={state.busy}
              onClick={() => void perform(() => controller.deleteAccount(dialog.account.id), true)}
            >
              确认删除
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function Canvas({
  className,
  children,
}: {
  className: string
  children: (size: { width: number; mounted: boolean }) => ReactNode
}) {
  // Observe only after the actual canvas has mounted, not during account loading.
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true })
  return (
    <div ref={containerRef} className={className}>
      {children({ width, mounted })}
    </div>
  )
}

function AccountManager({
  accounts,
  activeId,
  busy,
  error,
  controller,
  onDelete,
}: {
  accounts: Account[]
  activeId: string
  busy: boolean
  error: string | null
  controller: WorkspaceController
  onDelete: (account: Account) => void
}) {
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [rename, setRename] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const act = async (fn: () => Promise<void>) => {
    setFormError(null)
    try {
      await fn()
    } catch (error) {
      setFormError(errorMessage(error))
    }
  }
  const create = (event: FormEvent) => {
    event.preventDefault()
    void act(async () => {
      await controller.createAccount(name)
      setName('')
    })
  }
  return (
    <>
      <div className="account-list">
        {accounts.map((account) => (
          <div
            className={`account-row ${account.id === activeId ? 'selected' : ''}`}
            key={account.id}
          >
            <button
              className="account-select"
              disabled={busy || account.id === activeId}
              onClick={() => void act(() => controller.switchAccount(account.id))}
            >
              <span className="avatar">{account.name.slice(0, 1)}</span>
              <span>
                <strong>{account.name}</strong>
                <small>{account.id === activeId ? '当前工作区' : '点击切换工作区'}</small>
              </span>
              {account.id === activeId && <Check size={16} />}
            </button>
            <button
              className="icon-button"
              aria-label={`重命名${account.name}`}
              disabled={busy}
              onClick={() => {
                setRenaming(account.id)
                setRename(account.name)
              }}
            >
              <Pencil size={15} />
            </button>
            <button
              className="icon-button danger-hover"
              aria-label={`删除${account.name}`}
              disabled={busy || accounts.length === 1}
              onClick={() => onDelete(account)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
      {renaming && (
        <form
          className="inline-form rename-form"
          onSubmit={(event) => {
            event.preventDefault()
            void act(async () => {
              await controller.renameAccount(renaming, rename)
              setRenaming(null)
            })
          }}
        >
          <input
            aria-label="新的账号名称"
            value={rename}
            onChange={(event) => setRename(event.target.value)}
            maxLength={40}
            required
            disabled={busy}
            autoFocus
          />
          <button className="button" disabled={busy || !rename.trim()}>
            保存名称
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="取消重命名"
            onClick={() => setRenaming(null)}
          >
            <X size={16} />
          </button>
        </form>
      )}
      <form onSubmit={create} className="new-account-form">
        <label htmlFor="account-name">创建一个新的空间</label>
        <div className="inline-form">
          <input
            id="account-name"
            placeholder="例如：工作、生活、灵感"
            maxLength={40}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            disabled={busy}
          />
          <button className="button primary" disabled={busy || !name.trim()}>
            <Plus size={16} />
            创建账号
          </button>
        </div>
      </form>
      {(formError || error) && (
        <p className="inline-error" role="alert">
          {formError || error}
        </p>
      )}
      <p className="account-hint">
        <CircleHelp size={14} />
        账号只用于区分本地空间，无需密码或登录。
      </p>
    </>
  )
}
