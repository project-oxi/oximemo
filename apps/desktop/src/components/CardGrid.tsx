/**
 * Card grid (§7.2–7.5): a virtualized, responsive multi-column grid of memo
 * cards. Cursor-paged listing (with composite tag/color filters) or BM25
 * search; the title-bar header holds the search field, new-memo button, and a
 * theme toggle. A collapsible left Sidebar owns navigation + filtering.
 * Selecting a card opens the MemoDetail editor; the grid refreshes on
 * `memos:changed` from the file watcher / other windows (§7.4).
 */
import { useInfiniteQuery, useQueryClient, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeft, Plus, Search } from "lucide-react";

import { createMemo, deleteMemo, getMemo, listMemos, memoStats, searchMemos, updateMemo, listCategories } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { listen } from "../lib/tauri";
import { useUI } from "../stores/ui";
import type { MemoSummary } from "../lib/types";
import { Card } from "./Card";
import { MemoDetail } from "./MemoDetail";
import { SettingsMenu } from "./SettingsMenu";
import { Sidebar } from "./Sidebar";

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
  const tagFilter = useUI((s) => s.tagFilter);
  const matchAll = useUI((s) => s.matchAll);
  const categoryFilter = useUI((s) => s.categoryFilter);
  const pinnedOnly = useUI((s) => s.pinnedOnly);
  const sidebarCollapsed = useUI((s) => s.sidebarCollapsed);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const setError = useUI((s) => s.setError);
  const setDraftId = useUI((s) => s.setDraftId);
  const clearTagFilter = useUI((s) => s.clearTagFilter);
  const setCategory = useUI((s) => s.setCategory);
  const setPinnedOnly = useUI((s) => s.setPinnedOnly);
  const stats = useQuery({ queryKey: ["stats"], queryFn: memoStats });
  const hasMemos = (stats.data?.memos ?? 0) > 0;
  const clearAllFilters = () => {
    clearTagFilter();
    setCategory(null);
    setPinnedOnly(false);
  };

  const categoriesQ = useQuery({ queryKey: ["categories"], queryFn: listCategories });
  const catDefs = categoriesQ.data ?? [];

  // Composite filter derived from the sidebar's 3-state tag chips.
  const includeTags = useMemo(
    () => Object.entries(tagFilter).filter(([, s]) => s === "in").map(([t]) => t),
    [tagFilter],
  );
  const excludeTags = useMemo(
    () => Object.entries(tagFilter).filter(([, s]) => s === "out").map(([t]) => t),
    [tagFilter],
  );

  const [localSearch, setLocalSearch] = useState(search);
  const [debounced, setDebounced] = useState(search);
  const qc = useQueryClient();

  // 200ms debounce on the search field (§7.5).
  useEffect(() => {
    const h = window.setTimeout(() => setDebounced(localSearch), 200);
    return () => window.clearTimeout(h);
  }, [localSearch]);

  const listing = useInfiniteQuery({
    queryKey: ["memos", includeTags, excludeTags, matchAll, categoryFilter, pinnedOnly],
    queryFn: ({ pageParam }) =>
      listMemos(pageParam, PAGE_SIZE, {
        include_tags: includeTags,
        exclude_tags: excludeTags,
        match_all: matchAll,
        categories: categoryFilter ? [categoryFilter] : [],
        pinned_only: pinnedOnly,
      }),
    initialPageParam: null as string | null,
    // §8: capture→main refresh — the cross-window `memos:changed` event is
    // unreliable; refetch on focus so a freshly-captured memo surfaces when
    // the capture overlay hides and the main window regains focus.
    refetchOnWindowFocus: true,
    getNextPageParam: (last) => last.next_cursor,
  });

  const searching = useInfiniteQuery({
    queryKey: ["search", debounced],
    queryFn: () => searchMemos(debounced, 100),
    initialPageParam: null,
    getNextPageParam: () => null,
    enabled: debounced.length > 0,
  });

  const inSearch = debounced.length > 0;
  const items: MemoSummary[] = useMemo(() => {
    const base = inSearch
      ? searching.data?.pages.flat() ?? []
      : listing.data?.pages.flatMap((p) => p.items) ?? [];
    // Search results come from BM25 without the composite filter; apply it
    // client-side so filters stay meaningful during a search.
    if (!inSearch) return base;
    return base.filter((n) => {
      if (pinnedOnly && !n.pinned) return false;
      if (categoryFilter && n.category !== categoryFilter) return false;
      if (excludeTags.some((tag) => n.tags.includes(tag))) return false;
      if (includeTags.length) {
        const ok = matchAll
          ? includeTags.every((tag) => n.tags.includes(tag))
          : includeTags.some((tag) => n.tags.includes(tag));
        if (!ok) return false;
      }
      return true;
    });
  }, [inSearch, includeTags, excludeTags, matchAll, categoryFilter, pinnedOnly, listing.data, searching.data]);

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
    void listen("memos:changed", () => {
      qc.invalidateQueries({ queryKey: ["memos"] });
      qc.invalidateQueries({ queryKey: ["search"] });
      qc.invalidateQueries({ queryKey: ["facets"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
    }).then((u) => {
      un = u;
    });
    return () => un?.();
  }, [qc]);

  // Reset scroll to top when the active filter changes.
  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
  }, [includeTags, excludeTags, categoryFilter, pinnedOnly, matchAll]);

  const onDelete = (id: string) => {
    void deleteMemo(id)
      .then(() => {
        qc.invalidateQueries({ queryKey: ["memos"] });
        qc.invalidateQueries({ queryKey: ["search"] });
        qc.invalidateQueries({ queryKey: ["facets"] });
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  const onTogglePin = (id: string, pinned: boolean) => {
    void updateMemo(id, null, !pinned, null)
      .then(() => {
        qc.invalidateQueries({ queryKey: ["memos"] });
        qc.invalidateQueries({ queryKey: ["facets"] });
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  const onMoveCategory = (id: string, category: string) => {
    void updateMemo(id, null, null, category)
      .then(() => {
        qc.invalidateQueries({ queryKey: ["memos"] });
        qc.invalidateQueries({ queryKey: ["facets"] });
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  const onCopyBody = (id: string) => {
    void getMemo(id)
      .then((m) => navigator.clipboard.writeText(m.body))
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  const onNewNote = useCallback(() => {
    // Never re-seed over an open editor: the seed effect would clobber a
    // pending draft and cancel its autosave flush.
    if (useUI.getState().selectedId) return;
    void createMemo("", null)
      .then((n) => {
        setDraftId(n.id);
        select(n.id);
        // Refresh the grid directly. `create_note` emits `memos:changed`, but
        // that event has proven an unreliable refresh channel in this app —
        // invalidate here like delete/pin do so a new memo always surfaces.
        qc.invalidateQueries({ queryKey: ["memos"] });
        qc.invalidateQueries({ queryKey: ["facets"] });
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  }, [select, setDraftId, setError, qc]);

  // ⌘N mints a new memo in the editor (the capture window keeps ⌘⇧N).
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
    <div className="flex h-full">
      {!sidebarCollapsed && <Sidebar />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          data-tauri-drag-region="deep"
          className={`flex h-12 items-center gap-3 border-b border-zinc-200 bg-white/80 pr-4 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80 ${
            sidebarCollapsed ? "pl-[76px]" : "pl-4"
          }`}
        >
          {sidebarCollapsed && (
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={t.show_sidebar}
              className="rounded-full p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <PanelLeft size={15} />
            </button>
          )}
          <div className="flex-1" />
          <div className="relative w-56">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
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
          <button
            type="button"
            onClick={onNewNote}
            aria-label={t.new_memo}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white shadow-sm transition-all hover:bg-zinc-700 active:scale-95 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            <Plus size={15} strokeWidth={2.5} />
          </button>
          <SettingsMenu />
        </header>
        <div ref={scrollerRef} className="flex-1 overflow-y-auto p-2">
          {listing.isError ? (
            <div className="mt-24 flex flex-col items-center gap-3 px-6 text-center">
              <p className="text-sm font-medium text-red-500">{t.load_error}</p>
              <p className="max-w-md break-words text-xs text-zinc-400">{String(listing.error)}</p>
              <button
                type="button"
                onClick={() => listing.refetch()}
                className="mt-1 inline-flex items-center gap-2 rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-zinc-700 active:scale-95 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                {t.retry}
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="mt-24 flex flex-col items-center gap-4 text-center">
              <p className="text-sm text-zinc-400">{hasMemos ? t.no_match_hint : t.empty_hint}</p>
              {hasMemos ? (
                <button
                  type="button"
                  onClick={clearAllFilters}
                  className="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-zinc-700 active:scale-95 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                >
                  {t.clear_filters}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onNewNote}
                  className="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-zinc-700 active:scale-95 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                >
                  <Plus size={15} strokeWidth={2.5} /> {t.empty_cta}
                </button>
              )}
            </div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize() }} className="relative w-full">
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
                          memo={n}
                          categories={catDefs}
                          onSelect={select}
                          onTogglePin={(id) => onTogglePin(id, n.pinned)}
                          onMoveCategory={onMoveCategory}
                          onCopyBody={onCopyBody}
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
      </div>
      <MemoDetail />
    </div>
  );
}
