import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  locked = false,
}: {
  title: string
  subtitle?: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
  locked?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current!
    const previous = document.activeElement as HTMLElement | null
    const restoreFocusVisible =
      document.documentElement.dataset.inputMethod !== 'pointer' &&
      (previous?.matches(':focus-visible') ?? false)
    dialog.showModal()
    return () => {
      dialog.close()
      if (previous?.isConnected) {
        // Native close can restore a keyboard ring after Esc even for a mouse-opened dialog.
        // focusVisible only takes effect when focus actually moves to the element.
        if (
          document.activeElement === previous &&
          previous.matches(':focus-visible') !== restoreFocusVisible
        )
          previous.blur()
        previous.focus({ preventScroll: true, focusVisible: restoreFocusVisible })
      }
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'modal-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        if (!locked) onClose()
      }}
      onClick={(event) => {
        if (event.target === ref.current && !locked) {
          const rect = ref.current.getBoundingClientRect()
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose()
        }
      }}
    >
      <header className="modal-header">
        <div>
          <h2 id={titleId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon-button" aria-label="关闭对话框" onClick={onClose} disabled={locked}>
          <X size={20} />
        </button>
      </header>
      <div className="modal-content">{children}</div>
    </dialog>
  )
}
