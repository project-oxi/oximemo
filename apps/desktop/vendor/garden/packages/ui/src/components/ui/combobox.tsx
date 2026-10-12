import * as React from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "../../lib/utils"
import { Popover, PopoverAnchor, PopoverContent } from "./popover"

export type ComboboxOption = {
  value: string
  label: string
  disabled?: boolean
}

export type ComboboxProps = {
  label: string
  options: readonly ComboboxOption[]
  value: string
  onValueChange: (value: string) => void
  placeholder: string
  emptyLabel: string
  disabled?: boolean
  className?: string
}

function optionId(listboxId: string, index: number) {
  return `${listboxId}-option-${index}`
}

function Combobox({
  label,
  options,
  value,
  onValueChange,
  placeholder,
  emptyLabel,
  disabled = false,
  className,
}: ComboboxProps) {
  const inputId = React.useId()
  const listboxId = `${inputId}-listbox`
  const rootRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const listboxRef = React.useRef<HTMLUListElement>(null)
  const optionRefs = React.useRef(new Map<string, HTMLLIElement>())
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [isFiltering, setIsFiltering] = React.useState(false)
  const [activeValue, setActiveValue] = React.useState<string | null>(null)
  const isOpen = open && !disabled

  const selectedLabel = options.find((option) => option.value === value)?.label ?? ""
  const normalizedQuery = isFiltering ? query.trim().toLocaleLowerCase() : ""
  const filteredOptions = options.filter((option) =>
    option.label.toLocaleLowerCase().includes(normalizedQuery)
  )
  const enabledOptions = filteredOptions.filter((option) => !option.disabled)
  const activeOption =
    enabledOptions.find((option) => option.value === activeValue) ??
    enabledOptions.find((option) => option.value === value) ??
    enabledOptions[0]
  const inputValue = isOpen && isFiltering ? query : selectedLabel

  function resetSearch() {
    setQuery("")
    setIsFiltering(false)
  }

  function openMenu() {
    resetSearch()
    setOpen(true)
    const selectedOption = options.find(
      (option) => option.value === value && !option.disabled
    )
    const firstEnabledOption = options.find((option) => !option.disabled)
    setActiveValue(selectedOption?.value ?? firstEnabledOption?.value ?? null)
  }

  function closeMenu() {
    setOpen(false)
    resetSearch()
    setActiveValue(value)
  }

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) setOpen(true)
    else closeMenu()
  }

  function selectOption(optionValue: string) {
    const option = options.find((candidate) => candidate.value === optionValue)
    if (!option || option.disabled || disabled) return

    onValueChange(option.value)
    setOpen(false)
    resetSearch()
    setActiveValue(option.value)
  }

  function moveActiveOption(direction: -1 | 1) {
    if (enabledOptions.length === 0) return

    const currentIndex = enabledOptions.findIndex(
      (option) => option.value === activeOption?.value
    )
    const nextIndex =
      currentIndex === -1
        ? direction === 1
          ? 0
          : enabledOptions.length - 1
        : (currentIndex + direction + enabledOptions.length) % enabledOptions.length
    setActiveValue(enabledOptions[nextIndex]?.value ?? null)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return

    if (event.key === "Escape" && open) {
      event.preventDefault()
      closeMenu()
      return
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const direction = event.key === "ArrowDown" ? 1 : -1
      if (!open) openMenu()
      else moveActiveOption(direction)
      return
    }

    if (open && (event.key === "Home" || event.key === "End")) {
      if (enabledOptions.length === 0) return
      event.preventDefault()
      const target = event.key === "Home" ? enabledOptions[0] : enabledOptions.at(-1)
      setActiveValue(target?.value ?? null)
      return
    }

    if (event.key === "Enter" && open) {
      event.preventDefault()
      if (activeOption) selectOption(activeOption.value)
    }
  }

  function handleBlur(event: React.FocusEvent<HTMLInputElement>) {
    const nextTarget = event.relatedTarget as Node | null
    if (nextTarget && rootRef.current?.contains(nextTarget)) return
    closeMenu()
  }

  React.useEffect(() => {
    if (!isOpen || !activeOption) return

    const listbox = listboxRef.current
    const option = optionRefs.current.get(activeOption.value)
    if (!listbox || !option) return

    const listboxRect = listbox.getBoundingClientRect()
    const optionRect = option.getBoundingClientRect()
    if (optionRect.bottom > listboxRect.bottom) {
      listbox.scrollTop += optionRect.bottom - listboxRect.bottom
    } else if (optionRect.top < listboxRect.top) {
      listbox.scrollTop -= listboxRect.top - optionRect.top
    }
  }, [activeOption?.value, isOpen, options])

  React.useEffect(() => {
    if (disabled) closeMenu()
  }, [disabled])

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <div
        ref={rootRef}
        className={cn("g-combobox", className)}
        data-slot="combobox"
      >
        <label className="g-combobox__label" htmlFor={inputId}>
          {label}
        </label>
        <PopoverAnchor asChild>
          <div className="g-combobox__control">
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              role="combobox"
              className="g-combobox__input"
              value={inputValue}
              placeholder={placeholder}
              disabled={disabled}
              autoComplete="off"
              aria-expanded={isOpen}
              aria-controls={isOpen ? listboxId : undefined}
              aria-autocomplete="list"
              aria-activedescendant={
                isOpen && activeOption
                  ? optionId(
                      listboxId,
                      options.findIndex((option) => option.value === activeOption.value)
                    )
                  : undefined
              }
              aria-haspopup="listbox"
              onFocus={(event) => {
                openMenu()
                event.currentTarget.select()
              }}
              onClick={() => {
                if (!open) openMenu()
              }}
              onChange={(event) => {
                const nextQuery = event.currentTarget.value
                const normalizedNextQuery = nextQuery.trim().toLocaleLowerCase()
                const matchingOptions = options.filter(
                  (option) =>
                    !option.disabled &&
                    option.label.toLocaleLowerCase().includes(normalizedNextQuery)
                )
                setQuery(nextQuery)
                setIsFiltering(true)
                setOpen(true)
                setActiveValue(matchingOptions[0]?.value ?? null)
              }}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
            />
            <ChevronDown
              className="g-combobox__icon"
              aria-hidden="true"
              focusable="false"
            />
          </div>
        </PopoverAnchor>
      </div>
      <PopoverContent
        className="g-combobox__popup"
        role="presentation"
        align="start"
        side="bottom"
        sideOffset={4}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (event.isComposing || event.keyCode === 229) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (rootRef.current?.contains(event.target as Node)) {
            event.preventDefault()
          }
        }}
      >
        <ul
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          className="g-combobox__listbox"
          aria-label={label}
          onMouseDown={(event) => event.preventDefault()}
        >
          {filteredOptions.map((option) => {
            const isActive = option.value === activeOption?.value
            const id = optionId(
              listboxId,
              options.findIndex((candidate) => candidate.value === option.value)
            )

            return (
              <li
                key={option.value}
                ref={(node) => {
                  if (node) optionRefs.current.set(option.value, node)
                  else optionRefs.current.delete(option.value)
                }}
                id={id}
                role="option"
                className="g-combobox__option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                data-active={isActive ? "true" : undefined}
                onMouseMove={() => {
                  if (!option.disabled) setActiveValue(option.value)
                }}
                onClick={() => selectOption(option.value)}
              >
                {option.label}
              </li>
            )
          })}
        </ul>
        {filteredOptions.length === 0 ? (
          <div className="g-combobox__empty" role="status" aria-live="polite">
            {emptyLabel}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

export { Combobox }
