import { useState } from 'react'
import { FolderHeart, Trash2 } from 'lucide-react'
import { Modal } from './Modal'
import { errorMessage, type WidgetInstance } from '../shared/model'
import type { WorkspaceController } from '../workspace/controller'

export function RemoveWidgetDialog({
  widget,
  controller,
  onClose,
}: {
  widget: WidgetInstance
  controller: WorkspaceController
  onClose: () => void
}) {
  const title =
    widget.config &&
    typeof widget.config === 'object' &&
    !Array.isArray(widget.config) &&
    typeof widget.config.title === 'string'
      ? widget.config.title
      : ''
  const [name, setName] = useState(
    (title || controller.registry.get(widget.type)?.name || widget.type).slice(0, 80),
  )
  const [mode, setMode] = useState<'keep' | 'delete'>('keep')
  const [error, setError] = useState<string | null>(null)
  const submit = () => {
    try {
      controller.removeWidget(widget.id, mode, name)
      onClose()
    } catch (error) {
      setError(errorMessage(error))
    }
  }
  return (
    <Modal
      title="如何移除这张卡片？"
      subtitle="只处理当前这一张卡片，同类型的其他卡片不受影响。"
      onClose={onClose}
    >
      <fieldset className="removal-options">
        <legend className="sr-only">选择移除方式</legend>
        <label className={`removal-option ${mode === 'keep' ? 'selected' : ''}`}>
          <input
            type="radio"
            name="removal-mode"
            value="keep"
            checked={mode === 'keep'}
            onChange={() => setMode('keep')}
          />
          <FolderHeart size={20} />
          <span>
            <strong>仅移除卡片，保留数据</strong>
            <small>设置和内容单独存为一份本地记录，下次添加时可选择恢复。</small>
          </span>
        </label>
        <label className={`removal-option destructive ${mode === 'delete' ? 'selected' : ''}`}>
          <input
            type="radio"
            name="removal-mode"
            value="delete"
            checked={mode === 'delete'}
            onChange={() => setMode('delete')}
          />
          <Trash2 size={20} />
          <span>
            <strong>删除卡片及其设置和数据</strong>
            <small>不保留本地记录，无法从组件库恢复。</small>
          </span>
        </label>
      </fieldset>
      {mode === 'keep' && (
        <label className="record-name-field">
          记录名称
          <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          <span className="field-hint">起一个容易辨认的名字，方便从多份记录中选择。</span>
        </label>
      )}
      {widget.type === 'feishu.calendar' && (
        <p className="record-note">两种方式都不会断开账号的飞书连接，也不会删除飞书中的日程。</p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="button-row align-end">
        <button className="button" onClick={onClose}>
          取消
        </button>
        <button
          className={`button ${mode === 'delete' ? 'danger' : 'primary'}`}
          disabled={mode === 'keep' && !name.trim()}
          onClick={submit}
        >
          {mode === 'keep' ? '移除并保留记录' : '删除卡片和数据'}
        </button>
      </div>
    </Modal>
  )
}
