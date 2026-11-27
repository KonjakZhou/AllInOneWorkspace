import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, Check, Mail, RotateCw } from 'lucide-react'
import { ChoicePicker } from '../components/ChoicePicker'
import { WidgetScrollFooter } from '../components/WidgetScrollFooter'
import { WidgetEmpty } from '../sdk/components'
import { useEdgeGestures } from '../widgets/cls-telegraph/use-edge-gestures'
import { errorMessage } from '../shared/model'
import { MAIL_POLICY } from '../shared/mail-policy'
import {
  mailKey,
  type MailAPI,
  type MailAccount,
  type MailCursor,
  type MailFilter,
  type MailPage,
  type MailRef,
  type MailSummary,
} from '../shared/mail'

const IDLE = MAIL_POLICY.memoryIdleMs
const POLL = MAIL_POLICY.refreshMs
const FIRST: MailPage = { items: [], next: null, issues: [] }
const cursorId = (cursor?: MailCursor) => (cursor ? JSON.stringify(cursor) : 'latest')
type Slot = { cursor?: MailCursor; page: MailPage | null }
const same = (a: MailCursor | null, b?: MailCursor) => !!a && !!b && cursorId(a) === cursorId(b)
const newestFirst = (a: MailSummary, b: MailSummary) =>
  b.time - a.time || (mailKey(a) < mailKey(b) ? -1 : 1)

const folderOptions = [
  { value: 'all', label: '全部邮件' },
  { value: 'inbox', label: '收件' },
  { value: 'unread', label: '未读' },
  { value: 'sent', label: '发件' },
] as const
export function MailFilters({
  filter,
  accounts,
  change,
}: {
  filter: MailFilter
  accounts: MailAccount[]
  change: (filter: MailFilter) => void
}) {
  return (
    <div className="mail-filters" role="group" aria-label="筛选邮件">
      <ChoicePicker
        label="邮箱账号"
        compact
        disabled={!accounts.length}
        value={accounts.some(({ id }) => id === filter.account) ? (filter.account ?? '') : ''}
        options={[
          { value: '', label: '全部账号' },
          ...accounts.map(({ id, email }) => ({ value: id, label: email })),
        ]}
        onChange={(account) => change({ ...filter, account: account || null })}
      />
      <ChoicePicker
        label="邮件类型"
        compact
        disabled={!accounts.length}
        value={filter.folder}
        options={folderOptions}
        onChange={(folder) => change({ ...filter, folder })}
      />
    </div>
  )
}

export const displayAddress = ({ name, email }: { name: string; email: string }) =>
  name && email && name !== email ? name + ' <' + email + '>' : name || email
export const seenTime = (time: number) =>
  new Date(time).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
export const filterKey = (filter: MailFilter) => (filter.account ?? '') + ':' + filter.folder

function visibleRow(list: HTMLDivElement) {
  const top = list.getBoundingClientRect().top
  return [...list.querySelectorAll<HTMLElement>('[data-mail-key]')].find(
    (row) => row.getBoundingClientRect().bottom > top,
  )
}

export function MailFeed({
  api,
  filter,
  selected,
  select,
  compact = false,
  accounts,
  active = true,
  footerAction,
  startAt,
}: {
  api: MailAPI
  filter: MailFilter
  selected?: MailRef | null
  select: (
    message: MailSummary,
    trigger: HTMLButtonElement,
    startAt: { cursor?: MailCursor; page: MailPage },
  ) => void
  compact?: boolean
  accounts: MailAccount[]
  active?: boolean
  footerAction?: ReactNode
  startAt?: { cursor?: MailCursor; page: MailPage }
}) {
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const anchor = useRef<{ id: string; offset: number } | null>(null)
  const request = useRef<symbol | null>(null)
  const retryMode = useRef<'latest' | 'older' | 'newer' | 'retry'>('latest')
  const alive = useRef(false)
  const shown = useRef(false)
  const slots = useRef<Slot[]>([startAt ?? { page: null }])
  const readKeys = useRef(new Map<string, number>())
  const [pages, setPages] = useState<Slot[]>(slots.current)
  const [opening, setOpening] = useState(startAt)
  const [cached, setCached] = useState<MailPage | null>(null)
  const [pending, setPending] = useState<MailPage | null>(null)
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [away, setAway] = useState(false)
  const handlers = useRef({ refresh: async (_force?: boolean) => {}, clear: () => {} })
  const matchingAccounts = accounts.filter(({ id }) => !filter.account || filter.account === id)
  const enabled = matchingAccounts.some(({ reauthorize }) => !reauthorize)
  const canLoad = () => enabled && active && shown.current && !request.current
  const available = enabled && active && visible
  const canRefresh = available && !busy

  function keepAnchor() {
    const element = list.current
    if (!element) return
    const row = visibleRow(element)
    if (row?.dataset.mailKey)
      anchor.current = { id: row.dataset.mailKey, offset: row.getBoundingClientRect().top }
  }
  function publish(value: Slot[]) {
    slots.current = value
    setPages(value)
  }
  function applySeen(page: MailPage): MailPage {
    const items = page.items.map((item) =>
      (readKeys.current.get(mailKey(item)) ?? 0) > Date.now() ? { ...item, unread: false } : item,
    )
    return {
      ...page,
      items: filter.folder === 'unread' ? items.filter(({ unread }) => unread) : items,
    }
  }
  useLayoutEffect(() => {
    setOpening(startAt && { ...startAt, page: applySeen(startAt.page) })
  }, [startAt])

  function displayHead(result: MailPage) {
    const [head, ...history] = slots.current
    const previous = !head?.cursor ? head?.page : null
    if (previous && history.length) {
      const fresh = new Map(result.items.map((item) => [mailKey(item), item]))
      const overlap = previous.items.some((item) => fresh.has(mailKey(item)))
      if (
        overlap ||
        result.issues.length ||
        (previous.next && cursorId(previous.next) === cursorId(result.next ?? undefined))
      ) {
        const oldest = result.items.at(-1)
        for (const item of previous.items) {
          const key = mailKey(item)
          if (!fresh.has(key) && (!oldest || newestFirst(item, oldest) > 0)) fresh.set(key, item)
        }
        if (fresh.size <= 150) {
          publish([
            {
              page: {
                ...result,
                items: [...fresh.values()].sort(newestFirst),
                next: previous.next,
              },
            },
            ...history,
          ])
          return
        }
      }
    }
    if (previous && history.length && result.issues.length && !result.items.length) return
    publish([{ page: result }])
  }
  async function load(mode: 'latest' | 'older' | 'newer' | 'retry', force = false, jump = false) {
    if (!canLoad()) return
    const initial = slots.current
    const loaded = initial.filter((entry) => entry.page)
    const first = loaded[0]
    const last = loaded.at(-1)
    const next = last?.page?.next
    const previous = first ? initial[initial.indexOf(first) - 1] : undefined
    if (mode === 'older' && !next) return
    if (mode === 'newer' && !previous) return
    const cursor =
      mode === 'newer'
        ? previous?.cursor
        : mode === 'older'
          ? (next ?? undefined)
          : mode === 'retry'
            ? (last?.cursor ?? initial[0]?.cursor)
            : undefined
    retryMode.current = mode
    const id = Symbol()
    request.current = id
    setBusy(true)
    try {
      const result = applySeen(await api.list(filter, cursor, force))
      if (!alive.current || request.current !== id) return
      setError('')
      if (mode === 'latest') {
        if (result.issues.length) {
          const failed = new Set(result.issues.map(({ account }) => account))
          const saved = (first?.page ?? cached)?.items ?? []
          const map = new Map(
            saved.filter((item) => failed.has(item.account)).map((item) => [mailKey(item), item]),
          )
          for (const item of result.items) map.set(mailKey(item), item)
          result.items = [...map.values()].sort(newestFirst)
        }
        if (!jump && first?.page && (first.cursor || (list.current?.scrollTop ?? 0) > 2))
          setPending(result)
        else {
          displayHead(result)
          setPending(null)
        }
        if (!result.issues.length) setUpdatedAt(Date.now())
        return
      }
      keepAnchor()
      let value = slots.current.slice()
      const index = value.findIndex((entry) => cursorId(entry.cursor) === cursorId(cursor))
      if (index >= 0) value[index] = { cursor, page: result }
      else value.push({ cursor, page: result })
      // Empty history ranges carry only a continuation cursor. Keep the tail cursor without
      // letting a run of empty ranges evict rows the user can still see.
      value = value.filter(
        ({ page }, i) =>
          i === 0 ||
          i === value.length - 1 ||
          !page ||
          page.items.length > 0 ||
          page.issues.length > 0,
      )
      const loadedIndexes = value.flatMap((entry, i) => (entry.page?.items.length ? [i] : []))
      const budget = Math.max(3, Math.ceil((list.current?.clientHeight ?? 0) / 1800) + 2)
      for (const i of mode === 'newer'
        ? loadedIndexes.slice(budget)
        : loadedIndexes.slice(0, -budget))
        value[i] = { cursor: value[i].cursor, page: null }
      publish(value)
    } catch (reason) {
      if (alive.current && request.current === id) setError(errorMessage(reason))
    } finally {
      if (alive.current && request.current === id) {
        request.current = null
        setBusy(false)
      }
    }
  }

  useLayoutEffect(() => {
    handlers.current = {
      refresh: (force) =>
        load(slots.current[0]?.cursor && !slots.current[0]?.page ? 'retry' : 'latest', force),
      clear: () => {
        request.current = null
        setBusy(false)
        setPending(null)
        setUpdatedAt(null)
        setAway(false)
        setError('')
        setCached(null)
        setOpening(undefined)
        publish([{ page: null }])
      },
    }
  })

  useEffect(() => {
    alive.current = true
    setBusy(false)
    let inView = !compact
    let idle: ReturnType<typeof setTimeout> | undefined
    let cacheTimer: ReturnType<typeof setTimeout> | undefined
    let requestedCache = false
    let observing = true
    const readCache = (disk = false) => {
      void api
        .cached(filter, disk)
        .then((items) => {
          if (!observing || slots.current.some((slot) => slot.page?.items.length)) return
          setCached((existing) => {
            const all = new Map((existing?.items ?? []).map((item) => [mailKey(item), item]))
            for (const item of items) {
              const key = mailKey(item)
              if (!disk || !all.has(key)) all.set(key, item)
            }
            return applySeen({
              ...FIRST,
              items: [...all.values()].sort(newestFirst).slice(0, MAIL_POLICY.listPageSize),
            })
          })
        })
        .catch(() => undefined)
    }
    const check = () => {
      window.clearTimeout(idle)
      shown.current = active && inView && document.visibilityState === 'visible'
      setVisible(shown.current)
      if (shown.current) {
        if (!requestedCache && !slots.current.some((slot) => slot.page)) {
          requestedCache = true
          readCache(true)
        }
        void handlers.current.refresh()
      } else
        idle = setTimeout(() => {
          handlers.current.clear()
          readKeys.current.clear()
          requestedCache = false
        }, IDLE)
    }
    const observer = new IntersectionObserver(([entry]) => {
      inView = !!entry?.isIntersecting
      check()
    })
    if (root.current) observer.observe(root.current)
    check()
    const poll = setInterval(() => {
      if (document.hasFocus()) void handlers.current.refresh()
    }, POLL)
    const off = api.onChanged((change) => {
      if (change.kind === 'read') {
        const key = mailKey(change.message)
        readKeys.current.set(key, Date.now() + POLL)
        if (readKeys.current.size > 500)
          readKeys.current.delete(readKeys.current.keys().next().value!)
        const apply = (page: MailPage) => ({
          ...page,
          items: page.items.flatMap((item) =>
            mailKey(item) !== key
              ? [item]
              : filter.folder === 'unread'
                ? []
                : [{ ...item, unread: false }],
          ),
        })
        publish(
          slots.current.map((item) => ({ ...item, page: item.page ? apply(item.page) : null })),
        )
        setCached((page) => page && apply(page))
        setOpening((entry) => entry && { ...entry, page: apply(entry.page) })
        setPending((page) => page && apply(page))
      } else if (
        change.kind === 'cache' &&
        shown.current &&
        (!filter.account || change.account === filter.account) &&
        !slots.current.some((slot) => slot.page?.items.length)
      ) {
        if (cacheTimer === undefined)
          cacheTimer = setTimeout(() => {
            cacheTimer = undefined
            readCache()
          }, 40)
      } else if (change.kind === 'accounts') void handlers.current.refresh()
      else if (change.kind === 'resume') check()
    })
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      alive.current = false
      observing = false
      request.current = null
      shown.current = false
      window.clearTimeout(idle)
      clearTimeout(cacheTimer)
      clearInterval(poll)
      observer.disconnect()
      off()
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [api, filter.folder, compact, enabled, active])

  const positioned = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!active || !selected || compact) {
      positioned.current = null
      return
    }
    const key = mailKey(selected)
    if (positioned.current === key) return
    const node = [...(list.current?.querySelectorAll<HTMLElement>('[data-mail-key]') ?? [])].find(
      (row) => row.dataset.mailKey === key,
    )
    if (node) {
      node.scrollIntoView({ block: 'nearest' })
      positioned.current = key
    }
  }, [active, compact, selected, pages, opening])

  useLayoutEffect(() => {
    const element = list.current
    const saved = anchor.current
    anchor.current = null
    if (!element || !saved) return
    const row = [...element.querySelectorAll<HTMLElement>('[data-mail-key]')].find(
      (node) => node.dataset.mailKey === saved.id,
    )
    if (row) element.scrollTop += row.getBoundingClientRect().top - saved.offset
  }, [pages])

  const loaded = pages.filter((entry) => entry.page)
  const last = loaded.at(-1)
  const first = loaded[0]
  const canNewer = !!first?.cursor
  const status = last?.page ?? FIRST
  const hasRows = loaded.some(({ page }) => page?.items.length)
  const showCached =
    cached?.items.length && !hasRows && (!last || status.next || status.issues.length)
  const visiblePages: Slot[] = showCached ? [{ page: cached }] : loaded
  const rows = new Map<string, MailSummary>()
  for (const { page } of visiblePages)
    for (const item of page?.items ?? []) rows.set(mailKey(item), item)
  // The card may have a selected record beyond the full-page list's current cursor.
  // Keep it visible without using the card's page as a pagination boundary.
  const openingItem =
    selected && opening?.page.items.find((item) => mailKey(item) === mailKey(selected))
  if (openingItem && !rows.has(mailKey(openingItem))) rows.set(mailKey(openingItem), openingItem)
  const items = [...rows.values()].sort(newestFirst)
  const needsAuthorization = matchingAccounts.length > 0 && !enabled
  const report = new Map(
    (pending?.issues ?? status.issues).map(({ account, message }) => [account, message]),
  )
  const issues = matchingAccounts.flatMap(({ id, email, issue, reauthorize }) => {
    const message = issue || report.get(id) || (reauthorize ? '请重新授权邮箱后刷新。' : '')
    return message ? [{ id, email, message }] : []
  })
  const issue = !!error || issues.length > 0
  const autoLoad = () => {
    const element = list.current
    if (
      element &&
      canRefresh &&
      !error &&
      status.next &&
      !same(status.next, last?.cursor) &&
      (!hasRows || element.scrollHeight - element.scrollTop - element.clientHeight < 80)
    )
      void load('older')
  }
  useEffect(() => {
    if (canRefresh) autoLoad()
  }, [canRefresh, items.length, cursorId(status.next ?? undefined)])
  useEffect(() => {
    const resize = new ResizeObserver(autoLoad)
    if (list.current) resize.observe(list.current)
    return () => resize.disconnect()
  })

  function newest() {
    list.current?.scrollTo({ top: 0 })
    setAway(false)
    if (pending) {
      displayHead(pending)
      setPending(null)
    } else if (canNewer) {
      void load('latest', false, true)
    }
  }

  const pull = useEdgeGestures(list, {
    refresh: () => load('latest', true),
    canRefresh: canLoad,
    minRefreshMs: 0,
    older: () => void load('older'),
    newer: canNewer ? () => void load('newer') : undefined,
  })
  const showPull = pull.height > 0 && (pull.phase === 'refreshing' ? available && busy : canRefresh)

  return (
    <div className="mail-feed" ref={root}>
      {issue && (
        <div className="notice notice-error mail-feed-issue" role="status">
          <div>
            {error && <p>{error}</p>}
            {issues.map(({ id, email, message }) => (
              <p key={id}>
                <strong>{email}</strong> <span>{message}</span>
              </p>
            ))}
          </div>
          {enabled && (
            <button
              className="button small"
              disabled={!canRefresh}
              onClick={() => void load(error ? retryMode.current : 'latest', true)}
            >
              重试
            </button>
          )}
        </div>
      )}
      <div
        className="mail-feed-list"
        ref={list}
        role="region"
        tabIndex={0}
        aria-label="邮件列表"
        aria-busy={busy}
        onScroll={() => {
          setAway((list.current?.scrollTop ?? 0) > 2 || canNewer)
          autoLoad()
        }}
      >
        {showPull && (
          <div className="mail-pull" style={{ height: pull.height }} aria-hidden="true">
            <span>
              {pull.phase === 'refreshing'
                ? '正在刷新…'
                : pull.armed
                  ? '松手刷新邮件'
                  : '下拉刷新邮件'}
            </span>
          </div>
        )}
        {!items.length && !issue && (!enabled || (!busy && last && !status.next)) && (
          <WidgetEmpty
            compact
            icon={<Mail size={22} />}
            message={enabled ? '暂无邮件' : '添加邮箱后查看邮件'}
          />
        )}
        {items.map((message) => {
          const key = mailKey(message)
          const label = (
            filter.folder === 'sent' || (message.sent && !message.inbox) ? message.to : message.from
          )
            .map(displayAddress)
            .join('，')
          return (
            <div
              className="mail-row"
              key={key}
              data-mail-key={key}
              data-selected={selected ? mailKey(selected) === key : undefined}
            >
              <button
                className="mail-row-main"
                onClick={(event) => {
                  const entry =
                    visiblePages.find(({ page }) =>
                      page?.items.some((item) => mailKey(item) === key),
                    ) ?? opening
                  if (entry?.page)
                    select(message, event.currentTarget, { cursor: entry.cursor, page: entry.page })
                }}
                aria-current={selected && mailKey(selected) === key ? 'true' : undefined}
              >
                <span className="mail-row-subject">
                  {message.unread && <i className="mail-unread-dot" aria-label="未读" />}
                  {message.subject || '（无主题）'}
                </span>
                <span className="mail-correspondent" title={label}>
                  {label || '未知联系人'}
                </span>
                {compact && message.preview && (
                  <span className="mail-row-preview">{message.preview}</span>
                )}
                {!compact && <time>{seenTime(message.time)}</time>}
              </button>
              {message.unread && (
                <button
                  className="icon-button compact"
                  disabled={reading === key}
                  title={compact ? '标为已读' : undefined}
                  aria-label="标为已读"
                  onClick={() => {
                    setReading(key)
                    setError('')
                    void api
                      .markRead(message)
                      .catch((reason) => setError(errorMessage(reason)))
                      .finally(() => setReading(null))
                  }}
                >
                  <Check size={14} aria-hidden="true" />
                  {!compact && (
                    <span className="control-hint" aria-hidden="true">
                      标为已读
                    </span>
                  )}
                </button>
              )}
            </div>
          )
        })}
        {canRefresh && !error && status.next && (
          <button className="quiet-button mail-more" onClick={() => void load('older')}>
            查看更早邮件
          </button>
        )}
      </div>
      <WidgetScrollFooter
        updatedAt={enabled && !busy && !issue ? updatedAt : null}
        fallback={
          needsAuthorization
            ? '需要重新授权'
            : !enabled
              ? '未连接邮箱'
              : busy || (!last && !issue)
                ? '正在读取…'
                : issue
                  ? items.length
                    ? '部分邮件暂不可用'
                    : '读取失败'
                  : items.length + ' 封邮件'
        }
      >
        {(away || canNewer || pending) && (
          <button
            className="icon-button compact"
            aria-label="回到最新"
            title="回到最新"
            onClick={newest}
          >
            <ArrowUp size={13} />
          </button>
        )}
        <button
          className="icon-button compact"
          title="刷新邮件"
          aria-label="刷新邮件"
          disabled={!canRefresh}
          onClick={() => void load('latest', true)}
        >
          <RotateCw size={13} className={available && busy ? 'spin' : undefined} />
        </button>
        {footerAction}
      </WidgetScrollFooter>
    </div>
  )
}
