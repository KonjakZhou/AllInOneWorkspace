import { Component, type ReactNode } from 'react'
import { AlertCircle, LoaderCircle, PackageOpen, RotateCcw } from 'lucide-react'

export function WidgetLoading({ message = '正在加载…' }: { message?: string }) {
  return (
    <div className="widget-state">
      <LoaderCircle className="spin" size={24} />
      <p>{message}</p>
    </div>
  )
}
export function WidgetEmpty({
  message = '还没有内容',
  children,
}: {
  message?: string
  children?: ReactNode
}) {
  return (
    <div className="widget-state">
      <PackageOpen size={26} />
      <p>{message}</p>
      {children}
    </div>
  )
}
export function WidgetError({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="widget-state error-state" role="alert">
      <AlertCircle size={24} />
      <strong>组件暂时不可用</strong>
      <p>{message}</p>
      {retry && (
        <button className="button small" onClick={retry}>
          <RotateCcw size={14} />
          重试
        </button>
      )}
    </div>
  )
}
export class WidgetErrorBoundary extends Component<
  { children: ReactNode },
  { error: string | null; attempt: number }
> {
  state = { error: null as string | null, attempt: 0 }
  static getDerivedStateFromError(error: Error) {
    return { error: error.message }
  }
  render() {
    if (this.state.error)
      return (
        <WidgetError
          message={this.state.error}
          retry={() => this.setState((state) => ({ error: null, attempt: state.attempt + 1 }))}
        />
      )
    return (
      <div className="widget-boundary" key={this.state.attempt}>
        {this.props.children}
      </div>
    )
  }
}
