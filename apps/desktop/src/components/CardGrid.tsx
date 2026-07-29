/**
 * Card grid (§7.2–7.5): a virtualized, responsive multi-column grid of note
 * cards. Cursor-paged listing (with tag/pin filters) or BM25 search; the
 * title-bar header holds the search field, filter chips, and a theme toggle.
 * Selecting a card opens the NoteDetail editor; the grid refreshes on
 * `notes:changed` from the file watcher / other windows (§7.4).
 */
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Monitor, Moon, Pin, Plus, Search, Sun } from "lucide-react";

import { createNote, deleteNote, listNotes, searchNotes, updateNote } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { applyTheme } from "../lib/theme";
import { listen } from "../lib/tauri";
import { useUI } from "../stores/ui";
import type { NoteSummary } from "../lib/types";
import { Card } from "./Card";
import { NoteDetail } from "./NoteDetail";
import { SettingsMenu } from "./SettingsMenu";
import { StatusBar } from "./StatusBar";

const PAGE_SIZE = 50;
const MIN_COL_W = 240;
const CARD_H = 176; // matches Card's h-44 (§7.2 uniform height)
const ROW_GAP = 12;
const ROW_H = CARD_H + ROW_GAP;

export function CardGrid() {
  const { t } = useI18n();
  const search = useUI((s) => s.search);
  const setSearch = useUI((s) => s.setSearch);
  const select = useUI((s) => s.select);
  const activeTag = useUI((s) => s.activeTag);
  const setActiveTag = useUI((s) => s.setActiveTag);
  const pinnedOnly = useUI((s) => s.pinnedOnly);
  const setPinnedOnly = useUI((s) => s.setPinnedOnly);
  const theme = useUI((s) => s.theme);
  const setTheme = useUI((s) => s.setTheme);
  const setError = useUI((s) => s.setError);
  const setDraftId = useUI((s) => s.setDraftId);

  const [localSearch, setLocalSearch] = useState(search);
  const [debounced, setDebounced] = useState(search);
  const qc = useQueryClient();

  // 200ms debounce on the search field (§7.5).
  useEffect(() => {
    const h = window.setTimeout(() => setDebounced(localSearch), 200);
    return () => window.clearTimeout(h);
  }, [localSearch]);

  const listing = useInfiniteQuery({
    queryKey: ["notes", activeTag, pinnedOnly],
    queryFn: ({ pageParam }) => listNotes(pageParam, PAGE_SIZE, activeTag, pinnedOnly),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });

  const searching = useInfiniteQuery({
    queryKey: ["search", debounced],
    queryFn: () => searchNotes(debounced, 100),
    initialPageParam: null,
    getNextPageParam: () => null,
    enabled: debounced.length > 0,
  });

  const inSearch = debounced.length > 0;
  const items: NoteSummary[] = useMemo(() => {
    const base = inSearch
      ? searching.data?.pages.flat() ?? []
      : listing.data?.pages.flatMap((p) => p.items) ?? [];
    // Search results come from BM25 without the tag/pin filter; apply it
    // client-side so filters stay meaningful during a search.
    if (!inSearch) return base;
    return base.filter(
      (n) => (!activeTag || n.tags.includes(activeTag)) && (!pinnedOnly || n.pinned),
    );
  }, [inSearch, activeTag, pinnedOnly, listing.data, searching.data]);

  // Distinct tags across loaded notes, for the filter chips (§7.5).
  const tags = useMemo(() => {
    const all =
      listing.data?.pages.flatMap((p) => p.items.flatMap((n) => n.tags)) ?? [];
    return [...new Set(all)].sort();
  }, [listing.data]);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(1);

  // Responsive column count from the scroller width (§7.2 auto-fill grid).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () =>
      setCols(Math.max(1, Math.floor((el.clientWidth - 16) / MIN_COL_W)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rowCount = Math.ceil(items.length / cols);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => ROW_H,
    overscan: 4,
  });

  // Fetch the next listing page when the last row nears view.
  useEffect(() => {
    const last = virtualizer.getVirtualItems().at(-1);
    if (last && last.index >= rowCount - 2 && listing.hasNextPage) {
      void listing.fetchNextPage();
    }
  }, [virtualizer, rowCount, listing]);

  // Refresh when another window or the file watcher changes the vault (§7.4).
  useEffect(() => {
    let un: (() => void) | undefined;
    void listen("notes:changed", () => {
      qc.invalidateQueries({ queryKey: ["notes"] });
      qc.invalidateQueries({ queryKey: ["search"] });
    }).then((u) => {
      un = u;
    });
    return () => un?.();
  }, [qc]);

  // Reset scroll to top when the active filter changes, so a shorter filtered
  // list doesn't leave the viewport stuck at its old bottom offset.
  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
  }, [activeTag, pinnedOnly]);

  const onDelete = (id: string) => {
    void deleteNote(id)
      .then(() => {
        qc.invalidateQueries({ queryKey: ["notes"] });
        qc.invalidateQueries({ queryKey: ["search"] });
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  const onTogglePin = (id: string, pinned: boolean) => {
    void updateNote(id, null, null, !pinned, null)
      .then(() => {
        qc.invalidateQueries({ queryKey: ["notes"] });
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  const cycleTheme = () => {
    const next =
      theme === "system" ? "light" : theme === "light" ? "dark" : "system";
    setTheme(next);
    applyTheme(next);
  };
  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;

  const onNewNote = useCallback(() => {
    // Never re-seed over an open editor: the seed effect would clobber a
    // pending draft and cancel its autosave flush.
    if (useUI.getState().selectedId) return;
    void createNote("", [], null)
      .then((n) => {
        setDraftId(n.id);
        select(n.id);
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  }, [select, setDraftId, setError]);

  // ⌘N mints a new note in the editor (the capture window keeps ⌘⇧N).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        onNewNote();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNewNote]);

  return (
    <div className="flex h-full flex-col">
      <header
        data-tauri-drag-region
        className="flex h-12 items-center gap-3 border-b border-zinc-200 bg-white/80 px-4 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80"
      >
        <div className="relative w-64">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400"
          />
          <input
            type="text"
            value={localSearch}
            onChange={(e) => {
              setLocalSearch(e.target.value);
              setSearch(e.target.value);
            }}
            placeholder={t.search_placeholder}
            className="w-full rounded-full border border-zinc-200 bg-transparent py-1.5 pl-8 pr-3 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:focus:border-zinc-500"
          />
        </div>
        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setPinnedOnly(!pinnedOnly)}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] transition-colors ${
              pinnedOnly
                ? "bg-amber-100 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400"
                : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            <Pin size={11} /> {t.pinned}
          </button>
          {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                  activeTag === tag
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
                }`}
              >
                #{tag}
              </button>
            ))}
        </div>
        <button
          type="button"
          onClick={onNewNote}
          className="inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-all hover:bg-zinc-700 active:scale-95 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          <Plus size={13} strokeWidth={2.5} /> {t.new_note}
        </button>
        <SettingsMenu />
        <button
          type="button"
          onClick={cycleTheme}
          aria-label="theme"
          className="rounded-full p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          <ThemeIcon size={15} />
        </button>
      </header>
      <div ref={scrollerRef} className="flex-1 overflow-y-auto p-2">
        {items.length === 0 ? (
          <div className="mt-24 flex flex-col items-center gap-4 text-center">
            <p className="text-sm text-zinc-400">{t.empty_hint}</p>
            <button
              type="button"
              onClick={onNewNote}
              className="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-zinc-700 active:scale-95 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              <Plus size={15} strokeWidth={2.5} /> {t.empty_cta}
            </button>
          </div>
        ) : (
          <div
            style={{ height: virtualizer.getTotalSize() }}
            className="relative w-full"
          >
            {virtualizer.getVirtualItems().map((v) => {
              const start = v.index * cols;
              const row = items.slice(start, start + cols);
              return (
                <div
                  key={v.key}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    transform: `translateY(${v.start}px)`,
                    width: "100%",
                  }}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                      gridAutoRows: `${CARD_H}px`,
                      gap: `${ROW_GAP}px`,
                    }}
                  >
                    {row.map((n) => (
                      <Card
                        key={n.id}
                        note={n}
                        onSelect={select}
                        onTogglePin={(id) => onTogglePin(id, n.pinned)}
                        onDelete={onDelete}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <NoteDetail />
      <StatusBar />
    </div>
  );
}
