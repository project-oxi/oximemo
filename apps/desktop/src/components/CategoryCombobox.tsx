/**
 * Keyboard-first category picker. Renders a trigger chip (color dot + id)
 * that opens a panel containing a filter input and a scrollable list of
 * matching categories. When the typed query matches no existing id, a
 * "✨ Create '<typed>'" row appears at the bottom; activating it calls
 * `onCreate(query)`.
 *
 * Keys (when panel is open):
 *   ↑ / ↓   move highlight
 *   Enter   activate highlighted row (select existing OR create new)
 *   Esc     close without changes
 *
 * Hand-rolled rather than using `@base-ui-components/react`'s Combobox
 * because the spec is small and the control needs to coexist cleanly
 * with the existing `<select>` styling baseline.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { CategoryDef } from "../lib/types";

const cx = (...xs: (string | false | null | undefined)[]) =>
  xs.filter(Boolean).join(" ");

export interface CategoryComboboxProps {
  value: string;
  onValueChange: (id: string) => void;
  categories: CategoryDef[];
  /** Called when the user activates the inline "Create" row. */
  onCreate?: (id: string) => void;
  className?: string;
}

export function CategoryCombobox({
  value,
  onValueChange,
  categories,
  onCreate,
  className,
}: CategoryComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  const wrapRef = useRef<HTMLDivElement>(null);
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

  /** Total rows = filtered + (optional create row). Highlight index uses
   *  this length so the create row sits at index = filtered.length. */
  const totalRows = filtered.length + (showCreate ? 1 : 0);

  /** Reset highlight whenever the row set changes (open / query change). */
  useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  /** Focus the filter input when the panel opens. */
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  /** Click-outside / blur to dismiss. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  /** Keep the highlighted row in view as ↑/↓ moves. */
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const item = list.querySelector<HTMLElement>(`[data-row="${highlight}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const activate = (i: number) => {
    if (showCreate && i === filtered.length) {
      onCreate?.(trimmed);
    } else {
      const row = filtered[i];
      if (row) onValueChange(row.id);
    }
    close();
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
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      // Let Tab leave the field naturally; close on the way out.
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} className={cx("relative", className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
      >
        <span
          aria-hidden
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{
            backgroundColor: selected?.color || "var(--card-edge)",
          }}
        />
        <span>{value}</span>
        <span aria-hidden className="text-zinc-400">▾</span>
      </button>
      {open && (
        <div
          role="dialog"
          className="absolute left-0 top-full z-50 mt-1 w-56 rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
        >
          <div className="border-b border-zinc-100 p-1 dark:border-zinc-700">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Filter…"
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md bg-transparent px-2 py-1 text-xs outline-none placeholder:text-zinc-400"
            />
          </div>
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            className="max-h-56 overflow-y-auto py-1"
          >
            {filtered.length === 0 && !showCreate && (
              <li className="px-3 py-1.5 text-xs text-zinc-400">
                No matches
              </li>
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
                  i === highlight
                    ? "bg-zinc-100 dark:bg-zinc-700"
                    : "",
                )}
              >
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: c.color }}
                />
                <span className="flex-1 truncate">{c.id}</span>
                {c.builtin && (
                  <span className="text-[10px] text-zinc-400">built-in</span>
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
                  "flex w-full cursor-pointer items-center gap-2 border-t border-zinc-100 px-3 py-1.5 text-left text-xs text-purple-600 dark:border-zinc-700 dark:text-purple-400",
                  filtered.length === highlight
                    ? "bg-zinc-100 dark:bg-zinc-700"
                    : "",
                )}
              >
                <span aria-hidden>✨</span>
                <span className="truncate">Create '{trimmed}'</span>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}