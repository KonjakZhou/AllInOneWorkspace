import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowUpRight, BookOpen, Plus, RefreshCw } from 'lucide-react'
import {
  categories,
  chinaDay,
  IDEA_PAGE_SIZE,
  topics,
  type Idea,
  type IdeaDetail,
  type IdeaNote,
  type IdeaQuery,
  type IdeaStatus,
  type IdeaView,
  type ManualIdea,
} from '../shared/trading-ideas'
import { errorMessage } from '../shared/model'
import { IdeaNotesForm, ManualIdeaForm } from './editors'
import { publicationLabel, timeLabel } from './presentation'
import { ChoicePicker, DatePicker, choices } from './pickers'
import './ideas.css'

const categoryChoices = [{ value: '', label: '全部类别' }, ...choices(categories)] as const
const topicChoices = [{ value: '', label: '全部主题' }, ...choices(topics)] as const

type ListResponse =
  | { query: IdeaQuery; items: Idea[]; hasMore: boolean; error?: never }
  | { query: IdeaQuery; items?: never; hasMore?: never; error: string }

export default function IdeasPage({ view, onBack }: { view: IdeaView; onBack: () => void }) {
  const api = window.workspace.tradingIdeas
  const { accountId } = view
  const [today, setToday] = useState(chinaDay)
  const [mode, setMode] = useState<IdeaQuery['mode']>('archive')
  const [day, setDay] = useState(() => chinaDay(Date.now() - 86400000))
  const [category, setCategory] = useState<IdeaQuery['category']>()
  const [topic, setTopic] = useState<IdeaQuery['topic']>()
  const [text, setText] = useState('')
  const [offset, setOffset] = useState(0)
  const queryDay = mode === 'collected' ? today : mode === 'published' ? day : undefined
  const query = useMemo<IdeaQuery>(
    () => ({
      mode,
      day: queryDay,
      category,
      topic,
      text,
      offset,
    }),
    [mode, queryDay, category, topic, text, offset],
  )
  const results = useRef<HTMLElement>(null)
  const [response, setResponse] = useState<ListResponse>()
  const result = response?.query === query ? response : undefined
  const [id, setId] = useState(view.itemId)
  const [detail, setDetail] = useState<IdeaDetail | null>(null)
  const [manual, setManual] = useState(false)
  const [status, setStatus] = useState<IdeaStatus>()
  const [showStatus, setShowStatus] = useState(false)
  const [revision, setRevision] = useState(0)
  const [detailError, setDetailError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    const unsubscribe = api.onChanged(() => setRevision((value) => value + 1))
    const timeout = setInterval(() => setToday(chinaDay()), 60000)
    return () => {
      unsubscribe()
      clearInterval(timeout)
    }
  }, [api])

  useLayoutEffect(() => {
    if (results.current) results.current.scrollTop = 0
  }, [query])

  useEffect(() => {
    let active = true
    void api.list(accountId, query).then(
      (next) => {
        if (active) setResponse({ query, ...next })
      },
      (reason) => {
        if (active) setResponse({ query, error: errorMessage(reason) })
      },
    )
    return () => {
      active = false
    }
  }, [api, accountId, query, revision])

  useEffect(() => {
    if (!id) return
    let active = true
    void api.detail(accountId, id).then(
      (item) => {
        if (active) {
          setDetail(item)
          setDetailError(item ? '' : '找不到该条灵感')
        }
      },
      (reason) => {
        if (active) setDetailError(errorMessage(reason))
      },
    )
    return () => {
      active = false
    }
  }, [api, accountId, id, revision])

  useEffect(() => {
    let active = true
    void api.status(accountId).then(
      (value) => {
        if (active) setStatus(value)
      },
      (reason) => {
        if (active) setStatusError(errorMessage(reason))
      },
    )
    return () => {
      active = false
    }
  }, [api, accountId, revision])

  function select(next: string) {
    setManual(false)
    if (next !== id) {
      setDetail(null)
      setDetailError('')
      setId(next)
    }
  }

  function resetList() {
    setOffset(0)
    setId(null)
    setDetail(null)
    setDetailError('')
  }

  function changeMode(next: IdeaQuery['mode']) {
    if (next !== mode) {
      setMode(next)
      resetList()
    }
  }

  async function refresh() {
    setRefreshing(true)
    setShowStatus(true)
    setStatusError('')
    try {
      await api.refresh(accountId)
    } catch (reason) {
      setStatusError(errorMessage(reason))
    } finally {
      setRefreshing(false)
    }
  }

  async function add(input: ManualIdea) {
    const next = await api.add(accountId, input)
    setOffset(0)
    setMode('collected')
    setCategory(undefined)
    setTopic(undefined)
    setText('')
    select(next)
  }

  const groups = new Map<string, Idea[]>()
  for (const item of result?.items ?? []) {
    const date = queryDay ?? chinaDay(item.firstSeen)
    const inDay = groups.get(date)
    if (inDay) inDay.push(item)
    else groups.set(date, [item])
  }

  return (
    <main className="ideas-page">
      <header className="ideas-page-header">
        <div className="ideas-page-title">
          <BookOpen size={22} aria-hidden="true" />
          <h1>交易灵感</h1>
          <button type="button" className="ideas-back" autoFocus onClick={onBack}>
            <ArrowLeft size={16} aria-hidden="true" /> 返回工作区
          </button>
        </div>
        <div className="ideas-actions">
          <button aria-expanded={showStatus} onClick={() => setShowStatus((value) => !value)}>
            采集状态
          </button>
          <button disabled={refreshing || status?.running} onClick={() => void refresh()}>
            <RefreshCw size={15} aria-hidden="true" />
            {status?.running || refreshing ? '正在采集' : '立即刷新'}
          </button>
          <button className="ideas-primary" onClick={() => setManual(true)}>
            <Plus size={16} aria-hidden="true" />
            手动收录
          </button>
        </div>
      </header>
      {showStatus && <SourcePanel status={status} error={statusError} />}
      <div className="ideas-columns">
        <aside className="ideas-sidebar">
          <div className="ideas-filters">
            <nav aria-label="资料视图">
              {(
                [
                  ['archive', '全部历史'],
                  ['collected', '今日新收录'],
                  ['pending', '待研究'],
                  ['published', '按日看'],
                ] as const
              ).map(([value, label]) => (
                <button key={value} aria-pressed={value === mode} onClick={() => changeMode(value)}>
                  {label}
                </button>
              ))}
            </nav>
            {mode === 'published' && (
              <DatePicker
                label="日报日期"
                value={day}
                onChange={(value) => {
                  if (value !== day) {
                    setDay(value)
                    resetList()
                  }
                }}
              />
            )}
            <div className="ideas-form-row">
              <ChoicePicker
                label="来源类别"
                value={category ?? ''}
                options={categoryChoices}
                onChange={(value) => {
                  if ((value || undefined) !== category) {
                    setCategory(value || undefined)
                    resetList()
                  }
                }}
              />
              <ChoicePicker
                label="主题"
                value={topic ?? ''}
                options={topicChoices}
                onChange={(value) => {
                  if ((value || undefined) !== topic) {
                    setTopic(value || undefined)
                    resetList()
                  }
                }}
              />
            </div>
            <input
              type="search"
              aria-label="搜索灵感"
              placeholder="搜索标题、摘要和笔记"
              value={text}
              maxLength={120}
              onChange={(event) => {
                setText(event.target.value)
                resetList()
              }}
            />
          </div>
          <section
            ref={results}
            className="ideas-results"
            aria-label="灵感列表"
            aria-busy={!result}
          >
            {result?.error && (
              <p className="ideas-error" role="alert">
                {result.error}
              </p>
            )}
            {Array.from(groups, ([date, items]) => (
              <section key={date}>
                <h3 className="ideas-date-divider">{date}</h3>
                {items.map((item) => (
                  <button
                    key={item.id}
                    className="ideas-list-item"
                    aria-current={id === item.id ? 'true' : undefined}
                    onClick={() => select(item.id)}
                  >
                    <strong>{item.title}</strong>
                    <small>
                      {item.category} · {item.author || '作者未注明'}
                      {item.personal.pending ? ' · 待研究' : ''}
                    </small>
                    {item.personal.priority !== '未标记' && (
                      <span>{item.personal.priority}优先级</span>
                    )}
                  </button>
                ))}
              </section>
            ))}
            {!groups.size && !result?.error && (
              <p className="ideas-message">
                {result ? '这个视图暂时没有条目。' : '正在读取历史资料…'}
              </p>
            )}
            {result?.items && (offset > 0 || result.hasMore) && (
              <div className="ideas-actions ideas-pages">
                <button disabled={!offset} onClick={() => setOffset(offset - IDEA_PAGE_SIZE)}>
                  上一页
                </button>
                <button
                  disabled={!result.hasMore}
                  onClick={() => setOffset(offset + IDEA_PAGE_SIZE)}
                >
                  下一页
                </button>
              </div>
            )}
          </section>
        </aside>
        <article className="ideas-article" aria-label="灵感详情">
          {manual ? (
            <ManualIdeaForm submit={add} cancel={() => setManual(false)} />
          ) : detail ? (
            <IdeaArticle
              key={detail.id}
              item={detail}
              select={select}
              save={(note) => api.saveNote(accountId, detail.id, note)}
              open={(index) =>
                api
                  .openSource(accountId, detail.id, index)
                  .catch((reason) => setDetailError(errorMessage(reason)))
              }
            />
          ) : (
            <p className="ideas-message">{id ? '正在读取条目…' : '从左侧选择一条灵感。'}</p>
          )}
          {detailError && (
            <p role="alert" className="ideas-error">
              {detailError}
            </p>
          )}
        </article>
      </div>
    </main>
  )
}

function SourcePanel({ status, error }: { status?: IdeaStatus; error: string }) {
  return (
    <section className="ideas-source-panel" aria-label="采集状态">
      <p>每日北京时间 06:00 采集 · 启动或唤醒时补抓</p>
      {error && (
        <p className="ideas-error" role="alert">
          {error}
        </p>
      )}
      {status?.backupIssue && (
        <p className="ideas-error" role="alert">
          {status.backupIssue}
        </p>
      )}
      {status && (
        <>
          <ul>
            {status.sources.map((source) => (
              <li key={source.id}>
                <strong>{source.label}</strong> · {source.outcome}
                {source.added > 0 ? ' ' + source.added + ' 条' : ''}
                {source.attemptedAt && <small>{timeLabel(source.attemptedAt)}</small>}
                {source.details && <small>{source.details}</small>}
              </li>
            ))}
          </ul>
          <details>
            <summary>最近采集记录</summary>
            <ul className="ideas-source-history">
              {status.history.map((record, index) => (
                <li key={record.id + index}>
                  {record.attemptedAt && timeLabel(record.attemptedAt)} · {record.label} ·{' '}
                  {record.outcome}
                  {record.added > 0 ? ' ' + record.added + ' 条' : ''}
                  {record.details ? ' · ' + record.details : ''}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  )
}

function IdeaArticle({
  item,
  select,
  save,
  open,
}: {
  item: IdeaDetail
  select: (id: string) => void
  save: (note: IdeaNote) => Promise<void>
  open: (index: number) => Promise<void>
}) {
  return (
    <>
      <p className="ideas-kicker">
        {[item.category, item.personal.evidence ?? item.evidence, item.market, item.screening]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <h2>{item.title}</h2>
      <dl className="ideas-metadata">
        <div>
          <dt>作者或机构</dt>
          <dd>{item.author || '未注明'}</dd>
        </div>
        <div>
          <dt>发布</dt>
          <dd>{publicationLabel(item)}</dd>
        </div>
        <div>
          <dt>首次收录</dt>
          <dd>{timeLabel(item.firstSeen)}</dd>
        </div>
        {item.eventDay && (
          <div>
            <dt>事件或数据日期</dt>
            <dd>{item.eventDay}</dd>
          </div>
        )}
      </dl>
      {item.summary && (
        <section className="ideas-summary">
          <h3>来源摘要</h3>
          <p>{item.summary}</p>
        </section>
      )}
      {item.topics.length > 0 && <p className="ideas-topics">{item.topics.join(' · ')}</p>}
      <div className="ideas-origins" aria-label="原文与发现入口">
        {item.origins.map((origin, index) => (
          <button key={origin.source + origin.url} onClick={() => void open(index)}>
            <ArrowUpRight size={14} aria-hidden="true" />
            {origin.url === item.url ? '原文' : '来源'} · {origin.source}
          </button>
        ))}
      </div>
      {item.related.length > 0 && (
        <section className="ideas-related">
          <h3>同一事件的其他资料</h3>
          {item.related.map((other) => (
            <button key={other.id} onClick={() => select(other.id)}>
              {other.category} · {other.title}
            </button>
          ))}
        </section>
      )}
      {(item.revisions.length > 0 || item.evidenceHistory.length > 0) && (
        <details className="ideas-revisions">
          <summary>查看更新与证据标记历史</summary>
          {item.revisions.map((revision, index) => (
            <div key={revision.capturedAt + ':' + index}>
              <small>{timeLabel(revision.capturedAt)}检测到新版本 · 以下为此前内容</small>
              <strong>{revision.content.title}</strong>
              <p>{revision.content.summary}</p>
            </div>
          ))}
          {item.evidenceHistory.map((change, index) => (
            <p key={change.capturedAt + ':' + index}>
              {timeLabel(change.capturedAt)} · {change.evidence ?? '恢复来源状态'}
            </p>
          ))}
        </details>
      )}
      <IdeaNotesForm item={item} save={save} />
    </>
  )
}
