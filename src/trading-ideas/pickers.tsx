import { useEffect, useId, useRef, useState, type KeyboardEvent, type ToggleEvent } from 'react'
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { chinaDay, ideaDateSchema } from '../shared/trading-ideas'

export type Choice<T extends string> = { value: T; label: string }

export function choices<T extends string>(values: readonly T[]) {
  return values.map((value) => ({ value, label: value }))
}

function usePicker(width?: number) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  function close(restoreFocus = true) {
    if (popup.current?.matches(':popover-open')) popup.current.hidePopover()
    if (restoreFocus) trigger.current?.focus({ preventScroll: true })
  }

  function position(event: ToggleEvent<HTMLDivElement>) {
    if (event.newState !== 'open' || !trigger.current) return
    const panel = event.currentTarget
    const rect = trigger.current.getBoundingClientRect()
    const margin = 8
    const below = window.innerHeight - rect.bottom - margin * 2
    const above = rect.top - margin * 2
    const panelWidth = Math.min(width ?? rect.width, window.innerWidth - margin * 2)
    const upwards = below < (width ? 350 : 220) && above > below
    panel.style.width = panelWidth + 'px'
    panel.style.left =
      Math.max(margin, Math.min(rect.left, window.innerWidth - panelWidth - margin)) + 'px'
    panel.style.top = upwards ? 'auto' : rect.bottom + 5 + 'px'
    panel.style.bottom = upwards ? window.innerHeight - rect.top + 5 + 'px' : 'auto'
    panel.style.maxHeight = Math.max(0, upwards ? above : below) + 'px'
  }

  useEffect(() => {
    if (!open) return
    function hide(event: Event) {
      if (!(event.target instanceof Node) || !popup.current?.contains(event.target)) close(false)
    }
    window.addEventListener('resize', hide)
    window.addEventListener('scroll', hide, true)
    return () => {
      window.removeEventListener('resize', hide)
      window.removeEventListener('scroll', hide, true)
    }
  }, [open])

  return {
    id,
    trigger,
    popup,
    open,
    position,
    close,
    onToggle: () => setOpen(Boolean(popup.current?.matches(':popover-open'))),
  }
}

export function ChoicePicker<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly Choice<T>[]
  onChange: (value: T) => void
}) {
  const picker = usePicker()

  useEffect(() => {
    if (!picker.open) return
    const panel = picker.popup.current
    const selected = panel?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
    const target = selected ?? panel?.querySelector<HTMLButtonElement>('[role="option"]')
    target?.focus()
  }, [picker.open, picker.popup])

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      picker.close()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    )
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  return (
    <div className="ideas-picker">
      <button
        type="button"
        className="ideas-picker-trigger"
        ref={picker.trigger}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={picker.open}
        aria-controls={picker.id}
        aria-describedby={picker.id + '-value'}
        popoverTarget={picker.id}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!picker.open) picker.trigger.current?.click()
          }
        }}
      >
        <span id={picker.id + '-value'}>
          {options.find((option) => option.value === value)?.label}
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      <div
        id={picker.id}
        ref={picker.popup}
        role="listbox"
        aria-label={label}
        popover="auto"
        className="ideas-picker-panel ideas-choice-panel"
        onBeforeToggle={picker.position}
        onToggle={picker.onToggle}
        onKeyDown={keyboard}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={option.value === value}
            onClick={() => {
              onChange(option.value)
              picker.close()
            }}
          >
            <span>{option.label}</span>
            {option.value === value && <Check size={15} aria-hidden="true" />}
          </button>
        ))}
      </div>
    </div>
  )
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
