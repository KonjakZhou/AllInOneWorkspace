import { useCallback, useEffect, useRef, useState } from 'react'
import { dateKey, type CalendarAgenda } from '../../shared/feishu'
import { errorMessage } from '../../shared/model'

export function useAgenda(accountId: string, signal: AbortSignal) {
  const root = useRef<HTMLDivElement>(null)
  const [agenda, setAgenda] = useState<CalendarAgenda | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => new Date())
  const refreshRef = useRef<(force?: boolean) => Promise<void>>(async () => {})
  const refresh = useCallback((force = true) => refreshRef.current(force), [])
  useEffect(() => {
    let alive = true,
      sequence = 0,
      visible = true
    let lastDay = dateKey(new Date()),
      lastOffset = new Date().getTimezoneOffset()
    const api = window.workspace.feishu
    const read = async (force = false) => {
      const current = ++sequence
      if (!alive || signal.aborted) return
      setLoading(true)
      try {
        const result = await api.getAgenda(accountId, force)
        if (alive && !signal.aborted && current === sequence && result.accountId === accountId) {
          setAgenda((previous) =>
            previous && previous.revision > result.revision ? previous : result,
          )
          setError('')
        }
      } catch (err) {
        if (alive && !signal.aborted && current === sequence) setError(errorMessage(err))
      } finally {
        if (alive && !signal.aborted && current === sequence) setLoading(false)
      }
    }
    refreshRef.current = read
    void read()
    const off = api.onChanged(accountId, () => void read())
    const isVisible = () => visible && document.visibilityState === 'visible'
    const focus = () => {
      if (isVisible()) void read()
    }
    const observer = new IntersectionObserver((entries) => {
      const wasVisible = visible
      visible = entries[0]?.isIntersecting ?? false
      if (!wasVisible && isVisible()) void read()
    })
    if (root.current) observer.observe(root.current)
    const poll = setInterval(() => {
      if (isVisible()) void read()
    }, 300000)
    // Also updates ongoing/NEXT markers and catches local midnight, DST and timezone changes.
    const tick = setInterval(() => {
      const time = new Date()
      setNow(time)
      const day = dateKey(time),
        offset = time.getTimezoneOffset()
      if (day !== lastDay || offset !== lastOffset) {
        lastDay = day
        lastOffset = offset
        if (isVisible()) void read(true)
      }
    }, 15000)
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', focus)
    return () => {
      alive = false
      sequence++
      off()
      observer.disconnect()
      clearInterval(poll)
      clearInterval(tick)
      window.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', focus)
    }
  }, [accountId, signal])
  return { root, agenda, error, loading, now, refresh }
}
