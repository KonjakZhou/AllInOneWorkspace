import { useContext, useEffect, useMemo, useState } from 'react'
import { ChevronRight, Lightbulb } from 'lucide-react'
import { z } from 'zod'
import { defineWidget } from '../../sdk/types'
import { WidgetScrollFooter } from '../../components/WidgetScrollFooter'
import { chinaDay, type IdeaOverview } from '../../shared/trading-ideas'
import { errorMessage } from '../../shared/model'
import { OpenIdeasPage } from '../../trading-ideas/navigation'
import { publicationLabel } from '../../trading-ideas/presentation'
import '../../trading-ideas/ideas.css'

export default defineWidget({
  type: 'trading-ideas',
  name: '交易灵感',
  description: '浏览 A 股和国内 ETF 的交易策略与研究灵感。',
  version: 1,
  icon: 'news',
  accent: 'sage',
  chrome: 'compact',
  defaultSize: { w: 5, h: 7 },
  minSize: { w: 3, h: 5 },
  defaultConfig: {},
  defaultData: null,
  configSchema: z.object({}),
  dataSchema: z.null(),
  Component: TradingIdeasCard,
})

function TradingIdeasCard({ accountId, signal }: { accountId: string; signal: AbortSignal }) {
  const open = useContext(OpenIdeasPage)
  const [overview, setOverview] = useState<IdeaOverview>()
  const [error, setError] = useState('')
  const [today, setToday] = useState(chinaDay)
  const count = useMemo(() => {
    if (!overview || overview.today === today) return overview?.count
    return overview.items.filter((item) => chinaDay(item.firstSeen) === today).length
  }, [overview, today])

  useEffect(() => {
    const api = window.workspace.tradingIdeas
    let current = 0
    let disposed = false
    const read = async () => {
      const sequence = ++current
      try {
        const next = await api.overview(accountId)
        if (!disposed && !signal.aborted && sequence === current) {
          setOverview(next)
          setError('')
        }
      } catch (reason) {
        if (!disposed && !signal.aborted && sequence === current) setError(errorMessage(reason))
      }
    }
    const stop = api.onChanged(() => void read())
    const refreshDay = setInterval(() => setToday(chinaDay()), 60000)
    void read()
    void api.enable(accountId).catch((reason) => {
      if (!disposed && !signal.aborted) setError(errorMessage(reason))
    })
    return () => {
      disposed = true
      stop()
      clearInterval(refreshDay)
    }
  }, [accountId, signal])

  return (
    <section className="ideas-card">
      <header>
        <h2>
          <Lightbulb size={17} aria-hidden="true" />
          交易灵感
        </h2>
        {count !== undefined && <span>今日新收录 {count} 条</span>}
      </header>
      <div className="ideas-card-list" role="region" aria-label="交易灵感列表" tabIndex={0}>
        {!overview && !error && <p>正在读取交易灵感…</p>}
        {overview?.items.length === 0 && <p>采集到的灵感会出现在这里。</p>}
        {overview?.items.map((item) => (
          <button
            key={item.id}
            onClick={(event) => open({ accountId, itemId: item.id }, event.currentTarget)}
          >
            <strong>{item.title}</strong>
            <small>
              {item.category} · {publicationLabel(item)}
              {chinaDay(item.firstSeen) === today ? ' · 新收录' : ''}
              {item.priority !== '未标记' ? ' · ' + item.priority + '优先级' : ''}
            </small>
          </button>
        ))}
      </div>
      {error && (
        <p className="ideas-error" role="alert">
          {error}
        </p>
      )}
      <WidgetScrollFooter
        className="ideas-card-footer"
        updatedAt={overview?.updatedAt}
        fallback="等待首次采集"
      >
        <button onClick={(event) => open({ accountId, itemId: null }, event.currentTarget)}>
          查看全部 <ChevronRight size={14} aria-hidden="true" />
        </button>
      </WidgetScrollFooter>
    </section>
  )
}
