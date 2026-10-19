import * as React from "react"
import { AlertTriangle, CheckCircle2, X, XCircle } from "lucide-react"

import { cn } from "../../lib/utils"
import { Button } from "./button"

/**
 * Garden Toast — Codex 피드백 채널 계약(docs/EXPERIENCE.md §5):
 * 되돌릴 수 있는 변경은 확인 다이얼로그 대신 "실행 + undo 토스트".
 * variant success|warning|danger, action(되돌리기 등) 1개, auto-dismiss 5s.
 * 라이브 리전: role="status" + aria-live="polite".
 */
type ToastVariant = "success" | "warning" | "danger"

interface ToastAction {
  label: string
  onClick: () => void
}

interface ToastOptions {
  description?: string
  action?: ToastAction
  /** ms. 0이면 수동 닫기만. 기본 5000. */
  duration?: number
}

interface ToastItem extends ToastOptions {
  id: number
  variant: ToastVariant
  title: string
  closing?: boolean
}

export interface ToastApi {
  success: (title: string, options?: ToastOptions) => void
  warning: (title: string, options?: ToastOptions) => void
  danger: (title: string, options?: ToastOptions) => void
}

const ToastContext = React.createContext<ToastApi | null>(null)

export interface ToastProviderProps {
  children: React.ReactNode
  closeLabel: string
  regionLabel: string
}

const VARIANT_ICON: Record<ToastVariant, typeof CheckCircle2> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
}

const VARIANT_ICON_CLASS: Record<ToastVariant, string> = {
  success: "text-green",
  warning: "text-orange",
  danger: "text-red",
}

export function ToastProvider({ children, closeLabel, regionLabel }: ToastProviderProps) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([])
  const idRef = React.useRef(0)
  const removalTimersRef = React.useRef(new Map<number, number>())
  const closingIdsRef = React.useRef(new Set<number>())

  const dismiss = React.useCallback((id: number) => {
    if (closingIdsRef.current.has(id)) return
    closingIdsRef.current.add(id)
    // exit: fade-in 100ms reverse 재생 후 제거 (garden.css 키프레임)
    setToasts((list) =>
      list.map((t) => (t.id === id ? { ...t, closing: true } : t))
    )
    const timeout = window.setTimeout(() => {
      removalTimersRef.current.delete(id)
      closingIdsRef.current.delete(id)
      setToasts((list) => list.filter((t) => t.id !== id))
    }, 100)
    removalTimersRef.current.set(id, timeout)
  }, [])

  React.useEffect(() => () => {
    removalTimersRef.current.forEach((timeout) => window.clearTimeout(timeout))
    removalTimersRef.current.clear()
    closingIdsRef.current.clear()
  }, [])

  const push = React.useCallback(
    (variant: ToastVariant) => (title: string, options?: ToastOptions) => {
      const id = ++idRef.current
      setToasts((list) => [
        ...list.slice(-2),
        { id, variant, title, ...options },
      ])
    },
    [dismiss]
  )

  const api = React.useMemo<ToastApi>(
    () => ({
      success: push("success"),
      warning: push("warning"),
      danger: push("danger"),
    }),
    [push]
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="region"
        aria-label={regionLabel}
        className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2"
      >
        {toasts.map((toast) => (
          <ToastPlate
            key={toast.id}
            toast={toast}
            duration={toast.duration ?? 5000}
            onDismiss={() => dismiss(toast.id)}
            closeLabel={closeLabel}
          />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastPlate({
  toast,
  duration,
  onDismiss,
  closeLabel,
}: {
  toast: ToastItem
  duration: number
  onDismiss: () => void
  closeLabel: string
}) {
  const Icon = VARIANT_ICON[toast.variant]
  const timeoutRef = React.useRef<number | null>(null)
  const startedAtRef = React.useRef<number | null>(null)
  const remainingRef = React.useRef(duration)
  const pointerInsideRef = React.useRef(false)
  const focusWithinRef = React.useRef(false)
  const dismissedRef = React.useRef(false)
  const onDismissRef = React.useRef(onDismiss)
  onDismissRef.current = onDismiss

  const pauseTimeout = React.useCallback(() => {
    if (timeoutRef.current === null || startedAtRef.current === null) return
    window.clearTimeout(timeoutRef.current)
    remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current))
    timeoutRef.current = null
    startedAtRef.current = null
  }, [])

  const resumeTimeout = React.useCallback(() => {
    if (
      duration <= 0 ||
      timeoutRef.current !== null ||
      dismissedRef.current ||
      toast.closing ||
      pointerInsideRef.current ||
      focusWithinRef.current
    ) return
    if (remainingRef.current <= 0) {
      dismissedRef.current = true
      onDismissRef.current()
      return
    }
    startedAtRef.current = Date.now()
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null
      startedAtRef.current = null
      remainingRef.current = 0
      dismissedRef.current = true
      onDismissRef.current()
    }, remainingRef.current)
  }, [duration, toast.closing])

  React.useEffect(() => {
    if (toast.closing) {
      dismissedRef.current = true
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
      startedAtRef.current = null
    }
  }, [toast.closing])

  React.useEffect(() => {
    resumeTimeout()
    return () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
      startedAtRef.current = null
    }
  }, [resumeTimeout])

  const onPointerEnter = () => {
    pointerInsideRef.current = true
    pauseTimeout()
  }
  const onPointerLeave = () => {
    pointerInsideRef.current = false
    if (!focusWithinRef.current) resumeTimeout()
  }
  const onFocusCapture = () => {
    focusWithinRef.current = true
    pauseTimeout()
  }
  const onBlurCapture = (event: React.FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    focusWithinRef.current = false
    if (!pointerInsideRef.current) resumeTimeout()
  }

  return (
    <div
      role="status"
      data-slot="toast"
      data-state={toast.closing ? "closed" : "open"}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
      className={cn(
        "bg-surface text-ui text-ink data-[state=open]:animate-[pop-in_150ms_var(--ease-enter)] data-[state=closed]:animate-[fade-in_100ms_ease-in_reverse] grid w-80 max-w-[calc(100vw-2rem)] grid-cols-[var(--g-space-4)_minmax(0,1fr)_var(--g-control-height)] items-start gap-x-3 gap-y-2 rounded-card border border-line p-4 shadow-overlay"
      )}
    >
      <Icon
        aria-hidden
        className={cn("mt-1.5 size-4 shrink-0", VARIANT_ICON_CLASS[toast.variant])}
      />
      <div className="flex min-h-7 min-w-0 flex-col justify-center gap-1 [overflow-wrap:anywhere]">
        <span className="text-ui font-medium text-ink">{toast.title}</span>
        {toast.description && (
          <span className="text-caption text-ink-2">{toast.description}</span>
        )}
      </div>
      {toast.action && (
        <Button
          variant="ghost"
          size="sm"
          className="col-start-2 row-start-2 -ml-2 h-auto min-h-7 max-w-full justify-self-start whitespace-normal text-left [overflow-wrap:anywhere] text-accent-ink hover:text-accent-ink"
          type="button"
          onClick={() => {
            toast.action?.onClick()
            onDismiss()
          }}
        >
          {toast.action.label}
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={closeLabel}
        onClick={onDismiss}
        className="col-start-3 row-start-1 text-ink-2"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
}

export function useToast(): ToastApi {
  const ctx = React.useContext(ToastContext)
  if (!ctx) throw new Error("useToast는 ToastProvider 안에서 사용하세요")
  return ctx
}
