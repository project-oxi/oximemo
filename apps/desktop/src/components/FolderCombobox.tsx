/**
 * Keyboard-first folder picker. Mirrors the old CategoryCombobox API so
 * call sites keep the same shape, but operates on real vault folders.
 */
import { forwardRef, useImperativeHandle, useMemo, useState } from "react";
import { Popover } from "@base-ui-components/react";
import { Folder, FolderPlus } from "lucide-react";

import type { FolderEntry } from "../lib/types";

export interface FolderComboboxHandle {
  open: () => void;
}

export interface FolderComboboxProps {
  value: string;
  onValueChange: (path: string) => void;
  folders: FolderEntry[];
  onCreate?: (path: string) => void;
  onClose?: () => void;
  triggerAriaLabel?: string;
  className?: string;
}

export const FolderCombobox = forwardRef<
  FolderComboboxHandle,
  FolderComboboxProps
>(function FolderCombobox(
  { value, onValueChange, folders, onCreate, onClose, triggerAriaLabel, className },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useImperativeHandle(ref, () => ({
    open: () => setOpen(true),
  }));

  const selected = value === "" ? "(root)" : value;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return folders;
    return folders.filter((f) => f.path.toLowerCase().includes(q));
  }, [folders, query]);

  const trimmed = query.trim();
  const showCreate = trimmed.length > 0 && !folders.some((f) => f.path === trimmed) && !!onCreate;
  const totalRows = filtered.length + (showCreate ? 1 : 0);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          onClose?.();
          setQuery("");
        }
      }}
    >
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label={triggerAriaLabel}
            className={`inline-flex items-center gap-1 rounded-[var(--tag-radius)] bg-surface-muted px-2.5 py-1 text-xs text-text transition-colors duration-150 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${className ?? ""}`}
          >
            <Folder size={12} className="text-text-subtle" />
            <span>{selected}</span>
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner sideOffset={4}>
          <Popover.Popup className="z-50 w-72 rounded-[var(--popover-radius)] border border-line bg-surface-raised p-2 shadow-lg">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter or new path…"
              className="mb-2 w-full rounded-[var(--input-radius)] bg-transparent px-2 py-1 text-xs shadow-[var(--input-shadow)] focus-visible:outline-none focus-visible:shadow-[var(--input-shadow-focus)]"
            />
            <ul className="max-h-56 overflow-y-auto" role="listbox">
              <li>
                <button
                  type="button"
                  className={`flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-xs ${
                    value === "" ? "bg-surface-muted" : "hover:bg-surface-muted"
                  }`}
                  onClick={() => {
                    onValueChange("");
                    setOpen(false);
                  }}
                >
                  <span>(root)</span>
                </button>
              </li>
              {filtered.map((f) => (
                <li key={f.path || "(root)"}>
                  <button
                    type="button"
                    className={`flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-xs ${
                      value === f.path ? "bg-surface-muted" : "hover:bg-surface-muted"
                    }`}
                    onClick={() => {
                      onValueChange(f.path);
                      setOpen(false);
                    }}
                  >
                    <span>{f.path || "(root)"}</span>
                    <span className="text-text-subtle">{f.note_count}</span>
                  </button>
                </li>
              ))}
              {showCreate && (
                <li>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-interactive-primary hover:bg-surface-muted"
                    onClick={async () => {
                      if (onCreate) await onCreate(trimmed);
                      onValueChange(trimmed);
                      setOpen(false);
                    }}
                  >
                    <FolderPlus size={12} /> Create '{trimmed}'
                  </button>
                </li>
              )}
              {totalRows === 0 && (
                <li className="px-2 py-1 text-xs text-text-subtle">No folders yet.</li>
              )}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
});