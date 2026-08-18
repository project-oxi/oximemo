/**
 * Card grid (§7.2–7.5): a virtualized, responsive multi-column grid of memo
 * cards. Cursor-paged listing (with composite tag/folder filters) or BM25
 * search; the title-bar header holds the search field, new-memo button, and a
 * theme toggle. A collapsible left Sidebar owns navigation + filtering.
 * Selecting a card opens the MemoDetail editor; the grid refreshes on
 * `memos:changed` from the file watcher / other windows (§7.4).
 */
import { useInfiniteQuery, useQueryClient, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeft, PanelLeftClose, Plus, Search } from "lucide-react";

import {
  createMemo,
  deleteMemo,
  getMemo,
  getConfig,
  listFolders,
  listMemos,
  memoStats,
  searchMemos,
  setFolderView,
  updateMemo,
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { listen } from "../lib/tauri";
import { useUI } from "../stores/ui";
import type { MemoSummary, ViewMode } from "../lib/types";

import { MemoDetail } from "./MemoDetail";

import { Sidebar } from "./Sidebar";
import { GalleryView } from "./GalleryView";
import { SettingsMenu } from "./SettingsMenu";
import { GridView } from "./views/GridView";
import { ListView } from "./views/ListView";
import { TimelineView } from "./views/TimelineView";
import { GraphView } from "./views/GraphView";
const PAGE_SIZE = 50;
const MIN_COL_W = 240;
const CARD_H = 176;
const ROW_GAP = 12;
const ROW_H = CARD_H + ROW_GAP;

export function CardGrid() {
  const { t } = useI18n();
  const search = useUI((s) => s.search);
  const setSearch = useUI((s) => s.setSearch);
  const select = useUI((s) => s.select);
  const tagFilter = useUI((s) => s.tagFilter);
  const matchAll = useUI((s) => s.matchAll);
  const folderFilter = useUI((s) => s.folderFilter);
  const favoritesOnly = useUI((s) => s.favoritesOnly);
  const sidebarCollapsed = useUI((s) => s.sidebarCollapsed);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const setError = useUI((s) => s.setError);
  const setToast = useUI((s) => s.setToast);
  const setDraftId = useUI((s) => s.setDraftId);
  const clearTagFilter = useUI((s) => s.clearTagFilter);
  const setFolderFilter = useUI((s) => s.setFolderFilter);
  const setFavoritesOnly = useUI((s) => s.setFavoritesOnly);
  const view = useUI((s) => s.view);
  const noteView = useUI((s) => s.noteView);
  const setNoteView = useUI((s) => s.setNoteView);
  const stats = useQuery({ queryKey: ["stats"], queryFn: memoStats });
  const hasMemos = (stats.data?.memos ?? 0) > 0;
  const clearAllFilters = () => {
    clearTagFilter();
    setFolderFilter(null);
    setFavoritesOnly(false);
  };

  const configQ = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const foldersQ = useQuery({ queryKey: ["folders"], queryFn: listFolders });
  const folderEntries = foldersQ.data ?? [];

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

  useEffect(() => {
    const h = window.setTimeout(() => setDebounced(localSearch), 200);
    return () => window.clearTimeout(h);
  }, [localSearch]);

  // Sync locked view from config when the folder filter changes.
  useEffect(() => {
    const def = configQ.data?.folders?.find((f) => f.path === (folderFilter ?? ""));
    if (def?.view) setNoteView(def.view);
  }, [folderFilter, configQ.data, setNoteView]);

  const setNoteViewLocked = useCallback(
    (v: ViewMode) => {
      setNoteView(v);
      if (folderFilter !== null) {
        void setFolderView(folderFilter, v)
          .then(() => qc.invalidateQueries({ queryKey: ["config"] }))
          .catch((e) => setToast(String(e).split("\n")[0]));
      } else {
        // Unlock: store null on the "" (root) entry so the global default
        // takes over. The Rust side treats null as "unlock".
        void setFolderView("", v)
          .then(() => qc.invalidateQueries({ queryKey: ["config"] }))
          .catch((e) => setToast(String(e).split("\n")[0]));
      }
    },
    [folderFilter, qc, setNoteView, setToast],
  );

  const listing = useInfiniteQuery({
    queryKey: ["memos", includeTags, excludeTags, matchAll, folderFilter, favoritesOnly],
    queryFn: ({ pageParam }) =>
      listMemos(pageParam, PAGE_SIZE, {
        include_tags: includeTags,
        exclude_tags: excludeTags,
        match_all: matchAll,
        folder: folderFilter,
        favorites_only: favoritesOnly,
      }),
    initialPageParam: null as string | null,
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
    if (!inSearch) return base;
    return base.filter((n) => {
      if (favoritesOnly && !n.favorite) return false;
      if (folderFilter !== null && folderFilter !== undefined && n.folder !== folderFilter) return false;
      if (excludeTags.some((tag) => n.tags.includes(tag))) return false;
      if (includeTags.length) {
        const ok = matchAll
          ? includeTags.every((tag) => n.tags.includes(tag))
          : includeTags.some((tag) => n.tags.includes(tag));
        if (!ok) return false;
      }
      return true;
    });
  }, [inSearch, includeTags, excludeTags, matchAll, folderFilter, favoritesOnly, listing.data, searching.data]);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(1);

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

  useEffect(() => {
    const last = virtualizer.getVirtualItems().at(-1);
    if (last && last.index >= rowCount - 2 && listing.hasNextPage) {
      void listing.fetchNextPage();
    }
  }, [virtualizer, rowCount, listing]);

  useEffect(() => {
    let un: (() => void) | undefined;
    void listen("memos:changed", () => {
      qc.invalidateQueries({ queryKey: ["memos"] });
      qc.invalidateQueries({ queryKey: ["search"] });
      qc.invalidateQueries({ queryKey: ["facets"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      qc.invalidateQueries({ queryKey: ["folders"] });
      qc.invalidateQueries({ queryKey: ["config"] });
    }).then((u) => {
      un = u;
    });
    return () => un?.();
  }, [qc]);

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
  }, [includeTags, excludeTags, folderFilter, favoritesOnly, matchAll, noteView]);

  const onDelete = (id: string) => {
    void deleteMemo(id)
      .then(() => {
        qc.invalidateQueries({ queryKey: ["memos"] });
        qc.invalidateQueries({ queryKey: ["search"] });
        qc.invalidateQueries({ queryKey: ["facets"] });
        qc.invalidateQueries({ queryKey: ["folders"] });
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  const onToggleFavorite = (id: string, favorite: boolean) => {
    void updateMemo(id, null, !favorite)
      .then(() => {
        qc.invalidateQueries({ queryKey: ["memos"] });
        qc.invalidateQueries({ queryKey: ["facets"] });
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  const onMoveFolder = (id: string, folder: string) => {
    void updateMemo(id, null, null)
      .then(() => {
        // Folder moves go through a separate command surface; the core
        // renames the file and updates the index. Until that lands, we
        // invalidate so the user sees the move reflected via the watcher.
        qc.invalidateQueries({ queryKey: ["memos"] });
        qc.invalidateQueries({ queryKey: ["facets"] });
        qc.invalidateQueries({ queryKey: ["folders"] });
        setToast(`→ ${folder || "(root)"}`);
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  const onCopyBody = (id: string) => {
    void getMemo(id)
      .then((m) => navigator.clipboard.writeText(m.body))
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  const onNewNote = useCallback(
    (format?: "markdown" | "html") => {
      if (useUI.getState().selectedId) return;
      void createMemo("", folderFilter, format)
        .then((n) => {
          setDraftId(n.id);
          select(n.id);
          qc.invalidateQueries({ queryKey: ["memos"] });
          qc.invalidateQueries({ queryKey: ["facets"] });
          qc.invalidateQueries({ queryKey: ["folders"] });
        })
        .catch((e) => setError(String(e).split("\n")[0]));
    },
    [folderFilter, select, setDraftId, setError, qc],
  );

  const onNewHtmlNote = useCallback(() => onNewNote("html"), [onNewNote]);

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

  const sidebarToggle = (
    <div className="fixed left-[82px] top-0 z-30 flex h-12 items-center">
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={sidebarCollapsed ? t.show_sidebar : t.hide_sidebar}
        className="rounded-md p-1.5 text-text-subtle transition-colors hover:bg-surface-muted hover:text-text"
      >
        {sidebarCollapsed ? <PanelLeft size={15} /> : <PanelLeftClose size={15} />}
      </button>
    </div>
  );

  const folders = configQ.data?.folders ?? [];
  const isLocked = folderFilter !== null
    ? !!folders.find((f) => f.path === folderFilter)?.view
    : !!folders.find((f) => f.path === "")?.view;

  const viewSwitcher = (
    <div
      role="group"
      aria-label="View mode"
      className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-raised/70 p-0.5 text-xs"
    >
      {(["grid", "list", "timeline", "graph"] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => setNoteViewLocked(v)}
          className={`rounded-full px-2.5 py-1 capitalize transition-colors ${
            noteView === v
              ? "bg-interactive-primary text-interactive-primary-foreground"
              : "text-text-subtle hover:bg-surface-muted hover:text-text"
          }`}
          aria-pressed={noteView === v}
        >
          {v}
        </button>
      ))}
      <button
        type="button"
        onClick={() => {
          if (folderFilter !== null) {
            void setFolderView(folderFilter, null)
              .then(() => qc.invalidateQueries({ queryKey: ["config"] }))
              .catch((e) => setToast(String(e).split("\n")[0]));
          } else {
            void setFolderView("", null)
              .then(() => qc.invalidateQueries({ queryKey: ["config"] }))
              .catch((e) => setToast(String(e).split("\n")[0]));
          }
        }}
        title={isLocked ? "Locked view (click to unlock)" : "Unlocked"}
        className={`rounded-full px-2 py-1 text-[10px] font-bold transition-colors ${
          isLocked
            ? "bg-hue-amber/20 text-hue-amber"
            : "text-text-subtle hover:bg-surface-muted hover:text-text"
        }`}
      >
        {isLocked ? "[LOCK]" : "[UNLOCK]"}
      </button>
    </div>
  );

  if (view === "gallery") {
    return (
      <div className="flex h-full">
        {sidebarToggle}
        {!sidebarCollapsed && <Sidebar />}
        <div className="flex min-w-0 flex-1 flex-col">
          <GalleryView />
        </div>
        <MemoDetail />
      </div>
    );
  }

  // Pick the view component for the current noteView.
  const viewProps = {
    items,
    folders,
    folderEntries,
    onSelect: select,
    onToggleFavorite: onToggleFavorite,
    onMoveFolder,
    onCopyBody,
    onDelete,
    onNewNote,
  };

  return (
    <div className="flex h-full">
      {sidebarToggle}
      {!sidebarCollapsed && <Sidebar />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          data-tauri-drag-region="deep"
          className="flex h-12 items-center gap-3 border-b border-line bg-surface-raised/80 pl-4 pr-4 backdrop-blur"
        >
          <div className="flex-1" />
          {viewSwitcher}
          <div className="relative w-56">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" />
            <input
              type="text"
              value={localSearch}
              onChange={(e) => {
                setLocalSearch(e.target.value);
                setSearch(e.target.value);
              }}
              placeholder={t.search_placeholder}
              className="w-full rounded-full bg-transparent py-1.5 pl-8 pr-3 text-sm placeholder:text-text-subtle shadow-[var(--input-shadow)] focus-visible:shadow-[var(--input-shadow-focus)] focus-visible:outline-none"
            />
          </div>
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => onNewNote()}
              aria-label={t.new_memo}
              title={t.new_note_md}
              className="inline-flex h-7 w-7 items-center justify-center rounded-l-full bg-interactive-primary text-interactive-primary-foreground shadow-sm transition-all hover:bg-interactive-primary/90 active:scale-95"
            >
              <Plus size={15} strokeWidth={2.5} />
            </button>
            <button
              type="button"
              onClick={onNewHtmlNote}
              aria-label={t.new_note_html}
              title={t.new_note_html}
              className="ml-px inline-flex h-7 items-center justify-center rounded-r-full border-l border-interactive-primary/40 bg-interactive-primary px-1.5 font-mono text-[10px] font-semibold tracking-wider text-interactive-primary-foreground shadow-sm transition-all hover:bg-interactive-primary/90 active:scale-95"
            >
              HTML
            </button>
          </div>
          <SettingsMenu />
        </header>
        <div ref={scrollerRef} className="flex-1 overflow-y-auto p-2">
          {listing.isError ? (
            <div className="mt-24 flex flex-col items-center gap-3 px-6 text-center">
              <p className="text-sm font-medium text-status-error">{t.load_error}</p>
              <p className="max-w-md break-words text-xs text-text-subtle">{String(listing.error)}</p>
              <button
                type="button"
                onClick={() => listing.refetch()}
                className="mt-1 inline-flex items-center gap-2 rounded-full bg-interactive-primary px-4 py-2 text-sm font-medium text-interactive-primary-foreground shadow-sm transition-all hover:bg-interactive-primary/90 active:scale-95"
              >
                {t.retry}
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="mt-24 flex flex-col items-center gap-4 text-center">
              <p className="text-sm text-text-subtle">{hasMemos ? t.no_match_hint : t.empty_hint}</p>
              {hasMemos ? (
                <button
                  type="button"
                  onClick={clearAllFilters}
                  className="inline-flex items-center gap-2 rounded-full bg-interactive-primary px-4 py-2 text-sm font-medium text-interactive-primary-foreground shadow-sm transition-all hover:bg-interactive-primary/90 active:scale-95"
                >
                  {t.clear_filters}
                </button>
              ) : (
                <button
                  type="button"
            onClick={() => onNewNote()}
                  className="inline-flex items-center gap-2 rounded-full bg-interactive-primary px-4 py-2 text-sm font-medium text-interactive-primary-foreground shadow-sm transition-all hover:bg-interactive-primary/90 active:scale-95"
                >
                  <Plus size={15} strokeWidth={2.5} /> {t.empty_cta}
                </button>
              )}
            </div>
          ) : noteView === "grid" ? (
            <GridView
              items={items}
              virtualizer={virtualizer}
              cols={cols}
              folders={folders}
              folderEntries={folderEntries}
              onSelect={select}
              onToggleFavorite={onToggleFavorite}
              onMoveFolder={onMoveFolder}
              onCopyBody={onCopyBody}
              onDelete={onDelete}
            />
          ) : noteView === "list" ? (
            <ListView {...viewProps} />
          ) : noteView === "timeline" ? (
            <TimelineView {...viewProps} />
          ) : (
            <GraphView />
          )}
        </div>
      </div>
      <MemoDetail />
    </div>
  );
}