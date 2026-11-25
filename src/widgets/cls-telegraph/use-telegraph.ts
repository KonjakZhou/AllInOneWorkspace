import { useCallback, useEffect, useRef, useState } from 'react'
import type { TelegraphFeed } from '../../shared/telegraph'
import { errorMessage } from '../../shared/model'

export function useTelegraph(signal: AbortSignal) {
  const root = useRef<HTMLDivElement>(null)
  const [feed, setFeed] = useState<TelegraphFeed | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [idle, setIdle] = useState(false)
  const [visible, setVisible] = useState(document.visibilityState === 'visible')
  const refreshRef = useRef<(force?: boolean) => Promise<TelegraphFeed | undefined>>(
    async () => undefined,
  )
  const refresh = useCallback((force = true) => refreshRef.current(force), [])

  useEffect(() => {
    let alive = true
    let sequence = 0
    let visible = true
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const api = window.workspace.telegraph
    const isVisible = () => visible && document.visibilityState === 'visible'
    const read = async (force = false) => {
      const current = ++sequence
      if (!alive || signal.aborted) return
      setLoading(true)
      try {
        const result = await api.getFeed(force)
        if (alive && !signal.aborted && current === sequence) {
          setFeed((previous) =>
            previous && previous.revision > result.revision ? previous : result,
          )
          setError('')
        }
        if (alive && !signal.aborted && isVisible()) return result
      } catch (reason) {
        if (alive && !signal.aborted && current === sequence) setError(errorMessage(reason))
      } finally {
        if (alive && !signal.aborted && current === sequence) setLoading(false)
      }
    }
    refreshRef.current = read
    const focus = () => {
      if (isVisible()) void read()
    }
    const visibilityChanged = () => {
      clearTimeout(idleTimer)
      const shown = isVisible()
      setVisible(shown)
      if (shown) {
        setIdle(false)
        void read()
      } else {
        idleTimer = setTimeout(
          () => {
            sequence++
            setFeed(null)
            setError('')
            setIdle(true)
          },
          15 * 60 * 1000,
        )
      }
    }
    visibilityChanged()
    const off = api.onChanged(focus)
    const observer = new IntersectionObserver((entries) => {
      const wasVisible = visible
      visible = entries[0]?.isIntersecting ?? false
      if (wasVisible !== visible) visibilityChanged()
    })
    if (root.current) observer.observe(root.current)
    const poll = setInterval(() => {
      if (isVisible()) void read()
    }, 30000)
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      alive = false
      sequence++
      off()
      observer.disconnect()
      clearTimeout(idleTimer)
      clearInterval(poll)
      window.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [signal])

  return { root, feed, error, loading, refresh, idle, visible }
}
