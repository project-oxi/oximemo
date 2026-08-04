/**
 * Keyboard-first category picker. Renders a trigger chip (color dot + id)
 * that opens a Base UI Popover containing a filter input and a scrollable
 * list of matching categories. When the typed query matches no existing
 * id, a "✨ Create '<typed>'" row appears at the bottom; activating it
 * calls `onCreate(query)`.
 *
 * The panel is rendered via Popover.Portal → it escapes the MemoDetail
 * Dialog.Popup's `overflow-hidden` (which previously clipped it) and
 * auto-flips to stay on screen. It opens upward (side="top") by default
 * because the chip lives at the dialog's bottom edge.
 *
 * The picker exposes an imperative `open()` (via ref) so a keyboard
 * shortcut (⌘L in MemoDetail) can open it without a mouse click, and an
 * `onClose` callback so the host can return focus to the editor.
 *
 * Keys (when panel is open):
 *   ↑ / ↓   move highlight
 *   Enter   activate highlighted row (select existing OR create new)
 *   Esc     close without changes  (handled by Base UI Popover)
 */
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Popover } from "@base-ui-components/react";

import type { CategoryDef } from "../lib/types";

const cx = (...xs: (string | false | null | undefined)[]) =>
  xs.filter(Boolean).join(" ");

export interface CategoryComboboxHandle {
  /** Open the panel and focus the filter input. */
  open: () => void;
}

export interface CategoryComboboxProps {
  value: string;
  onValueChange: (id: string) => void;
  categories: CategoryDef[];
  /** Called when the user activates the inline "Create" row. */
  onCreate?: (id: string) => void;
  /** Fired exactly once when the panel closes (select / Esc / outside). */
  onClose?: () => void;
  /** Accessible label / tooltip for the trigger chip (i18n-injected). */
  triggerAriaLabel?: string;
  className?: string;
}

export const CategoryCombobox = forwardRef<
  CategoryComboboxHandle,
  CategoryComboboxProps
>(function CategoryCombobox(
  { value, onValueChange, categories, onCreate, onClose, triggerAriaLabel, className },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  const selected = categories.find((c) => c.id === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((c) => c.id.toLowerCase().includes(q));
  }, [categories, query]);

  const trimmed = query.trim();
  const showCreate =
    trimmed.length > 0 &&
    !categories.some((c) => c.id === trimmed) &&
    !!onCreate;

  const totalRows = filtered.length + (showCreate ? 1 : 0);

  /** Close the panel + notify host once. */
  const closeWithNotify = () => {
    setOpen(false);
    setQuery("");
    onClose?.();
  };

  useImperativeHandle(
    ref,
    () => ({
      open: () => setOpen(true),
    }),
    [],
  );

  useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  /** Focus the filter input when the panel opens. */
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  /** Keep the highlighted row in view as ↑/↓ moves. */
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const item = list.querySelector<HTMLElement>(`[data-row="${highlight}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const activate = (i: number) => {
    if (showCreate && i === filtered.length) {
      onCreate?.(trimmed);
    } else {
      const row = filtered[i];
      if (row) onValueChange(row.id);
    }
    closeWithNotify();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (totalRows === 0 ? 0 : (h + 1) % totalRows));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) =>
        totalRows === 0 ? 0 : (h - 1 + totalRows) % totalRows,
      );
    } else if (e.key === "Enter") {
      if (totalRows === 0) return;
      e.preventDefault();
      activate(highlight);
    } else if (e.key === "Tab") {
      // Let Tab leave the field naturally; close silently (no onClose →
      // focus follows the natural Tab target, not forced to editor).
      setOpen(false);
    }
    // Escape is handled by Base UI Popover → onOpenChange(false) → closeWithNotify.
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : closeWithNotify())}
    >
      <Popover.Trigger
        aria-label={triggerAriaLabel}
        title={triggerAriaLabel}
        className={cx(
          "inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface-raised px-2 text-xs",
          className,
        )}
      >
        <span
          aria-hidden
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: selected?.color || "var(--color-line)" }}
        />
        <span>{value}</span>
        <span aria-hidden className="text-text-subtle">▾</span>
        <kbd className="ml-0.5 font-mono text-[10px] leading-none text-text-subtle">
          ⌘L
        </kbd>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={4} className="z-[60]">
          <Popover.Popup className="w-56 rounded-lg border border-line bg-surface-raised shadow-lg">
            <div className="border-b border-line p-1">
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Filter…"
                autoComplete="off"
                spellCheck={false}
                aria-controls={listboxId}
                className="w-full rounded-md bg-transparent px-2 py-1 text-xs outline-none placeholder:text-text-subtle"
              />
            </div>
            <ul
              ref={listRef}
              id={listboxId}
              role="listbox"
              className="max-h-56 overflow-y-auto py-1"
            >
              {filtered.length === 0 && !showCreate && (
                <li className="px-3 py-1.5 text-xs text-text-subtle">No matches</li>
              )}
              {filtered.map((c, i) => (
                <li
                  key={c.id}
                  role="option"
                  aria-selected={c.id === value}
                  data-row={i}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    activate(i);
                  }}
                  className={cx(
                    "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs",
                    i === highlight ? "bg-surface-muted" : "",
                  )}
                >
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: c.color }}
                  />
                  <span className="flex-1 truncate">{c.id}</span>
                  {c.builtin && (
                    <span className="text-[10px] text-text-subtle">built-in</span>
                  )}
                </li>
              ))}
              {showCreate && (
                <li
                  role="option"
                  aria-selected={false}
                  data-row={filtered.length}
                  onMouseEnter={() => setHighlight(filtered.length)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    activate(filtered.length);
                  }}
                  className={cx(
                    "flex w-full cursor-pointer items-center gap-2 border-t border-line px-3 py-1.5 text-left text-xs text-hue-purple",
                    filtered.length === highlight ? "bg-surface-muted" : "",
                  )}
                >
                  <span aria-hidden>✨</span>
                  <span className="truncate">Create '{trimmed}'</span>
                </li>
              )}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
});
