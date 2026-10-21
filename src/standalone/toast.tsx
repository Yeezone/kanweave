/**
 * Toast notifications plus the two shared overlay shells (right drawer and
 * centred modal/confirm dialog). Keeping them together avoids a dependency
 * cycle: every view imports toasts, and confirmations need an overlay.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconAlert, IconCheck, IconClose, IconInbox } from './icons.tsx'
import { useI18n } from './locales.ts'

export type ToastKind = 'info' | 'success' | 'error'

export interface ToastInput {
  message: string
  kind?: ToastKind
}

interface ToastItem {
  id: number
  message: string
  kind: ToastKind
}

/** `notify('saved')` or `notify({ message, kind: 'error' })`. */
export type Notify = (input: string | ToastInput) => void

const ToastContext = createContext<Notify | null>(null)

export function useToast(): Notify {
  const notify = useContext(ToastContext)
  if (!notify) throw new Error('useToast must be used inside <ToastProvider>')
  return notify
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(0)
  const timers = useRef(new Map<number, number>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const notify = useCallback<Notify>(
    (input) => {
      const kind: ToastKind = typeof input === 'string' ? 'info' : input.kind ?? 'info'
      const message = typeof input === 'string' ? input : input.message
      if (!message) return
      nextId.current += 1
      const id = nextId.current
      setToasts((current) => [...current.slice(-3), { id, message, kind }])
      const lifetime = kind === 'error' ? 6000 : 3600
      const timer = window.setTimeout(() => {
        timers.current.delete(id)
        setToasts((current) => current.filter((toast) => toast.id !== id))
      }, lifetime)
      timers.current.set(id, timer)
    },
    [],
  )

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer)
      pending.clear()
    }
  }, [])

  const value = useMemo(() => notify, [notify])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="kw-toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`kw-toast kw-toast-${toast.kind}`}>
            <span className="kw-toast-icon" aria-hidden="true">
              {toast.kind === 'success' ? <IconCheck /> : toast.kind === 'error' ? <IconAlert /> : <IconInbox />}
            </span>
            <span className="kw-toast-message">{toast.message}</span>
            <button
              type="button"
              className="kw-icon-button kw-toast-close"
              aria-label={t('common.dismiss')}
              onClick={() => dismiss(toast.id)}
            >
              <IconClose size={12} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

/* ------------------------------------------------------------------ *
 * Overlay helpers
 * ------------------------------------------------------------------ */

/**
 * Only the topmost overlay reacts to Escape. The stack is module level
 * because overlays are rendered in different places of the tree.
 */
const overlayStack: symbol[] = []

function useEscapeClose(onClose: () => void): void {
  const idRef = useRef<symbol | null>(null)
  if (idRef.current === null) idRef.current = Symbol('overlay')
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const id = idRef.current
    if (!id) return
    overlayStack.push(id)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (overlayStack[overlayStack.length - 1] !== id) return
      event.preventDefault()
      closeRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      const index = overlayStack.lastIndexOf(id)
      if (index >= 0) overlayStack.splice(index, 1)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])
}

function stopPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation()
}

export interface DrawerProps {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** Extra class on the panel, e.g. `kw-drawer-wide`. */
  className?: string
}

/** Right-side drawer with a scrim; closes on Escape and on scrim click. */
export function Drawer({ title, subtitle, onClose, children, footer, className }: DrawerProps) {
  const { t } = useI18n()
  useEscapeClose(onClose)
  const titleId = useId()
  return (
    <div className="kw-scrim kw-scrim-right" onMouseDown={onClose} role="presentation">
      <aside
        className={`kw-drawer${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={stopPropagation}
      >
        <header className="kw-drawer-header">
          <div className="kw-drawer-heading">
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <p className="kw-muted kw-drawer-subtitle">{subtitle}</p> : null}
          </div>
          <button type="button" className="kw-icon-button" aria-label={t('common.close')} onClick={onClose}>
            <IconClose />
          </button>
        </header>
        <div className="kw-drawer-body">{children}</div>
        {footer ? <footer className="kw-drawer-footer">{footer}</footer> : null}
      </aside>
    </div>
  )
}

export interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  className?: string
}

/** Centred modal dialog with a scrim. */
export function Modal({ title, onClose, children, footer, className }: ModalProps) {
  const { t } = useI18n()
  useEscapeClose(onClose)
  const titleId = useId()
  return (
    <div className="kw-scrim" onMouseDown={onClose} role="presentation">
      <div
        className={`kw-modal${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={stopPropagation}
      >
        <header className="kw-modal-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="kw-icon-button" aria-label={t('common.close')} onClick={onClose}>
            <IconClose />
          </button>
        </header>
        <div className="kw-modal-body">{children}</div>
        {footer ? <footer className="kw-modal-footer">{footer}</footer> : null}
      </div>
    </div>
  )
}

export interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  /** Render the confirm button in the danger style. */
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      className="kw-modal-small"
      footer={
        <>
          <button type="button" className="kw-button" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`kw-button${danger ? ' kw-button-danger' : ' kw-button-primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="kw-confirm-message">{message}</p>
    </Modal>
  )
}
