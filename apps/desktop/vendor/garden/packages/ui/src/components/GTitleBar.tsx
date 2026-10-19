import type { CSSProperties, ReactNode } from "react"

export interface GTitleBarProps {
  left?: ReactNode
  center?: ReactNode
  right?: ReactNode
  /** Extra leading room for native macOS traffic lights in an overlay titlebar. */
  macOSInset?: number
  /** Accessible identity for the window titlebar. */
  "aria-label"?: string
  className?: string
}

export function GTitleBar({
  left,
  center,
  right,
  macOSInset = 0,
  className,
  "aria-label": ariaLabel,
}: GTitleBarProps) {
  const style = { "--g-titlebar-macos-inset": `${macOSInset}px` } as CSSProperties

  return (
    <header
      className={["g-titlebar", className].filter(Boolean).join(" ")}
      style={style}
      aria-label={ariaLabel}
      data-tauri-drag-region
    >
      <div data-tauri-drag-region className="g-titlebar__slot g-titlebar__slot--left">{left}</div>
      <div data-tauri-drag-region className="g-titlebar__slot g-titlebar__slot--center">{center}</div>
      <div data-tauri-drag-region className="g-titlebar__slot g-titlebar__slot--right">{right}</div>
    </header>
  )
}
