import { type Idea } from '../shared/trading-ideas'

const dateTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export function timeLabel(time: number) {
  return dateTime.format(time)
}

export function publicationLabel(item: Pick<Idea, 'publication'>) {
  if (item.publication?.precision === 'time') return timeLabel(Date.parse(item.publication.value))
  return item.publication?.value ?? '发布时间未知'
}
