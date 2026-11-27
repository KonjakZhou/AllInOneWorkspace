import { useEffect, useId, useRef, useState, type KeyboardEvent, type ToggleEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'

type Choice<T extends string> = { value: T; label: string }

export function usePicker(width?: number) {
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
  disabled = false,
  compact = false,
  showLabel = false,
  placeholder = '请选择',
}: {
  label: string
  value: T
  options: readonly Choice<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  compact?: boolean
  showLabel?: boolean
  placeholder?: string
}) {
  const picker = usePicker()
  const selected = options.find((option) => option.value === value)
  const unavailable = disabled || options.length === 0

  useEffect(() => {
    if (!picker.open) return
    if (unavailable) {
      picker.popup.current?.hidePopover()
      return
    }
    const panel = picker.popup.current
    const option =
      panel?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ??
      panel?.querySelector<HTMLButtonElement>('[role="option"]')
    option?.focus()
  }, [picker.open, picker.popup, unavailable])

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        picker.close()
        return
      case 'Tab':
        picker.close()
        return
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Home':
      case 'End': {
        event.preventDefault()
        const options = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'),
        ]
        if (!options.length) return
        const current = options.indexOf(document.activeElement as HTMLButtonElement)
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? options.length - 1
              : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
        options[next]?.focus()
      }
    }
  }

  return (
    <div className="choice-picker">
      {showLabel && <span className="choice-picker-label">{label}</span>}
      <button
        ref={picker.trigger}
        type="button"
        className={compact ? 'button small choice-picker-trigger' : 'button choice-picker-trigger'}
        disabled={unavailable}
        aria-label={label}
        aria-describedby={picker.id + '-value'}
        aria-haspopup="listbox"
        aria-expanded={picker.open}
        aria-controls={picker.id}
        popoverTarget={picker.id}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!picker.open) picker.trigger.current?.click()
          }
        }}
      >
        <span id={picker.id + '-value'} data-placeholder={!selected || undefined}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown className="choice-picker-chevron" size={15} aria-hidden="true" />
      </button>
      <div
        id={picker.id}
        ref={picker.popup}
        role="listbox"
        aria-label={label}
        popover="auto"
        className="choice-picker-panel"
        onBeforeToggle={picker.position}
        onToggle={picker.onToggle}
        onKeyDown={keyboard}
      >
        {options.map(({ value: option, label }) => (
          <button
            key={option}
            type="button"
            role="option"
            className="choice-picker-option"
            tabIndex={-1}
            aria-selected={option === value}
            onClick={() => {
              picker.close()
              onChange(option)
            }}
          >
            <span>{label}</span>
            {option === value && <Check size={15} aria-hidden="true" />}
          </button>
        ))}
      </div>
    </div>
  )
}
