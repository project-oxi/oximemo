/**
 * Card grid (§7.2–7.5): a virtualized, responsive multi-column grid of memo
 * cards. Cursor-paged listing (with composite tag/folder filters) or BM25
 * search; the title-bar header holds the BreadcrumbBar (location), the
 * search field, view-mode switcher, new-memo split button, and a theme
 * toggle. A collapsible left Sidebar owns navigation + filtering. Selecting
 * a card opens the MemoDetail editor; the grid refreshes on `memos:changed`
 * from the file watcher / other windows (§7.4).
 */
import { useInfiniteQuery, useQueryClient, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Clock,
  LayoutGrid,
  List,
  Lock,
  LockOpen,
  Network,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Search,
} from "lucide-react";

import {
  createMemo,
  deleteMemo,
  folderChildren,
  getMemo,
  getConfig,
  listFolders,
  listMemos,
  memoStats,
  moveNote,
  searchMemos,
  setFolderView,
  updateMemo,
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { listen } from "../lib/tauri";
import { useUI, loadQueryView } from "../stores/ui";
import type { FolderCard, MemoSummary, ViewMode } from "../lib/types";

import { MemoDetail } from "./MemoDetail";

import { Sidebar } from "./Sidebar";
import { GalleryView } from "./GalleryView";
import { SettingsMenu } from "./SettingsMenu";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { GridView, type Cell } from "./views/GridView";
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

  // Sync locked view from config when the folder filter changes. In query
  // mode (folderFilter === null) there is no per-folder pin — restore the
  // view from the persisted localStorage slot instead.
  useEffect(() => {
    if (folderFilter === null) {
      setNoteView(loadQueryView());
      return;
    }
    const def = configQ.data?.folders?.find((f) => f.path === folderFilter);
    if (def?.view) setNoteView(def.view);
  }, [folderFilter, configQ.data, setNoteView]);

  const setNoteViewLocked = useCallback(
    (v: ViewMode) => {
      setNoteView(v);
      if (folderFilter === null) {
        // Query mode: persistence already happened in setNoteView (localStorage
        // oximemo.queryView). No per-folder pin exists for the smart
        // collection, so skip the IPC roundtrip entirely.
        return;
      }
      void setFolderView(folderFilter, v)
        .then(() => qc.invalidateQueries({ queryKey: ["config"] }))
        .catch((e) => setToast(String(e).split("\n")[0]));
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
        immediate: folderFilter !== null,
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
  }, [inSearch, includeTags, excludeTags, folderFilter, favoritesOnly, listing.data, searching.data]);

  // Direct-children folder tiles for the current browse level. We rely on
  // browse-by-default semantics (T5): folderFilter !== null ⇒ show this
  // folder's subfolders as content-peek tiles above its notes. In query
  // mode (folderFilter === null) and during search the tile layer is
  // suppressed — search results are flat, no folder chrome.
  const browseFoldersQ = useQuery({
    queryKey: ["folderChildren", folderFilter],
    queryFn: () => folderChildren(folderFilter ?? ""),
    enabled:
      folderFilter !== null &&
      !inSearch &&
      (noteView === "grid" || noteView === "list"),
  });

  // TanStack Query keeps `data` populated even after `enabled` flips false,
  // so we have to gate the tile layer with the same predicate ourselves —
  // otherwise folder tiles leak into search results and contradict the
  // comment above. Brief-spec deps: [browseFoldersQ.data, items]; the
  // boolean predicate is constant for the lifetime of this render pass
  // because the views below either keep or discard the tile layer.
  const showFolders =
    folderFilter !== null &&
    !inSearch &&
    (noteView === "grid" || noteView === "list");
  const cells = useMemo<Cell[]>(() => {
    const folderCards = showFolders ? browseFoldersQ.data ?? [] : [];
    const folderCells: Cell[] = folderCards.map((card) => ({
      kind: "folder" as const,
      card,
    }));
    const noteCells: Cell[] = items.map((note) => ({ kind: "note" as const, note }));
    return [...folderCells, ...noteCells];
  }, [browseFoldersQ.data, items, showFolders]);
  const folderCards: FolderCard[] = showFolders ? browseFoldersQ.data ?? [] : [];

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const scrollerRoRef = useRef<ResizeObserver | null>(null);
  const [cols, setCols] = useState(1);

  // Callback ref (not a plain ref + effect): the scroller <div> unmounts and
  // remounts whenever `view` toggles to/from gallery, which would otherwise
  // leave the ResizeObserver watching a detached node forever — permanently
  // freezing `cols` at whatever it read on that unmount (often 0 → cols=1,
  // i.e. grid view stuck rendering as a single vertical column).
  const scrollerCallbackRef = useCallback((el: HTMLDivElement | null) => {
    scrollerRef.current = el;
    scrollerRoRef.current?.disconnect();
    scrollerRoRef.current = null;
    if (!el) return;
    const update = () => setCols(Math.max(1, Math.floor((el.clientWidth - 16) / MIN_COL_W)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    scrollerRoRef.current = ro;
  }, []);

  const rowCount = Math.ceil(cells.length / cols);
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
      qc.invalidateQueries({ queryKey: ["folderChildren"] });
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
    void moveNote(id, folder)
      .then(() => {
        qc.invalidateQueries({ queryKey: ["memos"] });
        qc.invalidateQueries({ queryKey: ["search"] });
        qc.invalidateQueries({ queryKey: ["facets"] });
        qc.invalidateQueries({ queryKey: ["folders"] });
        setToast(`→ ${folder || t.folder_root}`);
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

  // Create a new memo in a specific folder (used by FolderTile's empty-state
  // "+ MD note" button — the tile lives next to its parent folder in the
  // browse tree, so we want to anchor the draft inside that folder rather
  // than the currently-viewed one).
  const onNewNoteIn = useCallback(
    (folder: string) => {
      if (useUI.getState().selectedId) return;
      void createMemo("", folder)
        .then((n) => {
          setDraftId(n.id);
          select(n.id);
          qc.invalidateQueries({ queryKey: ["memos"] });
          qc.invalidateQueries({ queryKey: ["facets"] });
          qc.invalidateQueries({ queryKey: ["folders"] });
          qc.invalidateQueries({ queryKey: ["folderChildren"] });
        })
        .catch((e) => setError(String(e).split("\n")[0]));
    },
    [select, setDraftId, setError, qc],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘N / CtrlN — new note in current folder.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        onNewNote();
        return;
      }
      // ⌘↑ / Ctrl↑ — navigate up one folder (no-op in query mode or at root).
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        useUI.getState().navigateUp();
        return;
      }
      // Escape — clear the current search box only. Does NOT navigate; the
      // dialog/capture handlers below manage their own Escape behaviour.
      if (e.key === "Escape") {
        if (useUI.getState().selectedId) return;
        if (localSearch === "") return;
        e.preventDefault();
        setLocalSearch("");
        setDebounced("");
        setSearch("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNewNote, localSearch, setSearch]);

  // Sidebar toggle is the first inline element of the header now (see
  // <header> below). The wrapper provides the pl-1 inset and h-12 height so
  // it aligns with sibling content.
  const sidebarToggle = (
    <div className="flex h-12 shrink-0 items-center pl-1">
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={sidebarCollapsed ? t.show_sidebar : t.hide_sidebar}
        className="rounded-[var(--button-radius)] p-1.5 text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text"
      >
        {sidebarCollapsed ? <PanelLeft size={15} /> : <PanelLeftClose size={15} />}
      </button>
    </div>
  );

  const folders = configQ.data?.folders ?? [];
  // The lock only applies to per-folder pins; the query-mode smart
  // collection does not have a backend pin to read.
  const isLocked =
    folderFilter !== null &&
    !!folders.find((f) => f.path === folderFilter)?.view;

  const viewSwitcher = (
    <div
      role="group"
      aria-label="View mode"
      className="inline-flex items-center gap-0.5 text-xs"
    >
      {([
        { v: "grid", Icon: LayoutGrid },
        { v: "list", Icon: List },
        { v: "timeline", Icon: Clock },
        { v: "graph", Icon: Network },
      ] as const).map(({ v, Icon }) => (
        <button
          key={v}
          type="button"
          onClick={() => setNoteViewLocked(v)}
          title={v}
          aria-label={v}
          className={`inline-flex h-6 w-6 items-center justify-center rounded-[var(--tag-radius)] transition-colors duration-150 ${
            noteView === v
              ? "bg-surface-muted text-text"
              : "text-text-subtle hover:bg-surface-muted hover:text-text"
          }`}
          aria-pressed={noteView === v}
        >
          <Icon size={13} strokeWidth={2} />
        </button>
      ))}
      {folderFilter !== null && (
        <button
          type="button"
          onClick={() => {
            void setFolderView(folderFilter, null)
              .then(() => qc.invalidateQueries({ queryKey: ["config"] }))
              .catch((e) => setToast(String(e).split("\n")[0]));
          }}
          title={isLocked ? t.view_pin_locked : t.view_pin_unlocked}
          aria-label={isLocked ? t.view_pin_locked : t.view_pin_unlocked}
          aria-pressed={isLocked}
          className={`ml-1 inline-flex h-6 w-6 items-center justify-center rounded-[var(--tag-radius)] transition-colors duration-150 ${
            isLocked
              ? "text-hue-amber hover:bg-hue-amber/15"
              : "text-text-subtle hover:bg-surface-muted hover:text-text"
          }`}
        >
          {isLocked ? <Lock size={11} /> : <LockOpen size={11} />}
        </button>
      )}
    </div>
  );

  if (view === "gallery") {
    return (
      <div className="flex h-full">
        {!sidebarCollapsed && <Sidebar />}
        <div className="flex min-w-0 flex-1 flex-col">
          <GalleryView />
        </div>
        <MemoDetail />
      </div>
    );
  }

  // Pick the view component for the current noteView.
  // ListView needs both the folder registry (for color) and the live
  // folderChildren cards (to render folder rows above note rows). Pass
  // them through explicitly so the flat viewProps type stays simple.
  const viewProps = {
    items,
    folders,
    folderEntries,
    folderCards,
    onOpenFolder: setFolderFilter,
    onSelect: select,
    onToggleFavorite: onToggleFavorite,
    onMoveFolder,
    onCopyBody,
    onDelete,
    onNewNote,
  };

  return (
    <div className="flex h-full">
      {!sidebarCollapsed && <Sidebar />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          data-tauri-drag-region="deep"
          className="flex h-12 items-center gap-3 border-b border-line pr-4"
        >
          {sidebarToggle}
          <BreadcrumbBar folders={folderEntries} folderDefs={folders} />
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
              className="w-full rounded-[var(--input-radius)] bg-transparent py-1.5 pl-8 pr-3 text-sm placeholder:text-text-subtle shadow-[var(--input-shadow)] focus-visible:shadow-[var(--input-shadow-focus)] focus-visible:outline-none"
            />
          </div>
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => onNewNote()}
              aria-label={t.new_memo}
              title={t.new_note_md}
              className="inline-flex h-7 w-7 items-center justify-center rounded-l-[var(--button-radius)] bg-interactive-primary text-interactive-primary-foreground shadow-sm transition-colors duration-150 hover:bg-interactive-primary/90"
            >
              <Plus size={15} strokeWidth={2.5} />
            </button>
            <button
              type="button"
              onClick={onNewHtmlNote}
              aria-label={t.new_note_html}
              title={t.new_note_html}
              className="ml-px inline-flex h-7 items-center justify-center rounded-r-[var(--button-radius)] border-l border-interactive-primary/40 bg-interactive-primary px-1.5 font-mono text-[10px] font-semibold tracking-wider text-interactive-primary-foreground shadow-sm transition-colors duration-150 hover:bg-interactive-primary/90"
            >
              HTML
            </button>
          </div>
          <SettingsMenu />
        </header>
        <div ref={scrollerCallbackRef} className="flex-1 overflow-y-auto p-2">
          {listing.isError ? (
            <div className="mt-24 flex flex-col items-center gap-3 px-6 text-center">
              <p className="text-sm font-medium text-status-error">{t.load_error}</p>
              <p className="max-w-md break-words text-xs text-text-subtle">{String(listing.error)}</p>
              <button
                type="button"
                onClick={() => listing.refetch()}
                className="mt-1 inline-flex items-center gap-2 rounded-[var(--button-radius)] bg-interactive-primary px-4 py-2 text-sm font-medium text-interactive-primary-foreground shadow-sm transition-colors duration-150 hover:bg-interactive-primary/90"
              >
                {t.retry}
              </button>
            </div>
          ) : (noteView === "grid" || noteView === "list" ? cells.length : items.length) === 0 ? (
            <div className="mt-24 flex flex-col items-center gap-4 text-center">
              <p className="text-sm text-text-subtle">{hasMemos ? t.no_match_hint : t.empty_hint}</p>
              {hasMemos ? (
                <button
                  type="button"
                  onClick={clearAllFilters}
                  className="inline-flex items-center gap-2 rounded-[var(--button-radius)] bg-interactive-primary px-4 py-2 text-sm font-medium text-interactive-primary-foreground shadow-sm transition-colors duration-150 hover:bg-interactive-primary/90"
                >
                  {t.clear_filters}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onNewNote()}
                  className="inline-flex items-center gap-2 rounded-[var(--button-radius)] bg-interactive-primary px-4 py-2 text-sm font-medium text-interactive-primary-foreground shadow-sm transition-colors duration-150 hover:bg-interactive-primary/90"
                >
                  <Plus size={15} strokeWidth={2.5} /> {t.empty_cta}
                </button>
              )}
            </div>
          ) : noteView === "grid" ? (
            <GridView
              cells={cells}
              virtualizer={virtualizer}
              cols={cols}
              folders={folders}
              folderEntries={folderEntries}
              onOpenFolder={setFolderFilter}
              onSelect={select}
              onToggleFavorite={onToggleFavorite}
              onMoveFolder={onMoveFolder}
              onCopyBody={onCopyBody}
              onDelete={onDelete}
              onNewNoteIn={onNewNoteIn}
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