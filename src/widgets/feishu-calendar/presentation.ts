import { calendarRange, dateKey, type CalendarEvent } from '../../shared/feishu'

export function agendaDays(events: CalendarEvent[], now: Date) {
  const range = calendarRange(now)
  return Array.from({ length: 8 }, (_, offset) => {
    const date = new Date(range.start)
    date.setDate(date.getDate() + offset)
    const end = new Date(date)
    end.setDate(end.getDate() + 1)
    return {
      date,
      key: dateKey(date),
      events: events
        .filter((event) => event.start < end.getTime() && event.end > date.getTime())
        .sort(
          (a, b) =>
            Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.id.localeCompare(b.id),
        ),
    }
  })
}
export function nextEvent(events: CalendarEvent[], now: number) {
  return events
    .filter((event) => !event.allDay && event.start > now)
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))[0]
}
export function nextTodayEvent(events: CalendarEvent[], now: Date) {
  return nextEvent(
    events.filter((event) => dateKey(new Date(event.start)) === dateKey(now)),
    now.getTime(),
  )
}

export function dayLabel(day: Date, now: Date) {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const label = `${day.getMonth() + 1}月${day.getDate()}日·${new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(day)}`
  return dateKey(day) === dateKey(tomorrow) ? `${label}·明天` : label
}
export const clockTime = (value: number) =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    value,
  )
export function eventRange(event: CalendarEvent) {
  if (event.allDay) return '全天'
  const start = new Date(event.start),
    end = new Date(event.end)
  return dateKey(start) === dateKey(end)
    ? `${clockTime(event.start)}–${clockTime(event.end)}`
    : `${start.getMonth() + 1}/${start.getDate()} ${clockTime(event.start)}–${end.getMonth() + 1}/${end.getDate()} ${clockTime(event.end)}`
}

export function eventTag(event: CalendarEvent, day: Date, now: Date, nextId?: string) {
  const key = dateKey(day)
  if (event.id === nextId && dateKey(new Date(event.start)) === key) return 'NEXT'
  return key === dateKey(now) ? 'TODAY' : ''
}

export function eventDetailRange(event: CalendarEvent) {
  const formatDate = (value: number) =>
    new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'short',
    }).format(value)
  const start = formatDate(event.start)
  // All-day end dates are exclusive; show the final covered day, including across DST.
  const end = formatDate(event.allDay ? event.end - 1 : event.end)
  if (event.allDay) return `${start === end ? start : `${start} — ${end}`} · 全天`
  return start === end
    ? `${start} · ${clockTime(event.start)}–${clockTime(event.end)}`
    : `${start} ${clockTime(event.start)} — ${end} ${clockTime(event.end)}`
}
