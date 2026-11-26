import { Download, RefreshCw } from 'lucide-react'
import type { UpdateState } from '../shared/updates'

export function UpdateEntry({
  state,
  disabled,
  onClick,
}: {
  state: UpdateState | null
  disabled: boolean
  onClick(): void
}) {
  const badge =
    state?.phase === 'ready'
      ? state.canInstall
        ? '可安装'
        : '已下载'
      : state?.phase === 'available'
        ? '有新版'
        : state?.phase === 'downloading'
          ? `${state.progress ?? 0}%`
          : state?.phase === 'checking'
            ? '检查中'
            : state?.phase === 'installing'
              ? '安装中'
              : state?.phase === 'error'
                ? '需重试'
                : null
  const highlighted = ['ready', 'available'].includes(state?.phase ?? '')
  return (
    <button
      className={`button update-entry ${highlighted ? 'update-entry-highlight' : ''}`}
      aria-label="应用更新"
      title={badge ? `应用更新 · ${badge}` : '检查版本与管理更新'}
      disabled={disabled}
      onClick={onClick}
    >
      {highlighted ? (
        <Download size={16} />
      ) : (
        <RefreshCw size={16} className={state?.phase === 'checking' ? 'spin' : undefined} />
      )}
      应用更新
      {badge && (
        <span
          className={`update-entry-badge ${state?.phase === 'error' ? 'update-entry-error' : ''}`}
        >
          {badge}
        </span>
      )}
    </button>
  )
}
