import type { GCommandItem, GCommandPaletteStrings } from "../GCommandPalette"
import { GCommandPalette } from "../GCommandPalette"

export interface CommandItem {
  id: string
  label: string
  group?: string
  /** Display-only key hints, joined with ` · `. */
  shortcut?: string[]
  disabled?: boolean
  onRun: () => void
}

export interface CommandMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  commands: CommandItem[]
  strings: GCommandPaletteStrings
  /** @deprecated Pass the localized value through `strings.searchPlaceholder`. */
  placeholder?: string
  className?: string
}

/**
 * @deprecated Use GCommandPalette and its GCommandItem model directly.
 * This adapter preserves the old onRun and shortcut-array command shape while
 * delegating all filtering, keyboard handling, and overlay behavior.
 */
function CommandMenu({
  open,
  onOpenChange,
  commands,
  strings,
  placeholder,
  className,
}: CommandMenuProps) {
  const items: GCommandItem[] = commands.map(({ onRun, shortcut, ...item }) => ({
    ...item,
    onSelect: onRun,
    shortcut: shortcut?.join(" · "),
  }))
  const resolvedStrings = placeholder
    ? { ...strings, searchPlaceholder: placeholder }
    : strings

  return (
    <GCommandPalette
      items={items}
      strings={resolvedStrings}
      open={open}
      onOpenChange={onOpenChange}
      bindShortcut={false}
      className={className}
    />
  )
}

export { CommandMenu }
