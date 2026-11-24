import { useState } from 'react'
import { ArrowLeft, ArchiveRestore, FolderHeart, Plus, Trash2 } from 'lucide-react'
import { Modal } from './Modal'
import { WidgetIcon } from './WidgetCard'
import { errorMessage, type SavedWidget } from '../shared/model'
import type { WorkspaceController } from '../workspace/controller'

export function WidgetLibrary({
  controller,
  records,
  onClose,
}: {
  controller: WorkspaceController
  records: SavedWidget[]
  onClose: () => void
}) {
  const [selectedType, setSelectedType] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const registry = controller.registry
  const selected = selectedType ? registry.get(selectedType) : undefined
  const saved = records.filter((record) => record.widget.type === selectedType).toReversed()
  const missingTypes = [...new Set(records.map((record) => record.widget.type))].filter(
    (type) => !registry.has(type),
  )
  const act = (action: () => void, close = true) => {
    try {
      action()
      setError(null)
      if (close) onClose()
    } catch (error) {
      setError(errorMessage(error))
    }
  }
  const select = (type: string) => {
    setSelectedType(type)
    setDeletingId(null)
    setError(null)
  }
  return (
    <Modal
      title={selectedType ? `添加${selected?.name ?? '已保留的卡片'}` : '为你的空间，添一块拼图'}
      subtitle={
        selectedType
          ? '选择一份本地记录恢复，或添加全新卡片。恢复后，该记录会移回工作区。'
          : '选择需要的组件。每种组件都可以添加多次，独立设置。'
      }
      onClose={onClose}
      wide
    >
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {selectedType ? (
        <>
          <div className="library-heading">
            <button
              className="quiet-button"
              onClick={() => {
                setSelectedType(null)
                setError(null)
              }}
            >
              <ArrowLeft size={14} /> 返回组件库
            </button>
            {selected && (
              <button
                className="button primary small"
                onClick={() => act(() => controller.addWidget(selectedType))}
              >
                <Plus size={14} /> 添加全新卡片
              </button>
            )}
          </div>
          {!selected && (
            <p className="record-note">
              此组件暂未安装。可以恢复为占位卡片，原始设置和内容会继续保留。
            </p>
          )}
          <div className="saved-record-heading">
            当前账号的本地记录 <span>{saved.length} 份</span>
          </div>
          <div className="saved-record-list">
            {saved.map((record) => (
              <section
                className="saved-record"
                key={record.id}
                aria-label={`本地记录：${record.name}`}
              >
                <div className="saved-record-info">
                  <span className="saved-record-icon">
                    <FolderHeart size={19} />
                  </span>
                  <div>
                    <h3>{record.name}</h3>
                    <p>
                      保存于 {new Date(record.savedAt).toLocaleString('zh-CN', { hour12: false })}
                    </p>
                    <small>
                      {record.widget.layout.w} 列 × {record.widget.layout.h} 行 · 记录{' '}
                      {record.id.slice(0, 8)}
                    </small>
                  </div>
                </div>
                {deletingId === record.id ? (
                  <div className="record-delete-confirm">
                    <p>删除这份记录的设置和内容？此操作无法撤销。</p>
                    <div className="button-row">
                      <button className="button small" onClick={() => setDeletingId(null)}>
                        保留记录
                      </button>
                      <button
                        className="button small danger"
                        onClick={() =>
                          act(() => {
                            controller.deleteSavedWidget(record.id)
                            setDeletingId(null)
                          }, false)
                        }
                      >
                        确认删除记录
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="button-row record-actions">
                    <button
                      className="button small"
                      onClick={() => act(() => controller.restoreWidget(record.id))}
                    >
                      <ArchiveRestore size={14} /> 恢复这份记录
                    </button>
                    <button
                      className="icon-button danger-hover"
                      aria-label={`删除记录：${record.name}`}
                      onClick={() => setDeletingId(record.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                )}
              </section>
            ))}
            {!saved.length && (
              <p className="record-note">
                暂无保留的记录。移除卡片时选择“仅移除卡片，保留数据”，就可以在这里找回。
              </p>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="library-heading">
            <span>
              全部组件 <b>{registry.size}</b>
            </span>
            <span className="badge">当前账号 · {records.length} 份本地记录</span>
          </div>
          <div className="library-grid">
            {[...registry.values()].map((definition) => {
              const count = records.filter(
                (record) => record.widget.type === definition.type,
              ).length
              return (
                <div className={`library-card accent-${definition.accent}`} key={definition.type}>
                  <span className={`sample-icon ${definition.accent}`}>
                    <WidgetIcon icon={definition.icon} size={24} />
                  </span>
                  <h3>{definition.name}</h3>
                  <p>{definition.description}</p>
                  <div>
                    <span className="field-hint">
                      {count
                        ? `${count} 份本地记录可恢复`
                        : `${definition.defaultSize.w} 列 · 可调整`}
                    </span>
                    <button
                      className="button small"
                      onClick={() =>
                        count
                          ? select(definition.type)
                          : act(() => controller.addWidget(definition.type))
                      }
                    >
                      <Plus size={14} /> 添加
                    </button>
                  </div>
                </div>
              )
            })}
            {missingTypes.map((type) => (
              <div className="library-card" key={type}>
                <span className="sample-icon sand">
                  <FolderHeart size={24} />
                </span>
                <h3>{type}</h3>
                <p>组件暂未安装，已保留的设置和内容仍可恢复。</p>
                <div>
                  <span className="field-hint">
                    {records.filter((record) => record.widget.type === type).length} 份本地记录
                  </span>
                  <button className="button small" onClick={() => select(type)}>
                    查看记录
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="library-note">
            <FolderHeart size={24} />
            <div>
              <strong>让工作区随你一起成长</strong>
              <p>保留的记录只属于当前账号。同类型的每张卡片，都有自己的设置和内容。</p>
            </div>
          </div>
        </>
      )}
    </Modal>
  )
}
