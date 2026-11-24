import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Clock3, MapPin } from 'lucide-react'
import type { CalendarEvent } from '../../shared/feishu'
import { clockTime, eventDetailRange } from './presentation'

export function CalendarEventRow({
  event,
  day,
  tag,
  past,
}: {
  event: CalendarEvent
  day: Date
  tag: string
  past: boolean
}) {
  const id = useId()
  const row = useRef<HTMLButtonElement>(null)
  const tooltip = useRef<HTMLDivElement>(null)
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const cancelDismiss = () => clearTimeout(dismissTimer.current)
  const show = () => {
    cancelDismiss()
    setOpen(true)
  }
  const hideSoon = () => {
    cancelDismiss()
    dismissTimer.current = setTimeout(() => setOpen(false), 120)
  }
  useEffect(() => () => clearTimeout(dismissTimer.current), [])
  useLayoutEffect(() => {
    if (!open || !row.current || !tooltip.current) return
    const anchor = row.current.getBoundingClientRect()
    const panel = tooltip.current.getBoundingClientRect()
    const margin = 12
    let left = anchor.right + 8
    if (left + panel.width > window.innerWidth - margin) left = anchor.left - panel.width - 8
    let top = anchor.top + (anchor.height - panel.height) / 2
    if (left < margin) {
      left = anchor.left
      top = anchor.bottom + 8
      if (top + panel.height > window.innerHeight - margin) top = anchor.top - panel.height - 8
    }
    setPosition({
      left: Math.max(margin, Math.min(left, window.innerWidth - panel.width - margin)),
      top: Math.max(margin, Math.min(top, window.innerHeight - panel.height - margin)),
    })
    const dismiss = () => setOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss()
    }
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node) || !tooltip.current?.contains(e.target)) dismiss()
    }
    const onPointerDown = (e: PointerEvent) => {
      if (
        e.target instanceof Node &&
        !row.current?.contains(e.target) &&
        !tooltip.current?.contains(e.target)
      )
        dismiss()
    }
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open, event])
  return (
    <>
      <button
        ref={row}
        type="button"
        className={`calendar-event ${tag === 'NEXT' ? 'is-next' : ''} ${past ? 'is-past' : ''}`}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
        onFocus={show}
        onBlur={hideSoon}
        onClick={show}
      >
        <time>
          {event.allDay ? '全天' : event.start < day.getTime() ? '跨天' : clockTime(event.start)}
        </time>
        <span className="calendar-event-title">{event.title}</span>
        {tag && <span className="calendar-event-tag">{tag}</span>}
      </button>
      {open &&
        createPortal(
          <div
            ref={tooltip}
            id={id}
            role="tooltip"
            className="calendar-event-details"
            style={position}
            onMouseEnter={cancelDismiss}
            onMouseLeave={hideSoon}
          >
            <span className="calendar-detail-kicker">日程详情</span>
            <strong>{event.title}</strong>
            <div className="calendar-detail-line">
              <Clock3 size={15} aria-hidden="true" />
              <div>
                <span>时间</span>
                <p>{eventDetailRange(event)}</p>
              </div>
            </div>
            <div className="calendar-detail-line">
              <MapPin size={15} aria-hidden="true" />
              <div>
                <span>会议室</span>
                {event.rooms?.length ? (
                  event.rooms.map((room) => <p key={room}>{room}</p>)
                ) : (
                  <p className="calendar-detail-empty">飞书未提供会议室信息</p>
                )}
                {event.location && <p>地点：{event.location}</p>}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
