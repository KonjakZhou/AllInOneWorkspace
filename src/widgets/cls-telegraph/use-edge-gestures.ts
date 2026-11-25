import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

const TRIGGER = 56
const MAX_PULL = 78
const WHEEL_IDLE = 150

export function useEdgeGestures(
  list: RefObject<HTMLDivElement | null>,
  edges: { refresh: () => Promise<void>; older: () => void; newer?: () => void },
) {
  const actions = useRef(edges)
  useLayoutEffect(() => {
    actions.current = edges
  }, [edges])
  const [pull, setPull] = useState({ height: 0, phase: 'idle' })

  useEffect(() => {
    const element = list.current
    if (!element) return
    let active = true
    let distance = 0
    let refreshing = false
    let touchY: number | undefined
    let loadedFromWheel = false
    let loadedFromTouch = false
    let historyWheel = false
    let historyTouch = false
    let newerFromWheel = false
    let newerFromTouch = false
    let wheelEnd: ReturnType<typeof setTimeout> | undefined
    let settle: ReturnType<typeof setTimeout> | undefined

    const top = () => element.scrollTop <= 1
    const bottom = () => element.scrollHeight - element.clientHeight - element.scrollTop <= 2
    const height = () => Math.min(MAX_PULL, distance * 0.55)
    const drag = (delta: number) => {
      distance = Math.max(0, Math.min(MAX_PULL / 0.55, distance + delta))
      setPull({ height: height(), phase: distance ? 'dragging' : 'idle' })
    }
    const release = (cancelled = false) => {
      const armed = height() >= TRIGGER
      distance = 0
      if (refreshing) return
      if (cancelled || !armed) {
        setPull({ height: 0, phase: 'idle' })
        return
      }
      refreshing = true
      setPull({ height: 42, phase: 'refreshing' })
      const started = performance.now()
      void actions.current.refresh().finally(() => {
        if (!active) return
        settle = setTimeout(
          () => {
            refreshing = false
            setPull({ height: 0, phase: 'idle' })
          },
          Math.max(0, 350 - (performance.now() - started)),
        )
      })
    }

    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || !event.deltaY) return
      if (event.deltaY < 0 && actions.current.newer) historyWheel = true
      if (!top()) newerFromWheel = false
      clearTimeout(wheelEnd)
      wheelEnd = setTimeout(() => {
        loadedFromWheel = false
        newerFromWheel = false
        release(historyWheel)
        historyWheel = false
      }, WHEEL_IDLE)
      if (top() && event.deltaY < 0 && historyWheel) {
        event.preventDefault()
        if (!newerFromWheel) actions.current.newer?.()
        newerFromWheel = true
        return
      }
      if (top() && (event.deltaY < 0 || distance > 0)) {
        event.preventDefault()
        const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1
        if (!refreshing) drag(-event.deltaY * scale)
      } else if (event.deltaY > 0 && bottom() && !loadedFromWheel) {
        loadedFromWheel = true
        actions.current.older()
      }
    }
    const startTouch = (event: TouchEvent) => {
      touchY = event.touches.length === 1 ? event.touches[0]?.clientY : undefined
      loadedFromTouch = false
      historyTouch = false
      newerFromTouch = false
    }
    const moveTouch = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY
      if (touchY === undefined || next === undefined || event.touches.length !== 1) {
        touchY = undefined
        if (distance) release(true)
        return
      }
      const delta = next - touchY
      touchY = next
      if (delta > 0 && actions.current.newer) historyTouch = true
      if (!top()) newerFromTouch = false
      if (top() && delta > 0 && historyTouch) {
        if (event.cancelable) event.preventDefault()
        if (!newerFromTouch) actions.current.newer?.()
        newerFromTouch = true
        return
      }
      if (top() && (delta > 0 || distance > 0)) {
        if (event.cancelable) event.preventDefault()
        if (!refreshing) drag(delta)
      } else if (delta < 0 && bottom() && !loadedFromTouch) {
        loadedFromTouch = true
        actions.current.older()
      }
    }
    const endTouch = () => {
      touchY = undefined
      if (distance) release(historyTouch)
    }
    const cancelTouch = () => {
      touchY = undefined
      if (distance) release(true)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    element.addEventListener('touchstart', startTouch, { passive: true })
    element.addEventListener('touchmove', moveTouch, { passive: false })
    element.addEventListener('touchend', endTouch)
    element.addEventListener('touchcancel', cancelTouch)
    return () => {
      active = false
      clearTimeout(wheelEnd)
      clearTimeout(settle)
      element.removeEventListener('wheel', wheel)
      element.removeEventListener('touchstart', startTouch)
      element.removeEventListener('touchmove', moveTouch)
      element.removeEventListener('touchend', endTouch)
      element.removeEventListener('touchcancel', cancelTouch)
    }
  }, [list])

  return { ...pull, armed: pull.phase === 'dragging' && pull.height >= TRIGGER }
}
