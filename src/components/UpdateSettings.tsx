import { useEffect, useState } from 'react'
import { Download, RefreshCw, RotateCcw, ExternalLink } from 'lucide-react'
import type { UpdateState, UpdatesAPI } from '../shared/updates'
import { errorMessage } from '../shared/model'
export function useUpdates(api: UpdatesAPI) {
  const [state, setState] = useState<UpdateState | null>(null)
  useEffect(() => {
    let alive = true,
      revision = 0
    const unsubscribe = api.onChanged((next) => {
      revision++
      if (alive) setState(next)
    })
    void api
      .getState()
      .then((next) => {
        if (alive && revision === 0) setState(next)
      })
      .catch(() => undefined)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [api])
  return state
}
const labels: Record<UpdateState['phase'], string> = {
  idle: '等待检查',
  checking: '正在检查更新…',
  current: '当前已是最新版本',
  available: '发现新版本',
  downloading: '正在后台下载…',
  ready: '新版已下载，重启即可安装',
  installing: '正在准备安装…',
  error: '更新未完成',
  unavailable: '当前无法自动更新',
}
export function UpdateSettings({
  state,
  api,
  busy,
  install,
}: {
  state: UpdateState | null
  api: UpdatesAPI
  busy: boolean
  install(): Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  async function perform(action: () => Promise<void>) {
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setPending(false)
    }
  }
  if (!state)
    return (
      <section className="settings-section">
        <h3>应用更新</h3>
        <p>正在读取更新状态…</p>
      </section>
    )
  const working = pending || busy || ['checking', 'downloading', 'installing'].includes(state.phase)
  return (
    <section className="settings-section update-settings">
      <span className="eyebrow">APP UPDATES</span>
      <h3>
        应用更新 <span className="version-tag">v{state.currentVersion}</span>
      </h3>
      <label className="update-switch">
        <input
          type="checkbox"
          checked={state.automatic}
          disabled={pending || busy}
          onChange={(event) => void perform(() => api.setAutomatic(event.target.checked))}
        />
        自动检查并下载更新
      </label>
      <p className="update-status" role="status">
        {labels[state.phase]}
        {state.version ? ` · v${state.version}` : ''}
      </p>
      {state.phase === 'downloading' && (
        <progress aria-label="更新下载进度" max={100} value={state.progress ?? 0} />
      )}
      {state.message && <p className="field-hint">{state.message}</p>}
      {state.checkedAt && (
        <p className="field-hint">上次检查：{new Date(state.checkedAt).toLocaleString('zh-CN')}</p>
      )}
      <div className="button-row">
        <button
          className="button"
          disabled={working || state.phase === 'unavailable'}
          onClick={() => void perform(() => api.check())}
        >
          <RefreshCw size={15} />
          检查更新
        </button>
        {state.version && ['available', 'error'].includes(state.phase) && (
          <button
            className="button"
            disabled={working}
            onClick={() => void perform(() => api.download())}
          >
            <Download size={15} />
            下载更新
          </button>
        )}
        {state.phase === 'ready' && state.canInstall && (
          <button
            className="button primary"
            disabled={working}
            onClick={() => void perform(install)}
          >
            <RotateCcw size={15} />
            重启并安装
          </button>
        )}
        <button
          className="button"
          disabled={busy}
          onClick={() => void perform(() => api.openRelease())}
        >
          <ExternalLink size={15} />
          打开发布页
        </button>
      </div>
      <p className="field-hint">
        跟随 GitHub 正式发布版本。下载完成后由你决定何时重启；仅替换 App，账号数据保留在本机。
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
