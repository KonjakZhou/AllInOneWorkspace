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
