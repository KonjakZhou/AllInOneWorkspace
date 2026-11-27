import { useEffect, useState, type KeyboardEvent } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { chinaDay, ideaDateSchema } from '../shared/trading-ideas'

import { usePicker } from '../components/ChoicePicker'

export function choices<T extends string>(values: readonly T[]) {
  return values.map((value) => ({ value, label: value }))
}

function changeDate(value: string, days: number, months = 0) {
  const date = new Date(value + 'T00:00:00Z')
  date.setUTCMonth(date.getUTCMonth() + months)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function firstOfMonth(value: string) {
  return value.slice(0, 7) + '-01'
}

const monthFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'long',
})

export function DatePicker({
  label,
  value,
  onChange,
  optional = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  optional?: boolean
}) {
  const picker = usePicker(298)
  const today = chinaDay()
  const [active, setActive] = useState(() => value || today)
  const [draft, setDraft] = useState(value)
  const month = firstOfMonth(active)
  const firstWeekday = (new Date(month + 'T00:00:00Z').getUTCDay() + 6) % 7
  const days = Array.from({ length: 42 }, (_, index) => changeDate(month, index - firstWeekday))
  const validDraft = ideaDateSchema.safeParse(draft).success

  useEffect(() => {
    if (picker.open)
      picker.popup.current
        ?.querySelector<HTMLButtonElement>('[data-day][tabindex="0"]')
        ?.focus({ preventScroll: true })
  }, [picker.open, picker.popup])

  function select(day: string) {
    onChange(day)
    picker.close()
  }

  function show() {
    setActive(value || today)
    setDraft(value)
  }

  function move(event: KeyboardEvent<HTMLButtonElement>, day: string) {
    const offset: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    }
    if (offset[event.key] === undefined) return
    const next = changeDate(day, offset[event.key])
    if (!ideaDateSchema.safeParse(next).success) return
    event.preventDefault()
    setActive(next)
    requestAnimationFrame(() =>
      picker.popup.current?.querySelector<HTMLButtonElement>('[data-day="' + next + '"]')?.focus(),
    )
  }

  return (
    <div className="ideas-picker">
      <button
        type="button"
        className="ideas-picker-trigger"
        ref={picker.trigger}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={picker.open}
        aria-controls={picker.id}
        aria-describedby={picker.id + '-value'}
        popoverTarget={picker.id}
        onClick={show}
      >
        <span id={picker.id + '-value'} className={value ? undefined : 'ideas-picker-placeholder'}>
          {value ? value.replaceAll('-', '/') : '选择日期'}
        </span>
        <CalendarDays size={15} aria-hidden="true" />
      </button>
      <div
        id={picker.id}
        ref={picker.popup}
        role="dialog"
        aria-label={label}
        popover="auto"
        className="ideas-picker-panel ideas-date-panel"
        onBeforeToggle={picker.position}
        onToggle={picker.onToggle}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            picker.close()
          }
        }}
      >
        <div className="ideas-date-header">
          <button
            type="button"
            aria-label="上个月"
            disabled={month === '0000-01-01'}
            onClick={() => setActive(changeDate(month, 0, -1))}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <strong aria-live="polite">{monthFormat.format(new Date(month + 'T00:00:00Z'))}</strong>
          <button
            type="button"
            aria-label="下个月"
            disabled={month === '9999-12-01'}
            onClick={() => setActive(changeDate(month, 0, 1))}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="ideas-date-grid" role="group" aria-label="选择日期">
          {['一', '二', '三', '四', '五', '六', '日'].map((day) => (
            <span key={day}>{day}</span>
          ))}
          {days.map((day, index) =>
            ideaDateSchema.safeParse(day).success ? (
              <button
                type="button"
                key={day}
                data-day={day}
                data-outside={firstOfMonth(day) !== month}
                aria-label={day}
                aria-pressed={day === value}
                aria-current={day === today ? 'date' : undefined}
                tabIndex={day === active ? 0 : -1}
                onClick={() => select(day)}
                onKeyDown={(event) => move(event, day)}
              >
                {Number(day.slice(-2))}
              </button>
            ) : (
              <span key={'blank-' + index} aria-hidden="true" />
            ),
          )}
        </div>
        <div className="ideas-date-entry">
          <input
            type="text"
            aria-label="输入日期"
            value={draft}
            placeholder="YYYY-MM-DD"
            maxLength={10}
            aria-invalid={Boolean(draft && !validDraft)}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              if (validDraft) select(draft)
            }}
          />
          <button type="button" disabled={!validDraft} onClick={() => select(draft)}>
            确定
          </button>
        </div>
        <div className="ideas-date-footer">
          <button type="button" onClick={() => select(today)}>
            今天
          </button>
          {optional && (
            <button type="button" onClick={() => select('')}>
              清除
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
