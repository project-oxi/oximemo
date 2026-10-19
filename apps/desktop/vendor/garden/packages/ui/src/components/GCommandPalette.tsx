import { useEffect, useId, useMemo, useRef, useState } from "react"
import type { KeyboardEvent, ReactNode } from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { Search, X } from "lucide-react"

export interface GCommandItem {
  id: string
  label: string
  onSelect: () => void
  group?: string
  description?: string
  keywords?: string[]
  shortcut?: string
  icon?: ReactNode
  disabled?: boolean
}

export interface GCommandPaletteStrings {
  ariaLabel: string
  searchPlaceholder: string
  emptyTitle: string
  emptyHint: string
  closeLabel: string
}

export interface GCommandPaletteProps {
  items: GCommandItem[]
  strings: GCommandPaletteStrings
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Bind Meta/Ctrl+P globally. Disable when a parent shell owns the shortcut. */
  bindShortcut?: boolean
  className?: string
}

export function GCommandPalette({
  items,
  strings,
  open: controlledOpen,
  onOpenChange,
  bindShortcut = true,
  className,
}: GCommandPaletteProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [activeItemId, setActiveItemId] = useState<string | null>(null)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : uncontrolledOpen
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const previousOpenRef = useRef(false)
  const listId = useId()

  const setOpen = (nextOpen: boolean) => {
    if (!isControlled) setUncontrolledOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }

  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return items
    return items.filter((item) =>
      [item.label, item.group, item.description, ...(item.keywords ?? [])]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(normalized))
    )
  }, [items, query])

  const enabledIndexes = useMemo(
    () => filteredItems.flatMap((item, index) => item.disabled ? [] : [index]),
    [filteredItems],
  )
  const firstEnabledIndex = enabledIndexes[0] ?? -1
  const selectedEnabledIndex = enabledIndexes.findIndex(
    (index) => filteredItems[index].id === activeItemId,
  )
  const activeEnabledIndex = selectedEnabledIndex >= 0
    ? enabledIndexes[selectedEnabledIndex]
    : firstEnabledIndex

  useEffect(() => {
    if (!bindShortcut) return
    const onGlobalKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        // Let an existing modal own its keyboard interaction.
        if (!open && document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')) return
        event.preventDefault()
        setOpen(!open)
      }
    }
    window.addEventListener("keydown", onGlobalKeyDown)
    return () => window.removeEventListener("keydown", onGlobalKeyDown)
  }, [bindShortcut, open, isControlled, onOpenChange])

  useEffect(() => {
    if (open && !previousOpenRef.current) {
      setQuery("")
      setActiveItemId(items.find((item) => !item.disabled)?.id ?? null)
    }
    previousOpenRef.current = open
  }, [open])

  useEffect(() => {
    const first = enabledIndexes[0]
    setActiveItemId(first === undefined ? null : filteredItems[first].id)
  }, [query])

  useEffect(() => {
    if (activeItemId && enabledIndexes.some((index) => filteredItems[index].id === activeItemId)) return
    setActiveItemId(firstEnabledIndex < 0 ? null : filteredItems[firstEnabledIndex].id)
  }, [activeItemId, enabledIndexes, filteredItems, firstEnabledIndex])

  useEffect(() => {
    if (activeEnabledIndex < 0) return
    const active = dialogRef.current?.querySelector<HTMLElement>(`[data-command-index="${activeEnabledIndex}"]`)
    active?.scrollIntoView({ block: "nearest" })
  }, [activeEnabledIndex])

  const run = (item: GCommandItem) => {
    if (item.disabled) return
    setOpen(false)
    item.onSelect()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key === "ArrowDown" && enabledIndexes.length > 0) {
      event.preventDefault()
      const currentPosition = enabledIndexes.indexOf(activeEnabledIndex)
      const nextIndex = enabledIndexes[(currentPosition + 1 + enabledIndexes.length) % enabledIndexes.length]
      setActiveItemId(filteredItems[nextIndex].id)
    } else if (event.key === "ArrowUp" && enabledIndexes.length > 0) {
      event.preventDefault()
      const currentPosition = enabledIndexes.indexOf(activeEnabledIndex)
      const previousIndex = enabledIndexes[(currentPosition - 1 + enabledIndexes.length) % enabledIndexes.length]
      setActiveItemId(filteredItems[previousIndex].id)
    } else if (event.key === "Enter") {
      const item = activeEnabledIndex >= 0 ? filteredItems[activeEnabledIndex] : undefined
      if (event.target === inputRef.current && item) {
        event.preventDefault()
        run(item)
      }
    }
  }

  let previousGroup: string | undefined

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="g-command-palette__backdrop">
      <DialogPrimitive.Content
        ref={dialogRef}
        className={["g-command-palette", className].filter(Boolean).join(" ")}
        aria-modal="true"
        aria-describedby={undefined}
        onKeyDown={handleKeyDown}
        onEscapeKeyDown={(event) => {
          if (event.isComposing || event.keyCode === 229) event.preventDefault()
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          inputRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus()
        }}
      >
        <DialogPrimitive.Title className="sr-only">{strings.ariaLabel}</DialogPrimitive.Title>
        <div className="g-command-palette__search-row">
          <Search aria-hidden="true" className="g-command-palette__search-icon" />
          <input
            ref={inputRef}
            className="g-command-palette__input"
            role="combobox"
            aria-label={strings.searchPlaceholder}
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeEnabledIndex >= 0 ? `${listId}-option-${activeEnabledIndex}` : undefined}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={strings.searchPlaceholder}
          />
          <button
            className="g-command-palette__close"
            type="button"
            aria-label={strings.closeLabel}
            onClick={() => setOpen(false)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <div id={listId} className="g-command-palette__list" role="listbox" aria-label={strings.ariaLabel}>
          {filteredItems.length === 0 ? (
            <div className="g-command-palette__empty">
              <strong>{strings.emptyTitle}</strong>
              <span>{strings.emptyHint}</span>
            </div>
          ) : filteredItems.map((item, index) => {
            const groupHeading = item.group && item.group !== previousGroup ? item.group : null
            previousGroup = item.group
            return (
              <div key={item.id}>
                {groupHeading && <div className="g-command-palette__group">{groupHeading}</div>}
                <button
                  id={`${listId}-option-${index}`}
                  data-command-index={index}
                  className="g-command-palette__item"
                  type="button"
                  tabIndex={-1}
                  role="option"
                  aria-selected={index === activeEnabledIndex}
                  aria-disabled={item.disabled || undefined}
                  title={item.description}
                  onMouseEnter={() => {
                    if (!item.disabled) setActiveItemId(item.id)
                  }}
                  onClick={() => run(item)}
                  disabled={item.disabled}
                >
                  {item.icon && <span className="g-command-palette__item-icon" aria-hidden="true">{item.icon}</span>}
                  <span className="g-command-palette__item-label">{item.label}</span>
                  {item.shortcut && <kbd className="g-command-palette__shortcut">{item.shortcut}</kbd>}
                </button>
              </div>
            )
          })}
        </div>
      </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
