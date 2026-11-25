import { useEffect, useState } from 'react'
import {
  Grip,
  Hash,
  SlidersHorizontal,
  Trash2,
  Type,
  RotateCw,
  Blocks,
  CalendarDays,
  Newspaper,
} from 'lucide-react'
import type { WidgetInstance } from '../shared/model'
import { errorMessage } from '../shared/model'
import type { AnyWidgetDefinition, WidgetContext } from '../sdk/types'
import { prepareWidget } from '../sdk/registry'
import { WidgetEmpty, WidgetError, WidgetErrorBoundary } from '../sdk/components'
import type { WorkspaceController } from '../workspace/controller'
import { Modal } from './Modal'

export function WidgetIcon({ icon, size = 18 }: { icon?: string; size?: number }) {
  return icon === 'text' ? (
    <Type size={size} />
  ) : icon === 'counter' ? (
    <Hash size={size} />
  ) : icon === 'calendar' ? (
    <CalendarDays size={size} />
  ) : icon === 'news' ? (
    <Newspaper size={size} />
  ) : (
    <Blocks size={size} />
  )
}
export function WidgetCard({
  widget,
  accountId,
  definition,
  controller,
  editing,
  onRemove,
  busy,
  onOpenAccountSettings,
}: {
  widget: WidgetInstance
  accountId: string
  definition?: AnyWidgetDefinition
  controller: WorkspaceController
  editing: boolean
  onRemove: () => void
  busy: boolean
  onOpenAccountSettings?: () => void
}) {
  const [scope] = useState(() => new AbortController())
  const [settings, setSettings] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  useEffect(() => () => scope.abort(), [scope])
  const context: WidgetContext = {
    accountId,
    instanceId: widget.id,
    config: widget.config,
    data: widget.data,
    signal: scope.signal,
    openAccountSettings: () => onOpenAccountSettings?.(),
    updateConfig: (value) => {
      if (!scope.signal.aborted) {
        try {
          controller.updateWidget(accountId, widget.id, 'config', value)
        } catch (error) {
          controller.showError(error)
        }
      }
    },
    updateData: (value) => {
      if (!scope.signal.aborted) {
        try {
          controller.updateWidget(accountId, widget.id, 'data', value)
        } catch (error) {
          controller.showError(error)
        }
      }
    },
  }
  let validationError: string | null = null
  try {
    prepareWidget(widget, definition)
  } catch (error) {
    validationError = errorMessage(error)
  }
  const refresh = async () => {
    if (!definition?.refresh || refreshing) return
    setRefreshing(true)
    setRefreshError(null)
    try {
      await definition.refresh(context)
    } catch (error) {
      if (!scope.signal.aborted) setRefreshError(errorMessage(error))
    } finally {
      if (!scope.signal.aborted) setRefreshing(false)
    }
  }
  return (
    <article
      className={`widget-card accent-${definition?.accent ?? 'lavender'} ${definition?.chrome === 'compact' ? 'chrome-compact' : ''}`}
      aria-label={definition?.name ?? '未安装的组件'}
      data-instance-id={widget.id}
    >
      {(definition?.chrome !== 'compact' || editing) && (
        <header className="widget-header">
          <span className="widget-heading">
            {editing ? (
              <Grip size={16} className="drag-handle" aria-label="拖动组件" />
            ) : (
              <WidgetIcon icon={definition?.icon} size={15} />
            )}
            <span>{definition?.name ?? widget.type}</span>
          </span>
          <div className="widget-actions">
            {!definition && <span className="badge">待安装</span>}
            {definition?.refresh && (
              <button
                className="icon-button compact"
                aria-label="刷新组件"
                disabled={refreshing || busy || !!validationError}
                onClick={() => void refresh()}
              >
                <RotateCw size={14} className={refreshing ? 'spin' : ''} />
              </button>
            )}
            {definition?.Settings && (
              <button
                className="icon-button compact"
                aria-label="组件设置"
                disabled={busy || !!validationError}
                onClick={() => setSettings(true)}
              >
                <SlidersHorizontal size={14} />
              </button>
            )}
            {editing && (
              <button
                className="icon-button compact danger-hover"
                aria-label="移除组件"
                onClick={onRemove}
                disabled={busy}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </header>
      )}
      <div className="widget-content">
        <WidgetErrorBoundary>
          {validationError ? (
            <WidgetError message={validationError} />
          ) : !definition ? (
            <WidgetEmpty message="这个组件尚未安装">
              <p className="field-hint">
                布局和原始数据已保留。添加对应组件源码并重新构建后即可恢复。
              </p>
              <code>{widget.type}</code>
            </WidgetEmpty>
          ) : refreshError ? (
            <WidgetError message={refreshError} retry={() => void refresh()} />
          ) : (
            <definition.Component {...context} />
          )}
        </WidgetErrorBoundary>
      </div>
      {settings && definition?.Settings && (
        <Modal
          title={`${definition.name}设置`}
          subtitle="只修改当前账号下的这一个组件"
          onClose={() => setSettings(false)}
        >
          <WidgetErrorBoundary>
            <definition.Settings {...context} />
          </WidgetErrorBoundary>
        </Modal>
      )}
    </article>
  )
}
