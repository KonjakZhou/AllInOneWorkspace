import { useEffect, useState, type FormEvent } from 'react'
import { CircleCheck } from 'lucide-react'
import {
  categories,
  evidenceStates,
  priorityLevels,
  type IdeaDetail,
  type IdeaNote,
  type ManualIdea,
} from '../shared/trading-ideas'
import { errorMessage } from '../shared/model'
import { ChoicePicker } from '../components/ChoicePicker'
import { DatePicker, choices } from './pickers'

const categoryOptions = choices(categories)
const priorityOptions = choices(priorityLevels)
const evidenceOptions = [{ value: '', label: '沿用来源状态' }, ...choices(evidenceStates)] as const

export function ManualIdeaForm({
  submit,
  cancel,
}: {
  submit: (input: ManualIdea) => Promise<void>
  cancel: () => void
}) {
  const [category, setCategory] = useState<ManualIdea['category']>('独立作者与音视频')
  const [publishedDay, setPublishedDay] = useState('')
  const [eventDay, setEventDay] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    const field = (name: string) => String(values.get(name) ?? '')
    setSaving(true)
    setError('')
    try {
      await submit({
        url: field('url'),
        title: field('title'),
        author: field('author'),
        category,
        evidence:
          category === '未证实传闻'
            ? '未证实'
            : category === '论文'
              ? '研究摘要'
              : category === '官方披露'
                ? '官方原文'
                : '作者观点',
        summary: field('summary'),
        publishedDay,
        eventDay,
      })
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="ideas-form" onSubmit={save}>
      <h2>手动收录</h2>
      <label>
        原文链接
        <input name="url" type="url" required maxLength={2048} placeholder="https://" />
      </label>
      <label>
        标题
        <input name="title" required maxLength={240} />
      </label>
      <label>
        作者或机构
        <input name="author" maxLength={120} />
      </label>
      <div className="ideas-field">
        <span>来源类别</span>
        <ChoicePicker
          label="来源类别"
          value={category}
          options={categoryOptions}
          onChange={setCategory}
        />
      </div>
      <div className="ideas-form-row">
        <div className="ideas-field">
          <span>发布日期</span>
          <DatePicker label="发布日期" value={publishedDay} onChange={setPublishedDay} optional />
        </div>
        <div className="ideas-field">
          <span>事件或数据日期</span>
          <DatePicker label="事件或数据日期" value={eventDay} onChange={setEventDay} optional />
        </div>
      </div>
      <label>
        摘要或一句灵感
        <textarea name="summary" maxLength={600} rows={3} />
      </label>
      {error && (
        <p className="ideas-error" role="alert">
          {error}
        </p>
      )}
      <div className="ideas-actions">
        <button type="submit" className="ideas-primary" disabled={saving}>
          {saving ? '正在收录…' : '保存条目'}
        </button>
        <button type="button" onClick={cancel}>
          取消
        </button>
      </div>
    </form>
  )
}

export function IdeaNotesForm({
  item,
  save,
}: {
  item: IdeaDetail
  save: (note: IdeaNote) => Promise<void>
}) {
  const [note, setNote] = useState(item.personal)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const update = <T extends keyof IdeaNote>(key: T, value: IdeaNote[T]) => {
    setNote((current) => ({ ...current, [key]: value }))
    setSaved(false)
  }

  useEffect(() => {
    if (!saved) return
    const timeout = window.setTimeout(() => setSaved(false), 3000)
    return () => window.clearTimeout(timeout)
  }, [saved])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      await save(note)
      setSaved(true)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="ideas-form ideas-notes" onSubmit={submit}>
      <h3>我的研究笔记</h3>
      <div className="ideas-form-row">
        <div className="ideas-field">
          <span>优先级</span>
          <ChoicePicker
            label="优先级"
            value={note.priority}
            options={priorityOptions}
            onChange={(value) => update('priority', value)}
          />
        </div>
        <div className="ideas-field">
          <span>证据标记</span>
          <ChoicePicker
            label="证据标记"
            value={note.evidence ?? ''}
            options={evidenceOptions}
            onChange={(value) => update('evidence', value || null)}
          />
        </div>
      </div>
      <label className="ideas-check">
        <input
          type="checkbox"
          checked={note.pending}
          onChange={(event) => update('pending', event.target.checked)}
        />
        加入待研究
      </label>
      <label>
        可以研究的问题
        <textarea
          value={note.question}
          maxLength={1000}
          rows={2}
          onChange={(event) => update('question', event.target.value)}
        />
      </label>
      <label>
        个人笔记
        <textarea
          value={note.note}
          maxLength={4000}
          rows={3}
          onChange={(event) => update('note', event.target.value)}
        />
      </label>
      <label>
        关联事件
        <input
          value={note.group}
          maxLength={120}
          placeholder="给相关条目填写同一个事件名称"
          onChange={(event) => update('group', event.target.value)}
        />
      </label>
      {error && (
        <p className="ideas-error" role="alert">
          {error}
        </p>
      )}
      <div className="ideas-actions">
        <button className="ideas-primary" disabled={saving}>
          保存标记与笔记
        </button>
        <span role="status">
          {saved && (
            <span className="ideas-saved">
              <CircleCheck size={15} aria-hidden="true" /> 已保存
            </span>
          )}
        </span>
      </div>
    </form>
  )
}
