import * as React from "react"

import { cn } from "../../lib/utils"

export type FloatingDockItem = {
  id: string
  label: string
  icon: React.ReactNode
  disabled?: boolean
}

export type FloatingDockProps = {
  label: string
  items: readonly FloatingDockItem[]
  activeId?: string
  onSelect: (id: string) => void
  className?: string
}

function FloatingDock({
  label,
  items,
  activeId,
  onSelect,
  className,
}: FloatingDockProps) {
  const itemRefs = React.useRef(new Map<string, HTMLButtonElement>())
  const [rovingId, setRovingId] = React.useState<string | null>(null)
  const enabledItems = items.filter((item) => !item.disabled)
  const rovingIdIsEnabled = enabledItems.some((item) => item.id === rovingId)
  const activeIdIsEnabled = enabledItems.some((item) => item.id === activeId)
  const tabStopId = rovingIdIsEnabled
    ? rovingId
    : activeIdIsEnabled
      ? activeId
      : (enabledItems[0]?.id ?? null)

  function handleKeyDown(id: string, event: React.KeyboardEvent<HTMLButtonElement>) {
    if (enabledItems.length === 0) return

    let nextIndex: number
    const currentIndex = Math.max(
      enabledItems.findIndex((item) => item.id === id),
      0
    )

    switch (event.key) {
      case "ArrowRight":
        nextIndex = (currentIndex + 1) % enabledItems.length
        break
      case "ArrowLeft":
        nextIndex = (currentIndex - 1 + enabledItems.length) % enabledItems.length
        break
      case "Home":
        nextIndex = 0
        break
      case "End":
        nextIndex = enabledItems.length - 1
        break
      default:
        return
    }

    event.preventDefault()
    const nextItem = enabledItems[nextIndex]
    if (!nextItem) return

    setRovingId(nextItem.id)
    itemRefs.current.get(nextItem.id)?.focus()
  }

  return (
    <div
      role="toolbar"
      aria-label={label}
      aria-orientation="horizontal"
      className={cn("g-floating-dock", className)}
    >
      {items.map((item) => (
        <button
          key={item.id}
          ref={(node) => {
            if (node) itemRefs.current.set(item.id, node)
            else itemRefs.current.delete(item.id)
          }}
          type="button"
          className="g-floating-dock__item"
          aria-label={item.label}
          aria-pressed={item.id === activeId}
          disabled={item.disabled}
          tabIndex={!item.disabled && item.id === tabStopId ? 0 : -1}
          onFocus={() => setRovingId(item.id)}
          onClick={() => onSelect(item.id)}
          onKeyDown={(event) => handleKeyDown(item.id, event)}
        >
          <span className="g-floating-dock__icon" aria-hidden="true">
            {item.icon}
          </span>
          <span className="g-floating-dock__label" aria-hidden="true">
            {item.label}
          </span>
        </button>
      ))}
    </div>
  )
}

export { FloatingDock }
