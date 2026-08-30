/**
 * CommandPalette — the ⌘K global intent surface (subsumes the old ⌘⇧O
 * FolderPalette). Base UI Dialog following FolderPalette's conventions:
 * Portal + Backdrop + top-center Popup, sr-only title, Escape closes.
 * Two result sources: commands (lib/paletteCommands — navigation/views/
 * actions, deterministic score ladder + recency boost) and notes (BM25
 * via search_memos when a query is present; the shared ["memos",
 * "recents"] cache when it is not). A trailing bridge row graduates the
 * query into the persistent header search.
 *
 * Keyboard: ↓/↑ move the selection (clamped), ⏎ runs, Home/End jump,
 * click/hover select. Enter during IME composition is ignored — Korean
 * confirm-Enter must not run a command.
 */
import { Dialog } from "@base-ui-components/react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  Archive,
  CalendarDays,
  Clock,
  CodeXml,
  CornerDownLeft,
  FilePlus2,
  Folder,
  FolderPlus,
  Hash,
  Images,
  Layers,
  Library,
  LayoutGrid,
  List,
  Monitor,
  Moon,
  Network,
  PanelLeft,
  Search,
  Settings,
  Star,
  Sun,
  Zap,
  Table2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { folderSchema, getConfig, listBases, listFacets, listMemos, searchMemos } from "../lib/api";
import { colorForFolder } from "../lib/color";
import { useI18n } from "../lib/i18n";
import { TASKS_BASE_PATH } from "../lib/tasksPanel";
import {
  buildCommands,
  buildSuggestions,
  rankCommands,
  RecencyLog,
  type CommandCallbacks,
  type PaletteCommand,
  type PaletteIcon,
} from "../lib/paletteCommands";
import { relativeTime } from "../lib/time";
import { useUI } from "../stores/ui";
import type { FolderDef, FolderEntry, MemoSummary } from "../lib/types";

const RECENCY_KEY = "oximemo.paletteRecency";
const SEARCH_DEBOUNCE_MS = 150;
const NOTE_RESULTS_LIMIT = 8;
const RECENT_NOTES_SHOWN = 5;
const SUGGESTION_LIMIT = 6;

const ICONS: Record<PaletteIcon, typeof Layers> = {
  layers: Layers,
  star: Star,
  images: Images,
  archive: Archive,
  calendar: CalendarDays,
  folder: Folder,
  hash: Hash,
  grid: LayoutGrid,
  list: List,
  table: Table2,
  timeline: Clock,
  graph: Network,
  sidebar: PanelLeft,
  "note-md": FilePlus2,
  "note-html": CodeXml,
  "folder-plus": FolderPlus,
  zap: Zap,
  settings: Settings,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
  library: Library,
};

interface Props {
  open: boolean;
  onClose: () => void;
  /** All folders (list_folders) — folder jump commands. */
  folders: FolderEntry[];
  /** Config folder defs (color dots for note/folder rows). */
  folderDefs: FolderDef[];
  callbacks: CommandCallbacks;
  /** Bridge row: write the query into the persistent header search. */
  onSearchAll: (q: string) => void;
}

type Row =
  | { kind: "header"; label: string }
  | { kind: "command"; cmd: PaletteCommand }
  | { kind: "note"; note: MemoSummary }
  | { kind: "bridge" }
  | { kind: "empty"; label: string }
  | { kind: "error"; label: string };

export function CommandPalette({ open, onClose, folders, folderDefs, callbacks, onSearchAll }: Props) {
  const { t, locale } = useI18n();
  const noteView = useUI((s) => s.noteView);
  const theme = useUI((s) => s.theme);
  const setView = useUI((s) => s.setView);
  const select = useUI((s) => s.select);
  const facets = useQuery({ queryKey: ["facets"], queryFn: listFacets });
  const configQ = useQuery({ queryKey: ["config"], queryFn: getConfig });
  // Shares the Sidebar's recents cache — ["memos"] prefix invalidation
  // from the memos:changed listener refreshes both.
  const recentsQ = useQuery({
    queryKey: ["memos", "recents"],
    queryFn: () => listMemos(null, 7),
  });

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sel, setSel] = useState(0);
  // Flips once the persisted recency log is restored below — the ref
  // mutation itself is invisible to the rows/matched memos, so without
  // this flag a remount would rank against an empty log until an
  // unrelated refetch re-ran them.
  const [recencyLoaded, setRecencyLoaded] = useState(false);
  const listRef = useRef<HTMLUListElement | null>(null);
  const recencyRef = useRef(new RecencyLog());

  // Restore the persisted recency log once per mount; a corrupt entry
  // just starts fresh.
  useEffect(() => {
    try {
      recencyRef.current.load(JSON.parse(localStorage.getItem(RECENCY_KEY) ?? "[]"));
    } catch {
      recencyRef.current.load([]);
    }
    setRecencyLoaded(true);
  }, []);

  useEffect(() => {
    const h = window.setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(h);
  }, [query]);

  // Fresh query + selection each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setDebounced("");
      setSel(0);
    }
  }, [open]);

  const dailyEnabled = configQ.data?.daily?.enabled !== false;
  // Folders whose schema declares [review] (§7.3): one folderSchema query
  // per folder, cached — the command exists only when the state does.
  const folderEntries = folders;
  const schemaQs = useQueries({
    queries: folderEntries.map((f) => ({
      queryKey: ["folder-schema", f.path],
      queryFn: () => folderSchema(f.path),
      staleTime: 30_000,
    })),
  });
  const reviewFolders = useMemo(
    () =>
      folderEntries
        .map((f, i) => (schemaQs[i].data?.review ? f.path : null))
        .filter((p): p is string => p !== null),
    [folderEntries, schemaQs],
  );
  // Saved query collections (spec §5 쿼리 열기) — shared ["bases"] cache.
  const basesQ = useQuery({ queryKey: ["bases"], queryFn: listBases });
  const commands = useMemo(
    () =>
      buildCommands({
        locale,
        noteView,
        theme,
        folders,
        tags: facets.data?.tags ?? [],
        dailyEnabled,
        dailyFolder: configQ.data?.daily?.folder,
        reviewFolders,
        // The installed 할 일 base has its own sidebar surface; the
        // palette lists only user queries.
        bases: (basesQ.data ?? []).filter((b) => b.path !== TASKS_BASE_PATH),
        callbacks,
      }),
    [locale, noteView, theme, folders, facets.data, dailyEnabled, configQ.data, reviewFolders, basesQ.data, callbacks],
  );

  const q = query.trim();
  const matched = useMemo(
    () => rankCommands(commands, q, recencyRef.current),
    [commands, q, recencyLoaded],
  );
  // Keyed separately from CardGrid's infinite ["search", q] cache — the
  // shapes differ and must never collide.
  const searchQ = useQuery({
    queryKey: ["palette-search", debounced],
    queryFn: () => searchMemos(debounced, NOTE_RESULTS_LIMIT),
    enabled: open && debounced.length > 0,
  });
  const recentNotes = recentsQ.data?.items ?? [];

  const rows = useMemo<Row[]>(() => {
    if (!q) {
      // Spec's killer path — "⌘K → ⏎ opens the most recent note" —
      // needs recents as the FIRST section; suggestions follow.
      const out: Row[] = [];
      if (recentNotes.length > 0) {
        out.push({ kind: "header", label: t.palette_section_recent_notes });
        for (const n of recentNotes.slice(0, RECENT_NOTES_SHOWN)) out.push({ kind: "note", note: n });
      }
      out.push({ kind: "header", label: t.palette_section_suggestions });
      for (const c of buildSuggestions(commands, recencyRef.current, SUGGESTION_LIMIT)) {
        out.push({ kind: "command", cmd: c });
      }
      if (out.length === 1) out.push({ kind: "empty", label: t.palette_no_results });
      return out;
    }
    const out: Row[] = [];
    if (matched.length > 0) {
      out.push({ kind: "header", label: t.palette_section_commands });
      for (const c of matched) out.push({ kind: "command", cmd: c });
    }
    if (searchQ.isError) {
      out.push({ kind: "header", label: t.palette_section_notes });
      out.push({ kind: "error", label: String(searchQ.error).split("\n")[0] });
    } else {
      const notes = searchQ.data ?? [];
      if (notes.length > 0) {
        out.push({ kind: "header", label: t.palette_section_notes });
        for (const n of notes) out.push({ kind: "note", note: n });
      }
    }
    // Bridge always present under a query — a transient query can always
    // graduate into the persistent header search.
    out.push({ kind: "bridge" });
    if (out.length === 1) out.unshift({ kind: "empty", label: t.palette_no_results });
    return out;
  }, [q, matched, searchQ.data, searchQ.isError, searchQ.error, recentNotes, commands, t, recencyLoaded]);

  // Explicit kind allowlist — an `error` row renders role=presentation
  // with no data-sel/click, so letting it into `selectable` would
  // show no highlight at its index and swallow Enter (activate() is a
  // no-op for it).
  const selectable = rows.filter((r) => r.kind === "command" || r.kind === "note" || r.kind === "bridge");
  // Clamp so Enter can never fire a stale index after the filter narrows.
  const selIdx = Math.min(sel, Math.max(0, selectable.length - 1));

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-sel="${selIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selIdx]);

  const activate = (row: Row) => {
    if (row.kind === "command") {
      recencyRef.current.record(row.cmd.id);
      try {
        localStorage.setItem(RECENCY_KEY, JSON.stringify(recencyRef.current.snapshot()));
      } catch {
        // Storage full/blocked — ranking just loses the boost.
      }
      onClose();
      void row.cmd.run();
    } else if (row.kind === "note") {
      onClose();
      setView("memos");
      select(row.note.id);
    } else if (row.kind === "bridge") {
      const qq = q;
      onClose();
      if (qq) onSearchAll(qq);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity duration-200 ease-out data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-20 z-50 w-[min(560px,92vw)] -translate-x-1/2 overflow-hidden rounded-[var(--dialog-radius)] border border-line bg-surface-raised shadow-lg transition-[opacity,translate,scale] duration-200 ease-out data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0">
          <Dialog.Title className="sr-only">{t.command_palette_title}</Dialog.Title>
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Search size={14} className="shrink-0 text-text-subtle" />
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- palette is a modal; focus must start in the input */}
            <input
              autoFocus
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls="command-palette-listbox"
              aria-autocomplete="list"
              aria-label={t.command_palette_title}
              placeholder={t.palette_placeholder}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSel(0);
              }}
              onKeyDown={(e) => {
                // Korean IME: confirm-Enter (and arrows during
                // composition) must not move/run anything.
                if (e.nativeEvent.isComposing) return;
                if (selectable.length === 0) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSel((s) => Math.min(s + 1, selectable.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel((s) => Math.max(s - 1, 0));
                } else if (e.key === "Home") {
                  e.preventDefault();
                  setSel(0);
                } else if (e.key === "End") {
                  e.preventDefault();
                  setSel(selectable.length - 1);
                } else if (e.key === "Enter") {
                  const r = selectable[selIdx];
                  if (r) {
                    e.preventDefault();
                    activate(r);
                  }
                }
              }}
              className="w-full bg-transparent py-1.5 text-sm placeholder:text-text-subtle outline-none"
            />
          </div>
          <ul
            id="command-palette-listbox"
            ref={listRef}
            role="listbox"
            aria-label={t.command_palette_title}
            className="max-h-[60vh] overflow-y-auto p-1"
          >
            {rows.map((row, i) => {
              if (row.kind === "header") {
                return (
                  <li
                    key={`h-${i}`}
                    role="presentation"
                    className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-text-subtle"
                  >
                    {row.label}
                  </li>
                );
              }
              if (row.kind === "empty") {
                return (
                  <li key={`e-${i}`} role="presentation" className="px-2 py-3 text-center text-[13px] text-text-subtle">
                    {row.label}
                  </li>
                );
              }
              if (row.kind === "error") {
                return (
                  <li key={`x-${i}`} role="presentation" className="px-2 py-2 text-center text-xs text-status-error">
                    {row.label}
                  </li>
                );
              }
              if (row.kind === "bridge") {
                const selNow = selectable.indexOf(row) === selIdx;
                return (
                  <li key="bridge">
                    <button
                      type="button"
                      role="option"
                      aria-selected={selNow}
                      data-sel={selectable.indexOf(row)}
                      onClick={() => activate(row)}
                      onMouseMove={() => setSel(selectable.indexOf(row))}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150 ${
                        selNow ? "bg-surface-muted text-text" : "text-text-muted hover:bg-surface-muted"
                      }`}
                    >
                      <Search size={14} className="shrink-0 text-text-muted" />
                      <span className="min-w-0 flex-1 truncate">
                        {t.palette_search_all.replace("{q}", q)}
                      </span>
                      {selNow && <CornerDownLeft size={12} aria-hidden className="shrink-0 text-text-subtle" />}
                    </button>
                  </li>
                );
              }
              if (row.kind === "note") {
                const idx = selectable.indexOf(row);
                const selNow = idx === selIdx;
                return (
                  <li key={row.note.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selNow}
                      data-sel={idx}
                      onClick={() => activate(row)}
                      onMouseMove={() => setSel(idx)}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150 ${
                        selNow ? "bg-surface-muted text-text" : "text-text-muted hover:bg-surface-muted"
                      }`}
                    >
                      <span
                        aria-hidden
                        className="inline-block size-2 shrink-0 rounded-full"
                        style={{ background: colorForFolder(row.note.folder, folderDefs) || "var(--color-text-subtle)" }}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {row.note.title ?? t.empty_memo}
                      </span>
                      <span className="ml-auto shrink-0 text-[11px] text-text-subtle">
                        {relativeTime(row.note.updated_at, locale)}
                      </span>
                      {selNow && <CornerDownLeft size={12} aria-hidden className="shrink-0 text-text-subtle" />}
                    </button>
                  </li>
                );
              }
              // row.kind === "command"
              const idx = selectable.indexOf(row);
              const selNow = idx === selIdx;
              const Icon = ICONS[row.cmd.icon];
              return (
                <li key={row.cmd.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selNow}
                    data-sel={idx}
                    onClick={() => activate(row)}
                    onMouseMove={() => setSel(idx)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150 ${
                      selNow ? "bg-surface-muted text-text" : "text-text-muted hover:bg-surface-muted"
                    }`}
                  >
                    <Icon size={14} className="shrink-0 text-text-muted" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{row.cmd.title}</span>
                    {row.cmd.hint ? (
                      <kbd className="ml-auto shrink-0 font-mono text-[10px] text-text-subtle">{row.cmd.hint}</kbd>
                    ) : row.cmd.count != null ? (
                      <span className="ml-auto shrink-0 text-[11px] tabular-nums text-text-subtle">{row.cmd.count}</span>
                    ) : null}
                    {selNow && <CornerDownLeft size={12} aria-hidden className="shrink-0 text-text-subtle" />}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-line px-3 py-1.5 text-[10px] text-text-subtle">
            {t.palette_footer_hint}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
