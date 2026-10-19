import type { CSSProperties, FocusEvent, ReactNode } from "react"
import { createContext, useEffect, useId, useRef, useState } from "react"
import { PanelLeft, PanelRight, Search } from "lucide-react"
import { GCommandPalette } from "./GCommandPalette"
import type { GCommandItem, GCommandPaletteStrings } from "./GCommandPalette"
import { GTitleBar } from "./GTitleBar"
import type { GTitleBarProps } from "./GTitleBar"

export interface GAppShellStrings {
  mainLabel: string
  sidebarLabel: string
  sidebarToggleLabel: string
  rightPanelLabel: string
  rightPanelToggleLabel: string
  bottomPanelLabel: string
  composerLabel: string
  commandPalette: GCommandPaletteStrings
}

export interface GAppShellProps {
  /** Accessible identity for the native window and titlebar landmark. Never rendered as visible chrome. */
  appName: string
  /** Additional controls for the standard toolbar, or the complete toolbar in custom mode. */
  titleBar?: Omit<GTitleBarProps, "left" | "center" | "right"> & {
    left?: ReactNode
    center?: ReactNode
    right?: ReactNode
  }
  /** The standard shell toolbar is the default. Custom mode is an explicit layout escape hatch. */
  titleBarMode?: "standard" | "custom"
  /** Primary major-workspace navigation; independent of the contextual sidebar. */
  activityRail?: ReactNode
  sidebarOpen?: boolean
  onSidebarOpenChange?: (open: boolean) => void
  rightPanelPresentation?: "docked" | "inset"
  /** Contextual destinations for the selected workspace; controlled by the left pane toggle. */
  sidebar?: ReactNode
  children: ReactNode
  rightPanel?: ReactNode
  rightPanelOpen?: boolean
  onRightPanelOpenChange?: (open: boolean) => void
  rightPanelId?: string
  bottomPanel?: ReactNode
  composer?: ReactNode
  contentPadding?: "default" | "none"
  /** Let a full-height layout such as GConversation own its scrolling. */
  contentLayout?: "scroll" | "fill"
  commandItems?: GCommandItem[]
  commandPaletteOpen?: boolean
  onCommandPaletteOpenChange?: (open: boolean) => void
  strings: GAppShellStrings
  className?: string
}

/**
 * GPanel uses this context so its close action can close the shell's optional
 * right panel. A standalone GPanel remains independent of GAppShell.
 */
export const GAppShellRightPanelContext = createContext<((open: boolean) => void) | null>(null)

export function GAppShell({
  appName,
  titleBar,
  titleBarMode = "standard",
  sidebar,
  activityRail,
  sidebarOpen: controlledSidebarOpen,
  onSidebarOpenChange,
  rightPanelPresentation = "docked",
  children,
  rightPanel,
  rightPanelOpen,
  onRightPanelOpenChange,
  rightPanelId,
  bottomPanel,
  composer,
  contentPadding = "default",
  contentLayout = "scroll",
  commandItems = [],
  commandPaletteOpen: controlledPaletteOpen,
  onCommandPaletteOpenChange,
  strings,
  className,
}: GAppShellProps) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [uncontrolledSidebarOpen, setUncontrolledSidebarOpen] = useState(() =>
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? true
      : !window.matchMedia("(max-width: 760px)").matches,
  )
  const [uncontrolledRightPanelOpen, setUncontrolledRightPanelOpen] = useState(true)
  const sidebarToggleRef = useRef<HTMLButtonElement>(null)
  const rightPanelToggleRef = useRef<HTMLButtonElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const rightPanelRef = useRef<HTMLElement>(null)
  const focusedPaneRef = useRef<"sidebar" | "rightPanel" | null>(null)
  const sidebarId = useId()
  const generatedRightPanelId = useId()
  const hasRightPanel = Boolean(rightPanel)
  const isSidebarOpen = controlledSidebarOpen ?? uncontrolledSidebarOpen
  const isRightPanelOpen = hasRightPanel && (rightPanelOpen ?? uncontrolledRightPanelOpen)
  const isPaletteOpen = controlledPaletteOpen ?? paletteOpen
  const resolvedRightPanelId = rightPanelId ?? generatedRightPanelId

  const previousSidebarOpenRef = useRef(isSidebarOpen)
  const previousRightPanelOpenRef = useRef(isRightPanelOpen)
  useEffect(() => {
    const wasOpen = previousSidebarOpenRef.current
    previousSidebarOpenRef.current = isSidebarOpen
    if (!wasOpen || isSidebarOpen || focusedPaneRef.current !== "sidebar") return
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active === document.body || sidebarRef.current?.contains(active)) sidebarToggleRef.current?.focus()
    })
  }, [isSidebarOpen])
  useEffect(() => {
    const wasOpen = previousRightPanelOpenRef.current
    previousRightPanelOpenRef.current = isRightPanelOpen
    if (!wasOpen || isRightPanelOpen || focusedPaneRef.current !== "rightPanel") return
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active === document.body || rightPanelRef.current?.contains(active)) rightPanelToggleRef.current?.focus()
    })
  }, [isRightPanelOpen])

  const trackFocusedPane = (event: FocusEvent<HTMLDivElement>) => {
    if (sidebarRef.current?.contains(event.target as Node)) focusedPaneRef.current = "sidebar"
    else if (rightPanelRef.current?.contains(event.target as Node)) focusedPaneRef.current = "rightPanel"
    else focusedPaneRef.current = null
  }

  const requestRightPanelOpenChange = (open: boolean) => {
    if (rightPanelOpen === undefined) setUncontrolledRightPanelOpen(open)
    onRightPanelOpenChange?.(open)
  }

  const requestSidebarOpenChange = (open: boolean) => {
    if (controlledSidebarOpen === undefined) setUncontrolledSidebarOpen(open)
    onSidebarOpenChange?.(open)
  }

  const requestPaletteOpenChange = (open: boolean) => {
    if (controlledPaletteOpen === undefined) setPaletteOpen(open)
    onCommandPaletteOpenChange?.(open)
  }

  const style = {
    "--g-shell-sidebar-width": sidebar && isSidebarOpen ? "var(--g-sidebar-width, 275px)" : "0px",
    "--g-shell-panel-width": isRightPanelOpen
      ? "minmax(230px, var(--g-layout-panel-width, 300px))"
      : "0px",
  } as CSSProperties

  const shortcut = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌘P"
    : "Ctrl+P"

  const titleBarLeft = titleBarMode === "custom" ? titleBar?.left : <>
    {sidebar && <button
      ref={sidebarToggleRef}
      className="g-titlebar__icon-button"
      type="button"
      aria-label={strings.sidebarToggleLabel}
      aria-expanded={isSidebarOpen}
      aria-controls={sidebarId}
      title={strings.sidebarToggleLabel}
      onClick={() => requestSidebarOpenChange(!isSidebarOpen)}
    ><PanelLeft aria-hidden="true" /></button>}
    {titleBar?.left && <div className="g-titlebar__extra g-titlebar__extra--left">{titleBar.left}</div>}
  </>

  const titleBarRight = titleBarMode === "custom" ? titleBar?.right : <>
    {titleBar?.right && <div className="g-titlebar__extra g-titlebar__extra--right">{titleBar.right}</div>}
    <button
      className="g-titlebar__command-trigger"
      type="button"
      aria-label={strings.commandPalette.searchPlaceholder}
      title={`${strings.commandPalette.searchPlaceholder} · ${shortcut}`}
      onClick={() => requestPaletteOpenChange(true)}
    >
      <Search aria-hidden="true" />
      <span>{strings.commandPalette.searchPlaceholder}</span>
      <kbd aria-hidden="true">{shortcut}</kbd>
    </button>
    {hasRightPanel && <button
      ref={rightPanelToggleRef}
      className="g-titlebar__icon-button"
      type="button"
      aria-label={strings.rightPanelToggleLabel}
      aria-expanded={isRightPanelOpen}
      aria-controls={resolvedRightPanelId}
      title={strings.rightPanelToggleLabel}
      onClick={() => requestRightPanelOpenChange(!isRightPanelOpen)}
    ><PanelRight aria-hidden="true" /></button>}
  </>

  return (
    <div className="g-shell-frame">
      {activityRail && <div className="g-shell-frame__rail">{activityRail}</div>}
    <div className={["g-app-shell", className].filter(Boolean).join(" ")} style={style} onFocusCapture={trackFocusedPane}>
      {titleBarMode === "custom" ? <div className="g-app-shell__custom-titlebar"><GTitleBar {...titleBar} aria-label={appName} left={titleBarLeft} center={titleBar?.center} right={titleBarRight} /></div> : <GTitleBar
        {...titleBar}
        aria-label={appName}
        left={titleBarLeft}
        right={titleBarRight}
      />}
      {sidebar && (
        <div className="g-app-shell__navigation">
          <aside
            ref={sidebarRef}
            id={sidebarId}
            className="g-app-shell__sidebar"
            aria-label={strings.sidebarLabel}
            hidden={!isSidebarOpen}
            onClick={(event) => {
              if (!window.matchMedia("(max-width: 760px)").matches || !(event.target instanceof Element)) return
              if (!event.target.closest('a[href], .g-navigation-item, [data-navigation-dismiss]')) return
              requestSidebarOpenChange(false)
              requestAnimationFrame(() => sidebarToggleRef.current?.focus())
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !window.matchMedia("(max-width: 760px)").matches || !isSidebarOpen) return
              event.preventDefault()
              event.stopPropagation()
              requestSidebarOpenChange(false)
              requestAnimationFrame(() => sidebarToggleRef.current?.focus())
            }}
          >
            {sidebar}
          </aside>
        </div>
      )}
      <div className="g-app-shell__workspace">
      <main className="g-app-shell__main" aria-label={strings.mainLabel}>
        <div className={`g-app-shell__content${contentPadding === "none" ? " g-app-shell__content--padding-none" : ""}${contentLayout === "fill" ? " g-app-shell__content--fill" : ""}`}>
          {children}
        </div>
        {composer && <section className="g-app-shell__composer" aria-label={strings.composerLabel}>{composer}</section>}
      </main>
      {hasRightPanel && (
        <GAppShellRightPanelContext.Provider value={requestRightPanelOpenChange}>
          <aside
            ref={rightPanelRef}
            id={resolvedRightPanelId}
            className={`g-app-shell__right-panel${rightPanelPresentation === "inset" ? " g-app-shell__right-panel--inset" : ""}`}
            aria-label={strings.rightPanelLabel}
            hidden={!isRightPanelOpen}
          >
            {rightPanel}
          </aside>
        </GAppShellRightPanelContext.Provider>
      )}
      {bottomPanel && <section className="g-app-shell__bottom-panel" aria-label={strings.bottomPanelLabel}>{bottomPanel}</section>}
      </div>
      <GCommandPalette
        items={commandItems}
        strings={strings.commandPalette}
        open={isPaletteOpen}
        onOpenChange={requestPaletteOpenChange}
      />
    </div>
    </div>
  )
}
