import { z } from 'zod'
import { CalendarDays, RotateCw, Settings2 } from 'lucide-react'
import { defineWidget, type WidgetContext } from '../../sdk/types'
import { dateKey } from '../../shared/feishu'
import { agendaDays, clockTime, eventRange, eventTag, nextEvent } from './presentation'
import { CalendarEventRow } from './event-row'
import { useAgenda } from './use-agenda'
import './calendar.css'

function Calendar({
  accountId,
  signal,
  openAccountSettings,
}: WidgetContext<Record<string, never>, null>) {
  const { root, agenda, error, loading, now, refresh } = useAgenda(accountId, signal)
  const connection = agenda?.connection
  const ready =
    connection?.status === 'connected' ||
    (connection?.status === 'connecting' && !!connection.identity)
  const events = ready ? (agenda?.events ?? []) : []
  const upcoming = nextEvent(events, now.getTime())
  const days = agendaDays(events, now)
  const today = dateKey(now)
  const status = connection?.status
  const badge =
    status === 'connecting'
      ? '授权中'
      : status === 'reauth_required'
        ? '授权失效'
        : status === 'permission_denied'
          ? '权限不足'
          : !ready
            ? '未连接'
            : agenda?.stale
              ? '待刷新'
              : '可用'
  const message = error || agenda?.error?.message
  return (
    <div ref={root} className="feishu-calendar" aria-busy={loading}>
      <header className="calendar-heading">
        <div>
          <span className="calendar-kicker">FEISHU CALENDAR · READ ONLY</span>
          <h3>今日日历</h3>
        </div>
        <button
          className={`calendar-status ${ready && !agenda?.stale ? 'available' : ''}`}
          onClick={openAccountSettings}
          aria-label="打开飞书连接设置"
        >
          {loading && !agenda ? '读取中' : badge}
        </button>
      </header>
      <div className="calendar-overview">
        <div className="calendar-date">
          <span>{now.getDate()}</span>
          <b>
            {now.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}{' '}
            {now.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()}
          </b>
        </div>
        <div className="calendar-next">
          <span>NEXT</span>
          <strong title={upcoming?.title}>
            {upcoming?.title ?? (ready ? '暂无下一场日程' : '让日程各就各位')}
          </strong>
          {upcoming && (
            <time>
              {dateKey(new Date(upcoming.start)) !== today &&
                `${new Date(upcoming.start).getMonth() + 1}/${new Date(upcoming.start).getDate()} · `}
              {eventRange(upcoming)}
            </time>
          )}
        </div>
      </div>
      <div className="calendar-scroll" tabIndex={0} aria-label="飞书日程列表">
        {!ready ? (
          <div className="calendar-empty">
            <CalendarDays size={27} />
            <strong>
              {status === 'reauth_required'
                ? '请重新授权飞书'
                : status === 'permission_denied'
                  ? '需要日历读取权限'
                  : status === 'connecting'
                    ? '在浏览器中完成授权'
                    : '连接你的飞书日历'}
            </strong>
            <p>{message || connection?.message || '今天与未来七天的安排，都会在这里。'}</p>
            <button className="button" onClick={openAccountSettings}>
              {status === 'reauth_required'
                ? '重新连接'
                : status === 'permission_denied'
                  ? '检查权限'
                  : '连接飞书'}
            </button>
            {error && (
              <button className="quiet-button" onClick={() => void refresh()}>
                重试读取
              </button>
            )}
          </div>
        ) : (
          <>
            {message && (
              <div className="calendar-notice" role="alert">
                {message}
                <button className="quiet-button" disabled={loading} onClick={() => void refresh()}>
                  重试
                </button>
              </div>
            )}
            {events.length === 0 ? (
              <div className="calendar-empty">
                <CalendarDays size={27} />
                <strong>
                  {loading ? '正在读取日程…' : message ? '暂时无法读取日程' : '留一点时间给自己'}
                </strong>
                <p>
                  {!message && !loading ? '今天及后续七天没有日程。' : '恢复连接后可再次刷新。'}
                </p>
              </div>
            ) : (
              days
                .filter((day) => day.events.length || day.key === today)
                .map((day) => (
                  <section
                    className="calendar-day"
                    key={day.key}
                    aria-label={`${day.date.getMonth() + 1}月${day.date.getDate()}日日程`}
                  >
                    {day.key !== today && (
                      <div className="calendar-divider">
                        <span>
                          {day.date.getMonth() + 1}月{day.date.getDate()}日 ·{' '}
                          {new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(day.date)}
                        </span>
                      </div>
                    )}
                    {day.key === today && !day.events.length && (
                      <p className="calendar-today-empty">今天没有日程，享受这段留白。</p>
                    )}
                    {day.events.map((event) => (
                      <CalendarEventRow
                        key={event.id}
                        event={event}
                        day={day.date}
                        tag={eventTag(event, day.date, now, upcoming?.id)}
                        past={event.end <= now.getTime()}
                      />
                    ))}
                  </section>
                ))
            )}
          </>
        )}
      </div>
      <footer className="calendar-footer">
        <span>
          {agenda?.updatedAt && ready
            ? `${agenda.stale ? '上次更新' : '更新于'} ${clockTime(agenda.updatedAt)}`
            : '个人主日历 · 只读'}
        </span>
        <div>
          <button
            className="icon-button compact"
            aria-label="刷新飞书日历"
            disabled={loading || !ready}
            onClick={() => void refresh()}
          >
            <RotateCw size={13} className={loading ? 'spin' : ''} />
          </button>
          <button
            className="icon-button compact"
            aria-label="日历连接设置"
            onClick={openAccountSettings}
          >
            <Settings2 size={13} />
          </button>
        </div>
      </footer>
    </div>
  )
}

export default defineWidget({
  type: 'feishu.calendar',
  name: '飞书日历',
  description: '连接飞书，让今天和未来七天的日程清晰可见。',
  version: 1,
  icon: 'calendar',
  chrome: 'compact',
  accent: 'sand',
  defaultSize: { w: 3, h: 14 },
  minSize: { w: 3, h: 8 },
  defaultConfig: {},
  defaultData: null,
  configSchema: z.object({}),
  dataSchema: z.null(),
  Component: Calendar,
  refresh: async ({ accountId }) => {
    await window.workspace.feishu.getAgenda(accountId, true)
  },
})
