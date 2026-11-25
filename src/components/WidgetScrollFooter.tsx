import type { ReactNode } from 'react'

export function formatWidgetUpdateTime(timestamp: number) {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(timestamp)
}

export function WidgetScrollFooter({
  updatedAt,
  stale,
  fallback,
  className,
  children,
}: {
  updatedAt?: number | null
  stale?: boolean
  fallback: ReactNode
  className?: string
  children?: ReactNode
}) {
  return (
    <footer className={`widget-scroll-footer${className ? ` ${className}` : ''}`}>
      <span className="widget-scroll-footer-status">
        {updatedAt != null
          ? `${stale ? '上次更新' : '更新于'} ${formatWidgetUpdateTime(updatedAt)}`
          : fallback}
      </span>
      {children && <div className="widget-scroll-footer-actions">{children}</div>}
    </footer>
  )
}
