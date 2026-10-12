import type { ReactNode } from "react"
import { useContext, useRef } from "react"
import { GAppShellRightPanelContext } from "./GAppShell"

type GPanelCloseProps =
  | { onClose: () => void; closeLabel: string }
  | { onClose?: undefined; closeLabel?: string }

export type GPanelProps = {
  title: ReactNode
  children: ReactNode
  className?: string
} & GPanelCloseProps

export function GPanel({ title, children, onClose, closeLabel, className }: GPanelProps) {
  const panelRef = useRef<HTMLElement>(null)
  const requestShellPanelChange = useContext(GAppShellRightPanelContext)
  const showCloseAction = Boolean(closeLabel && (onClose || requestShellPanelChange))

  const close = () => {
    const panel = panelRef.current?.closest('.g-app-shell__right-panel')
    const opener = panel?.id
      ? Array.from(document.querySelectorAll<HTMLElement>('[aria-controls]')).find((element) => element.getAttribute('aria-controls')?.split(/\s+/).includes(panel.id) && element.getClientRects().length > 0)
      : undefined
    onClose?.()
    requestShellPanelChange?.(false)
    if (opener) requestAnimationFrame(() => { if (opener.isConnected) opener.focus() })
  }

  return (
    <section ref={panelRef} className={["g-panel", className].filter(Boolean).join(" ")}>
      <header className="g-panel__header">
        <h2 className="g-panel__title">{title}</h2>
        {showCloseAction && (
          <button
            className="g-panel__close"
            type="button"
            aria-label={closeLabel}
            onClick={close}
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" fill="none">
              <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </header>
      <div className="g-panel__body">{children}</div>
    </section>
  )
}
