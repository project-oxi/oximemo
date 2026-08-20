/**
 * FolderPalette — the ⌘⇧O folder jump palette (spec H10-2, Task 15). A
 * Base UI Dialog following MemoDetail's conventions (Portal + Backdrop +
 * centered Popup, sr-only Title, Escape-to-close via the Dialog default)
 * listing every folder from `list_folders` with a case-insensitive
 * substring filter over the FULL path — typing "a/b" matches nested
 * folders without picking the parent first.
 *
 * Keyboard: ↓/↑ move the selection, Enter or click navigates via
 * `onNavigate` (CardGrid's wiring — setFolderFilter plus dropping any
 * active search), Escape closes. The vault root ("") is not listed: it
 * is always one ⌘↑ or breadcrumb-Home away, and an empty-string entry
 * would match every filter query.
 */
import { Dialog } from "@base-ui-components/react";
import { CornerDownLeft } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { colorForFolder } from "../lib/color";
import { useI18n } from "../lib/i18n";
import type { FolderDef, FolderEntry } from "../lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** All folders (list_folders). The root entry ("") is skipped. */
  folders: FolderEntry[];
  /** Config folder defs (for the color dot), matching SegmentPopover. */
  folderDefs: FolderDef[];
  onNavigate: (path: string) => void;
}

/** Path with the first case-insensitive substring match emphasized. */
function Highlight({ path, q }: { path: string; q: string }) {
  if (!q) return <>{path}</>;
  const i = path.toLowerCase().indexOf(q);
  if (i === -1) return <>{path}</>;
  return (
    <>
      {path.slice(0, i)}
      <mark className="rounded-[2px] bg-transparent font-semibold text-text">
        {path.slice(i, i + q.length)}
      </mark>
      {path.slice(i + q.length)}
    </>
  );
}

export function FolderPalette({ open, onClose, folders, folderDefs, onNavigate }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Fresh filter + selection each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
    }
  }, [open]);

  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      (q
        ? folders.filter((f) => f.path !== "" && f.path.toLowerCase().includes(q))
        : folders.filter((f) => f.path !== "")),
    [folders, q],
  );
  // Clamp the selection into the (possibly shrunken) match list so Enter
  // can never fire a stale index after the filter narrows.
  const selIdx = Math.min(sel, Math.max(0, matches.length - 1));

  // Keep the highlighted option in view while arrowing through long lists.
  useEffect(() => {
    listRef.current?.children[selIdx]?.scrollIntoView({ block: "nearest" });
  }, [selIdx]);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity duration-200 ease-out data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-20 z-50 w-[min(480px,92vw)] -translate-x-1/2 overflow-hidden rounded-[var(--dialog-radius)] border border-line bg-surface-raised shadow-lg transition-[opacity,translate,scale] duration-200 ease-out data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0">
          <Dialog.Title className="sr-only">{t.jump_to_folder}</Dialog.Title>
          <div className="border-b border-line px-3 py-2">
            <input
              // eslint-disable-next-line jsx-a11y/no-autofocus -- palette is a modal; focus must start in the filter field
              autoFocus
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls="folder-palette-listbox"
              aria-autocomplete="list"
              aria-label={t.jump_to_folder}
              placeholder={t.jump_to_folder}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSel(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSel((s) => Math.min(s + 1, matches.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel((s) => Math.max(s - 1, 0));
                } else if (e.key === "Enter") {
                  const m = matches[selIdx];
                  if (m) {
                    e.preventDefault();
                    onNavigate(m.path);
                  }
                }
              }}
              className="w-full rounded-[var(--input-radius)] bg-transparent px-2 py-1.5 text-sm placeholder:text-text-subtle shadow-[var(--input-shadow)] focus-visible:shadow-[var(--input-shadow-focus)] focus-visible:outline-none"
            />
          </div>
          <ul
            id="folder-palette-listbox"
            ref={listRef}
            role="listbox"
            aria-label={t.jump_to_folder}
            className="max-h-72 overflow-y-auto p-1"
          >
            {matches.length === 0 ? (
              <li className="px-2 py-3 text-center text-[13px] text-text-subtle">
                {t.no_folder_results}
              </li>
            ) : (
              matches.map((f, i) => {
                const color = colorForFolder(f.path, folderDefs);
                return (
                  <li key={f.path}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === selIdx}
                      data-path={f.path}
                      onClick={() => onNavigate(f.path)}
                      onMouseMove={() => setSel(i)}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150 ${
                        i === selIdx
                          ? "bg-surface-muted text-text"
                          : "text-text hover:bg-surface-muted"
                      }`}
                    >
                      <span
                        aria-hidden
                        className="inline-block size-2 shrink-0 rounded-full"
                        style={{ background: color || "var(--color-text-subtle)" }}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        <Highlight path={f.path} q={q} />
                      </span>
                      {f.note_count > 0 && (
                        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-text-subtle">
                          {f.note_count}
                        </span>
                      )}
                      {i === selIdx && (
                        <CornerDownLeft size={12} aria-hidden className="shrink-0 text-text-subtle" />
                      )}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
