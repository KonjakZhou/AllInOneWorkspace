import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ExternalLink, Newspaper, RotateCw } from 'lucide-react'
import { z } from 'zod'
import { defineWidget, type WidgetContext } from '../../sdk/types'
import { WidgetScrollFooter } from '../../components/WidgetScrollFooter'
import { errorMessage } from '../../shared/model'
import type { TelegraphFeed, TelegraphItem } from '../../shared/telegraph'
import { useTelegraph } from './use-telegraph'
import { useEdgeGestures } from './use-edge-gestures'
import {
  INITIAL_HISTORY,
  includeOlder,
  includeNewer,
  olderCursor,
  trimHistory,
} from './history-window'
import './telegraph.css'

const configSchema = z.object({ view: z.enum(['all', 'important']) })
type Config = z.infer<typeof configSchema>
const filters: Record<
  Config['view'],
  { label: string; matches: (item: TelegraphItem) => boolean }
> = {
  all: { label: '全部', matches: () => true },
  important: { label: '重点', matches: (item) => item.important },
}
type Direction = 'older' | 'newer'

function arrivingItems(feed: TelegraphFeed | null, head: TelegraphFeed | null) {
  const newest = head?.items[0]
  if (!newest || !feed) return []
  const seen = new Set(head.items.map((item) => item.id))
  return feed.items.filter((item) => !seen.has(item.id) && item.publishedAt >= newest.publishedAt)
}

function itemTime(timestamp: number) {
  const date = new Date(timestamp)
  const today = new Date()
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  return date.toLocaleString('zh-CN', {
    ...(sameDay ? {} : { month: '2-digit', day: '2-digit' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function Telegraph({ config, updateConfig, signal }: WidgetContext<Config, null>) {
  const { root, feed, error, loading, refresh, idle, visible } = useTelegraph(signal)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [head, setHead] = useState<TelegraphFeed | null>(null)
  const [history, setHistory] = useState(INITIAL_HISTORY)
  const [newIds, setNewIds] = useState<Set<number>>(() => new Set())
  const [historyLoading, setHistoryLoading] = useState<Direction | null>(null)
  const [historyError, setHistoryError] = useState<{
    direction: Direction
    message: string
  } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [away, setAway] = useState(false)
  const [pastFirstPage, setPastFirstPage] = useState(false)
  const [needsFill, setNeedsFill] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const rows = useRef<HTMLDivElement>(null)
  const lastScrollTop = useRef(0)
  const historyRequest = useRef<symbol | null>(null)
  const refreshRequest = useRef(false)
  const anchor = useRef<{ id: string; top: number } | null>(null)
  const previousView = useRef(config.view)
  const filterAnchor = useRef<number | null>(null)
  const visibleRef = useRef(visible)
  const currentLocation = useRef({ history, head })
  const { matches } = filters[config.view]
  const headItems = useMemo(() => head?.items.filter(matches) ?? [], [head, matches])
  const nextOlder = olderCursor(history, head?.historyCursor)
  const canGoBack = !history.showHead || pastFirstPage

  useLayoutEffect(() => {
    visibleRef.current = visible
  }, [visible])
  useLayoutEffect(() => {
    currentLocation.current = { history, head }
  }, [history, head])

  useEffect(() => {
    if (!feed || feed === head || idle) return
    if (head && (!history.showHead || lastScrollTop.current > 1)) return
    if (head && history.end && head.historyCursor !== feed.historyCursor) return
    const added = arrivingItems(feed, head)
    if (added.length) setNewIds(new Set(added.map((item) => item.id)))
    setHead(feed)
  }, [feed, head, history.showHead, history.end, idle, away])

  useEffect(() => {
    if (!idle) return
    historyRequest.current = null
    lastScrollTop.current = 0
    anchor.current = null
    setHead(null)
    setNewIds(new Set())
    setHistory(INITIAL_HISTORY)
    setHistoryLoading(null)
    setHistoryError(null)
    setExpanded(null)
    setAway(false)
    setPastFirstPage(false)
  }, [idle])

  useEffect(() => {
    if (!newIds.size) return
    const timer = setTimeout(() => setNewIds(new Set()), 20000)
    return () => clearTimeout(timer)
  }, [newIds])

  const items = useMemo(() => {
    const byId = new Map<number, TelegraphItem>()
    const visibleHead = history.showHead ? headItems : []
    for (const item of [...visibleHead, ...history.pages.flatMap((page) => page.items)]) {
      if (matches(item) && !byId.has(item.id)) byId.set(item.id, item)
    }
    return [...byId.values()]
  }, [matches, headItems, history.pages, history.showHead])
  const pending = arrivingItems(feed, head).filter(matches).length

  const visibleRow = () => {
    const element = list.current
    if (!element) return
    const top = element.getBoundingClientRect().top
    return [...element.querySelectorAll<HTMLElement>('[data-telegraph-id]')].find(
      (row) => row.getBoundingClientRect().bottom > top,
    )
  }

  const goToTop = () => {
    anchor.current = null
    lastScrollTop.current = 0
    if (list.current) list.current.scrollTop = 0
    setAway(false)
    setPastFirstPage(false)
  }

  useLayoutEffect(() => {
    if (previousView.current === config.view) return
    previousView.current = config.view
    const cursor = filterAnchor.current
    filterAnchor.current = null
    const start = cursor === 0 ? 0 : cursor ? history.cursors.indexOf(cursor) : history.start
    const showHead = cursor === 0 || (cursor === null && history.showHead)
    historyRequest.current = null
    setHistoryLoading(null)
    setHistoryError(null)
    setExpanded(null)
    setHistory({
      ...history,
      showHead,
      start: Math.max(start, 0),
      end: Math.max(start, 0),
      pages: [],
    })
    goToTop()
  }, [config.view, history])

  const showLatest = (result: TelegraphFeed) => {
    const { history: currentHistory, head: currentHead } = currentLocation.current
    if (result.historyCursor !== currentHead?.historyCursor || !currentHistory.showHead) {
      historyRequest.current = null
      setHistoryLoading(null)
      setHistory(
        result.historyCursor === currentHead?.historyCursor
          ? { ...currentHistory, showHead: true, start: 0, end: 0, pages: [] }
          : INITIAL_HISTORY,
      )
    }
    setHistoryError(null)
    const added = arrivingItems(result, currentHead)
    if (added.length) setNewIds(new Set(added.map((item) => item.id)))
    setHead(result)
    goToTop()
  }

  const refreshLatest = async (jump = false) => {
    if (refreshRequest.current || signal.aborted) return
    if (jump) {
      const latest = feed ?? head
      if (latest) showLatest(latest)
      list.current?.focus({ preventScroll: true })
    }
    refreshRequest.current = true
    setRefreshing(true)
    try {
      const result = await refresh(true)
      if (!result || result.error || signal.aborted) return
      if (currentLocation.current.history.showHead && lastScrollTop.current <= 1) showLatest(result)
    } finally {
      refreshRequest.current = false
      if (!signal.aborted) setRefreshing(false)
    }
  }

  const rememberScroll = () => {
    const first = visibleRow()
    anchor.current = first
      ? { id: first.dataset.telegraphId!, top: first.getBoundingClientRect().top }
      : null
  }

  useLayoutEffect(() => {
    const element = list.current
    const previous = anchor.current
    anchor.current = null
    if (!element || !previous) return
    const row = element.querySelector<HTMLElement>(`[data-telegraph-id="${previous.id}"]`)
    if (row) element.scrollTop += row.getBoundingClientRect().top - previous.top
    lastScrollTop.current = element.scrollTop
    setAway(element.scrollTop > 1)
    setPastFirstPage(element.scrollTop > element.clientHeight)
  }, [history])

  const pageHistory = async (direction: Direction) => {
    if (!head || historyRequest.current || !visible || idle || signal.aborted) return
    if (direction === 'older' ? nextOlder == null : history.showHead) return
    const request = Symbol()
    historyRequest.current = request
    setHistoryLoading(direction)
    setHistoryError(null)
    const current = () => !signal.aborted && historyRequest.current === request
    let updated = history
    try {
      while (current() && visibleRef.current) {
        const cursor =
          direction === 'older'
            ? olderCursor(updated, head.historyCursor)
            : updated.cursors[updated.start - 1]
        if (cursor == null) {
          if (direction === 'newer') updated = includeNewer(updated)
          break
        }
        const result = await window.workspace.telegraph.loadOlder(cursor)
        if (!current()) return
        if (result.error) {
          setHistoryError({ direction, message: result.error.message })
          break
        }
        const page = { ...result.page, items: result.page.items.filter(matches) }
        updated = direction === 'older' ? includeOlder(updated, page) : includeNewer(updated, page)
        if (page.items.length) break
      }
      if (updated !== history) {
        rememberScroll()
        const limit = Math.max(150, Math.ceil((list.current?.clientHeight ?? 0) / 30) * 3)
        setHistory(trimHistory(updated, direction, headItems.length, limit))
      }
    } catch (reason) {
      if (current()) setHistoryError({ direction, message: errorMessage(reason) })
    } finally {
      if (current()) {
        historyRequest.current = null
        setHistoryLoading(null)
      }
    }
  }
  useLayoutEffect(() => {
    const listElement = list.current
    const rowElement = rows.current
    if (!listElement || !rowElement) return
    const check = () => {
      const height = listElement.clientHeight
      setNeedsFill(height > 0 && rowElement.offsetHeight < height)
      setPastFirstPage(listElement.scrollTop > height)
    }
    check()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(check)
    observer.observe(listElement)
    observer.observe(rowElement)
    return () => observer.disconnect()
  }, [items])

  useEffect(() => {
    if (!needsFill || !head || !visible || historyLoading || historyError || nextOlder == null)
      return
    const timer = setTimeout(() => void pageHistory('older'), 75)
    return () => clearTimeout(timer)
  })

  const pull = useEdgeGestures(list, {
    refresh: refreshLatest,
    older: () => void pageHistory('older'),
    newer: history.showHead ? undefined : () => void pageHistory('newer'),
  })

  return (
    <div ref={root} className="cls-telegraph" aria-busy={loading}>
      <header className="telegraph-heading">
        <div className="telegraph-brand">
          <span className={`telegraph-live ${feed?.stale || error ? 'is-stale' : ''}`} />
          <div>
            <span>CAILIANPRESS · LIVE</span>
            <h3>财联社 7×24</h3>
          </div>
        </div>
        <div className="telegraph-tabs" aria-label="快讯范围">
          {configSchema.shape.view.options.map((view) => (
            <button
              key={view}
              className={config.view === view ? 'active' : ''}
              aria-pressed={config.view === view}
              onClick={() => {
                if (view === config.view) return
                const item = Number(visibleRow()?.dataset.telegraphId)
                filterAnchor.current =
                  history.pages.find((page) => page.items.some((row) => row.id === item))?.cursor ??
                  (history.showHead ? 0 : null)
                updateConfig({ view })
              }}
            >
              {filters[view].label}
            </button>
          ))}
        </div>
      </header>

      {(feed?.error || error) && !!head?.items.length && (
        <div className="telegraph-notice" role="status">
          更新受阻 · {feed?.error?.message || error}
        </div>
      )}
      <div
        className="telegraph-pull"
        data-phase={pull.phase}
        data-armed={pull.armed}
        style={{ height: pull.height }}
        aria-hidden={pull.phase === 'idle'}
      >
        <span className="telegraph-pull-inner">
          {pull.phase === 'refreshing' ? (
            <RotateCw className="spin" size={15} aria-hidden="true" />
          ) : (
            <ArrowDown size={15} aria-hidden="true" />
          )}
          <span role="status">
            {pull.phase === 'refreshing'
              ? '正在刷新快讯'
              : pull.armed
                ? '松手刷新快讯'
                : '下拉刷新快讯'}
          </span>
        </span>
      </div>

      <div className="telegraph-stream">
        {canGoBack && (
          <button
            className="telegraph-jump"
            disabled={refreshing}
            onClick={() => void refreshLatest(true)}
          >
            {refreshing ? (
              <RotateCw className="spin" size={13} aria-hidden="true" />
            ) : (
              <ArrowUp size={13} aria-hidden="true" />
            )}
            回到最新
            {pending > 0 && <span>· {pending} 条新快讯</span>}
          </button>
        )}
        {(historyLoading === 'newer' || historyError?.direction === 'newer') && (
          <div className="telegraph-newer-status" role="status">
            {historyError?.direction === 'newer' ? historyError.message : '正在加载较新的快讯…'}
          </div>
        )}
        <div
          ref={list}
          className="telegraph-list"
          tabIndex={0}
          aria-label="财联社快讯列表"
          onScroll={(event) => {
            const { scrollTop, scrollHeight, clientHeight } = event.currentTarget
            const delta = scrollTop - lastScrollTop.current
            lastScrollTop.current = scrollTop
            setAway(scrollTop > 1)
            setPastFirstPage(scrollTop > clientHeight)
            if (
              delta > 0 &&
              scrollHeight - scrollTop - clientHeight <= 10 &&
              historyError?.direction !== 'older'
            )
              void pageHistory('older')
            if (
              delta < 0 &&
              scrollTop <= 8 &&
              !history.showHead &&
              historyError?.direction !== 'newer'
            )
              void pageHistory('newer')
          }}
          onKeyDown={(event) => {
            if (
              event.target !== event.currentTarget ||
              history.showHead ||
              event.currentTarget.scrollTop > 1
            )
              return
            if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
              event.preventDefault()
              void pageHistory('newer')
            }
          }}
        >
          {loading && !feed ? (
            <div className="telegraph-empty">
              <RotateCw className="spin" size={22} />
              <strong>正在接入最新电报</strong>
              <p>首次读取可能需要几秒。</p>
            </div>
          ) : (error || feed?.error) && !head?.items.length ? (
            <div className="telegraph-empty" role="alert">
              <Newspaper size={24} />
              <strong>暂时无法读取财联社</strong>
              <p>{feed?.error?.message || error}</p>
              <button className="button small" onClick={() => void refreshLatest()}>
                重试
              </button>
            </div>
          ) : null}
          <div ref={rows} className="telegraph-rows">
            {items.map((item) => {
              const open = expanded === item.id
              return (
                <article
                  className={`telegraph-item ${item.important ? 'is-important' : ''} ${newIds.has(item.id) ? 'is-new' : ''}`}
                  key={item.id}
                  data-telegraph-id={item.id}
                >
                  <button
                    className="telegraph-item-summary"
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : item.id)}
                  >
                    <time>{itemTime(item.publishedAt)}</time>
                    <span>
                      <em
                        className={`telegraph-level level-${item.level.toLowerCase().replace(/[^a-z0-9]/g, '') || 'unknown'}`}
                      >
                        {item.level}
                      </em>
                      {item.important && config.view === 'all' && <b>重点</b>}
                      {item.headline}
                    </span>
                  </button>
                  {open && (
                    <div className="telegraph-detail">
                      <p>{item.content}</p>
                      {!!item.subjects.length && (
                        <div className="telegraph-subjects">
                          {item.subjects.slice(0, 3).map((subject) => (
                            <span key={subject}>{subject}</span>
                          ))}
                        </div>
                      )}
                      <button onClick={() => void window.workspace.telegraph.openItem(item.id)}>
                        打开财联社原文 <ExternalLink size={12} />
                      </button>
                    </div>
                  )}
                </article>
              )
            })}
          </div>
          {head && !items.length && !(feed?.error || error) && (
            <div className="telegraph-empty">
              <Newspaper size={24} />
              <strong>
                {nextOlder && !historyError ? '正在查找符合条件的快讯' : '暂无符合条件的快讯'}
              </strong>
            </div>
          )}
          {head &&
            (nextOlder ? (
              <button
                className="telegraph-history-loader"
                disabled={!!historyLoading}
                onClick={() => void pageHistory('older')}
              >
                {historyLoading === 'older' ? (
                  <>
                    <span className="telegraph-loading-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    正在加载更早快讯
                  </>
                ) : historyError?.direction === 'older' ? (
                  '重试加载更早快讯'
                ) : (
                  '继续下拉，加载更早快讯'
                )}
              </button>
            ) : (
              <div className="telegraph-history-end">没有更早的快讯了</div>
            ))}
          {historyError?.direction === 'older' && (
            <div className="telegraph-history-end" role="status">
              {historyError.message}
            </div>
          )}
        </div>
      </div>

      <WidgetScrollFooter
        className="telegraph-footer"
        updatedAt={feed?.updatedAt}
        stale={feed?.stale}
        fallback="数据来自财联社"
      >
        <button
          className="icon-button compact"
          aria-label="刷新财联社快讯"
          disabled={refreshing}
          onClick={() => void refreshLatest()}
        >
          <RotateCw size={13} className={loading ? 'spin' : ''} />
        </button>
      </WidgetScrollFooter>
    </div>
  )
}

export default defineWidget({
  type: 'news.cls-telegraph',
  name: '财联社 7×24',
  description: '每 30 秒检查财联社最新电报，把市场动态放进工作区。',
  version: 1,
  icon: 'news',
  chrome: 'compact',
  accent: 'peach',
  defaultSize: { w: 4, h: 15 },
  minSize: { w: 3, h: 8 },
  defaultConfig: { view: 'all' },
  defaultData: null,
  configSchema,
  dataSchema: z.null(),
  Component: Telegraph,
  refresh: async () => {
    await window.workspace.telegraph.getFeed(true)
  },
})
