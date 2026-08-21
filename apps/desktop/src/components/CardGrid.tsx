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
  CodeXml,
  FilePlus2,
  FolderPlus,
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
  createFolder,
  deleteFolder,
  createMemo,
  deleteMemo,
  folderChildren,
  getMemo,
  getConfig,
  listFolders,
  listMemos,
  memoStats,
  moveNote,
  moveFolder,
  renameFolder,
  searchMemos,
  setFolderPinned,
  setFolderView,
  updateMemo,
  restoreNotes,
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { listen } from "../lib/tauri";
import { useUI, loadQueryView } from "../stores/ui";
import type { FolderCard, MemoSummary, ViewMode } from "../lib/types";

import { MemoDetail } from "./MemoDetail";
import { CtxRoot, CtxTrigger, CtxMenu, CtxItem, CtxSeparator } from "./ContextMenu";
import type { NamingSession } from "./FolderTile";
import { FolderPalette } from "./FolderPalette";
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
  const searchScope = useUI((s) => s.searchScope);
  const setSearchScope = useUI((s) => s.setSearchScope);
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
  const setView = useUI((s) => s.setView);
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
    queryKey: ["memos", includeTags, excludeTags, matchAll, folderFilter, favoritesOnly, noteView],
    queryFn: ({ pageParam }) =>
      listMemos(pageParam, PAGE_SIZE, {
        include_tags: includeTags,
        exclude_tags: excludeTags,
        match_all: matchAll,
        folder: folderFilter,
        favorites_only: favoritesOnly,
        // Per-view listing scope (T8): grid/list are direct-only
        // (`immediate: folderFilter !== null`); timeline/graph are recursive
        // — show the folder's full subtree so the source chips make sense.
        immediate:
          folderFilter !== null && (noteView === "grid" || noteView === "list"),
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
      // Folder-scoped search (T13): scope to the browse location's
      // RECURSIVE subtree. At root ("") the subtree is the whole vault, so
      // 이 폴더 ≡ 전체 there — no folder test is applied (the chip still
      // renders; toggling it at root makes no difference).
      if (searchScope === "folder" && folderFilter !== null) {
        const prefix = `${folderFilter}/`;
        const inScope =
          folderFilter === "" || n.folder === folderFilter || n.folder.startsWith(prefix);
        if (!inScope) return false;
      }
      if (excludeTags.some((tag) => n.tags.includes(tag))) return false;
      if (includeTags.length) {
        const ok = matchAll
          ? includeTags.every((tag) => n.tags.includes(tag))
          : includeTags.some((tag) => n.tags.includes(tag));
        if (!ok) return false;
      }
      return true;
    });
  }, [inSearch, includeTags, excludeTags, folderFilter, favoritesOnly, listing.data, searching.data, searchScope]);

  // Direct-children folder tiles for the current browse level. We rely on
  // browse-by-default semantics (T5): folderFilter !== null ⇒ show this
  // folder's subfolders as content-peek tiles above its notes. In query
  // mode (folderFilter === null) and during search the tile layer is
  // suppressed — search results are flat, no folder chrome.
  //
  // T8 also gates the FolderChipBar in Timeline/Graph on this query so
 // those views get the same list of subfolders (chips instead of tiles).
  const browseFoldersQ = useQuery({
    queryKey: ["folderChildren", folderFilter],
    queryFn: () => folderChildren(folderFilter ?? ""),
    enabled:
      folderFilter !== null &&
      !inSearch &&
      (noteView === "grid" ||
        noteView === "list" ||
        noteView === "timeline" ||
        noteView === "graph"),
  });

  // TanStack Query keeps `data` populated even after `enabled` flips false,
  // so we have to gate the tile layer with the same predicate ourselves —
  // otherwise folder tiles leak into search results and contradict the
  // comment above. Brief-spec deps: [browseFoldersQ.data, items]; the
  // boolean predicate is constant for the lifetime of this render pass
  // because the views below either keep or discard the tile layer.
  //
  // The same predicate (without the view filter — search already nulled
  // it out) also drives the chip bar visibility in TimelineView, which
  // therefore mirrors the showFolders decision.
  const showFolders =
    folderFilter !== null &&
    !inSearch &&
    (noteView === "grid" ||
      noteView === "list" ||
      noteView === "timeline" ||
      noteView === "graph");
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
  // T14 edge auto-scroll state: `raf` is the live requestAnimationFrame
  // handle (0 = idle), `dir` the current scroll direction (-1 up, +1 down,
  // 0 stop) refreshed by every dragover while a note drag is in flight.
  const dragScrollRef = useRef<{ raf: number; dir: number }>({ raf: 0, dir: 0 });
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

  // T15 folder overflow collapse: beyond 2*cols-1 subfolder tiles the
  // first screen drowns in folders. Collapse to 2*cols-1 tiles plus one
  // tile-sized "show all" toggle (a folderOverflow Cell GridView renders).
  // Expansion is remembered PER BROWSE LOCATION in component session
  // state — deliberately not the store: it is a transient reading aid,
  // not navigation state (a remount or reload starts collapsed again).
  const [folderExpansion, setFolderExpansion] = useState<Record<string, boolean>>({});
  const folderCount = showFolders ? (browseFoldersQ.data?.length ?? 0) : 0;
  const folderCollapsed = folderCount > 2 * cols - 1 && !folderExpansion[folderFilter ?? ""];
  const visibleCells = useMemo<Cell[]>(() => {
    if (!folderCollapsed) return cells;
    const limit = 2 * cols - 1;
    return [
      ...cells.filter((c) => c.kind === "folder").slice(0, limit),
      { kind: "folderOverflow" as const, total: folderCount },
      ...cells.filter((c) => c.kind !== "folder"),
    ];
  }, [cells, folderCollapsed, cols, folderCount]);
  const expandFolders = useCallback(() => {
    setFolderExpansion((m) => ({ ...m, [folderFilter ?? ""]: true }));
  }, [folderFilter]);

  const rowCount = Math.ceil(visibleCells.length / cols);
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

  const stopDragScroll = useCallback(() => {
    if (dragScrollRef.current.raf)
      cancelAnimationFrame(dragScrollRef.current.raf);
    dragScrollRef.current = { raf: 0, dir: 0 };
  }, []);

  // T14: while a note drag hovers within 48px of the scroller's top or
  // bottom edge, a rAF loop scrolls ±12px per frame. dragover refreshes
  // the direction; actually leaving the scroller, dropping, or ending the
  // drag clears it. `relatedTarget` guard: dragleave bubbles from every
  // descendant, so moving between cards must NOT stop an ongoing scroll.
  const onScrollerDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      // No note drag in flight (e.g. a foreign file drag) → no auto-scroll.
      if (!useUI.getState().draggingNote) return;
      const el = scrollerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const y = e.clientY;
      const dir =
        y < rect.top + 48 ? -1 : y > rect.bottom - 48 ? 1 : 0;
      dragScrollRef.current.dir = dir;
      if (dir === 0 || dragScrollRef.current.raf) return;
      const step = () => {
        if (dragScrollRef.current.dir === 0 || !useUI.getState().draggingNote) {
          dragScrollRef.current.raf = 0;
          return;
        }
        el.scrollBy({ top: dragScrollRef.current.dir * 12 });
        dragScrollRef.current.raf = requestAnimationFrame(step);
      };
      dragScrollRef.current.raf = requestAnimationFrame(step);
    },
    [],
  );

  const onScrollerDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    stopDragScroll();
  }, [stopDragScroll]);

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

  // Inline naming session (Task 10 rename + Task 12 optimistic create).
  // The folder being edited is mirrored into `namingPath` as a NamingSession
  // — `isNew` distinguishes a just-created folder (cancel DELETES it, since
  // nothing of value existed yet) from an existing one (cancel is a no-op).
  // FolderTile and the List view's folder row render the naming input when
  // the path matches. Activated by the folder context menu's 이름 변경 item
  // and by startFolderCreate.
  const [namingPath, setNamingPath] = useState<NamingSession | null>(null);
  // Per-session commit latch: keyed by the path being named so a second
  // rename started while the first IPC roundtrip is still pending isn't
  // silently dropped. The latch releases when the session ends (success,
  // cancel, or error) and resets whenever a new naming session begins
  // for a different path.
  const namingCommitRef = useRef<{ path: string | null }>({ path: null });

  // Optimistic folder-create flow (Task 12): create `loc/t.folder_new` at
  // the current browse location, then hand the fresh tile to the inline
  // naming session with `isNew: true` — cancel (Esc/empty) tears the
  // just-created folder down, a typed name renames it, Enter on the
  // untouched default keeps it. The chip bar `＋ 새 폴더` chip and the
  // empty-area context menu both route through here.
  const startFolderCreate = useCallback(() => {
    const loc = folderFilter ?? "";
    // Auto-suffix "새 폴더" → "새 폴더 2" → "새 폴더 3" when the base
    // name is already taken. The backend create_folder now rejects
    // duplicates with an authoritative error (vault.rs create_folder
    // existence guard), so this client-side guard avoids a round-trip
    // and a visible toast for the common case. Falls back to the
    // backend error if the loop somehow misses (race between typing
    // and an external delete, etc).
    const existing = new Set<string>(folderEntries.map((f) => f.path));
    let def = loc ? `${loc}/${t.folder_new}` : t.folder_new;
    let n = 2;
    while (existing.has(def)) {
      const candidate = loc ? `${loc}/${t.folder_new} ${n}` : `${t.folder_new} ${n}`;
      if (!existing.has(candidate)) {
        def = candidate;
        break;
      }
      n += 1;
      if (n > 999) {
        setError(t.folder_name_invalid);
        return;
      }
    }
    void createFolder(def)
      .then(() => {
        qc.invalidateQueries({ queryKey: ["folderChildren"] });
        qc.invalidateQueries({ queryKey: ["folders"] });
        setNamingPath({ path: def, isNew: true });
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  }, [folderFilter, t.folder_new, t.folder_name_invalid, folderEntries, qc, setError]);

  // Folder context menu → inline rename of an EXISTING folder (cancel is
  // then a no-op, unlike the optimistic-create cancel above).
  const onRenameFolder = useCallback((path: string) => {
    setNamingPath({ path, isNew: false });
  }, []);

  // Folder context menu / Settings pin toggle → oximemo.toml [[folders]].
  const onToggleFolderPin = useCallback(
    (path: string, pinned: boolean) => {
      void setFolderPinned(path, pinned)
        .then(() => qc.invalidateQueries({ queryKey: ["config"] }))
        .catch((e) => setError(String(e).split("\n")[0]));
    },
    [qc, setError],
  );

  // Move a folder subtree into `dest` ("" = vault top level) — Finder
  // drag-and-drop. Backend move_folder keeps the basename and re-checks
  // cycles/parent no-ops authoritatively; errors surface via the toast.
  const moveFolderTree = useCallback(
    (path: string, dest: string) => {
      void moveFolder(path, dest)
        .then(() => {
          qc.invalidateQueries({ queryKey: ["folderChildren"] });
          qc.invalidateQueries({ queryKey: ["folders"] });
          qc.invalidateQueries({ queryKey: ["config"] });
          qc.invalidateQueries({ queryKey: ["memos"] });
          // Follow the folder if the user moved the one they're browsing.
          const cur = useUI.getState().folderFilter;
          if (cur !== null && (cur === path || cur.startsWith(`${path}/`))) {
            const base = path.split("/").at(-1) ?? path;
            useUI.getState().setFolderFilter(dest ? `${dest}/${base}` : base);
          }
        })
        .catch((e) => setError(String(e).split("\n")[0]));
    },
    [qc, setError],
  );

  // Folder delete with trash + undo (Task 11). Every live note under the
  // folder is trashed structure-preserving by the backend; the returned
  // ids power the 실행 취소 action on the toast. The tile/row context
  // menu's two-click arm (삭제… → 삭제 확인, FolderCtxMenu) supplies the
  // `confirmed` flag for deep>0 — window.confirm is unreliable in Tauri's
  // WKWebView, see SettingsMenu's reset arm for the same precedent.
  const onDeleteFolder = (path: string, deep: number, confirmed = false) => {
    if (deep > 0 && !confirmed) return;
    void deleteFolder(path)
      .then((ids) => {
        qc.invalidateQueries({ queryKey: ["folderChildren"] });
        qc.invalidateQueries({ queryKey: ["folders"] });
        qc.invalidateQueries({ queryKey: ["config"] });
        const undo = () => {
          void restoreNotes(ids)
            .then(() => {
              if (ids.length === 0) void createFolder(path); // folder had no notes
              qc.invalidateQueries({ queryKey: ["folderChildren"] });
              qc.invalidateQueries({ queryKey: ["folders"] });
              qc.invalidateQueries({ queryKey: ["config"] });
            })
            .catch((e) => setError(String(e).split("\n")[0]));
        };
        setToast(
          t.folder_deleted.replace(
            "{folder}",
            path.split("/").at(-1) ?? path,
          ),
          { label: t.undo, onClick: undo },
        );
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  const commitFolderName = useCallback(
    (value: string | null) => {
      if (!namingPath) return;
      const session = namingPath;
      const from = session.path;
      // Per-session latch: only block re-fire within the SAME session
      // (Enter + blur on one input). A second naming session for a
      // different path during the first IPC roundtrip is allowed
      // through; its own Enter/blur pair will be debounced internally.
      if (namingCommitRef.current.path === from) return;
      namingCommitRef.current.path = from;
      setNamingPath(null);
      const name = (value ?? "").trim();
      const invalidate = () => {
        qc.invalidateQueries({ queryKey: ["folderChildren"] });
        qc.invalidateQueries({ queryKey: ["folders"] });
        qc.invalidateQueries({ queryKey: ["config"] });
      };
      // Cancelled (Esc) or emptied: a brand-new folder is torn down — it
      // only ever held the default name, so deleteFolder is safe; an
      // existing folder keeps its name (no-op) and the user retries.
      if (value === null || !name) {
        if (session.isNew) {
          void deleteFolder(from)
            .then(invalidate)
            .catch((e) => setError(String(e).split("\n")[0]));
        }
        namingCommitRef.current.path = null;
        return;
      }
      // Reject names that contain "/": CardGrid's inline rename
      // commits by calling renameFolder(from, loc/name). Without this
      // guard, a "/" silently nested the folder into a non-existent
      // parent and the rename errored afterwards with a confusing
      // "not found" instead of a clear invalid-name toast.
      if (name.includes("/")) {
        invalidate();
        namingCommitRef.current.path = null;
        setError(t.folder_name_invalid);
        return;
      }
      const loc = folderFilter ?? "";
      const to = loc ? `${loc}/${name}` : name;
      if (to === from) {
        // Unchanged — nothing to do, but still refetch in case the user's
        // commit cancelled an external edit.
        invalidate();
        namingCommitRef.current.path = null;
        return;
      }
      void renameFolder(from, to)
        .then(() => {
          invalidate();
          namingCommitRef.current.path = null;
        })
        .catch((e) => {
          invalidate();
          namingCommitRef.current.path = null;
          const raw = String(e).split("\n")[0];
          // Translate "X index entries need reindex" into the localized
          // "X notes remain in 'from'" wording so the UI surfaces the
          // partial-failure path the brief calls out.
          const m = raw.match(/(\d+)\s+index entries need reindex/i);
          setError(
            m
              ? t.rename_failed_left
                  .replace("{n}", m[1])
                  .replace("{from}", from)
              : raw,
          );
        });
    },
    [namingPath, folderFilter, qc, setError, t.rename_failed_left],
  );



  // ⌘⇧O folder jump palette (T15). Session state — the palette is a
  // transient overlay, so open/close never persists.
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘N / CtrlN — new note in current folder. Inert while the palette
      // modal is open (opening MemoDetail underneath would stack two
      // focus traps).
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        if (paletteOpen) return;
        e.preventDefault();
        onNewNote();
        return;
      }
      // ⌘⇧O / Ctrl⇧O — folder jump palette. Guarded while the memo dialog
      // is open (selectedId): its own key handling wins. Gallery view is
      // excluded too — <FolderPalette> only mounts in the memos tree, so
      // toggling it from gallery would arm an invisible open that pops
      // the moment the user leaves gallery. The capture overlay lives in
      // its own window/document (App early-returns the capture route), so
      // it can never see this listener.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "o") {
        if (useUI.getState().selectedId) return;
        if (useUI.getState().view === "gallery") return;
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      // ⌘↑ / Ctrl↑ — navigate up one folder (no-op in query mode or at
      // root; inert under the palette modal). Mirrors the ⌘⇧O and
      // Escape branches — a memo dialog open (selectedId) wins; without
      // this guard the editor loses key focus to the parent-folder
      // jump while the user is reading a note.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "ArrowUp") {
        if (useUI.getState().selectedId) return;
        if (paletteOpen) return;
        e.preventDefault();
        useUI.getState().navigateUp();
        return;
      }
      // Escape — clear the current search box only. Does NOT navigate; the
      // dialog/palette handlers manage their own Escape behaviour.
      if (e.key === "Escape") {
        if (useUI.getState().selectedId) return;
        if (paletteOpen) return;
        if (localSearch === "") return;
        e.preventDefault();
        setLocalSearch("");
        setDebounced("");
        setSearch("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNewNote, localSearch, paletteOpen, setSearch]);

  // Palette navigation mirrors the sidebar's openFolder convention
  // (Sidebar.tsx): setView("memos") + favoritesOnly(false) + browse the
  // folder — a jump from a favorites/tag smart collection must land in
  // UNFILTERED browse of the destination, not a favorites-filtered one.
  // Tags are intentionally left alone, exactly like openFolder. Any
  // active search is dropped too — a palette jump is a navigation
  // command, so the destination opens in browse mode rather than
  // folder-scoped search results. localSearch/debounced are
  // CardGrid-local mirrors of the store search and are cleared here
  // alongside it (the mirrors are NOT store-synced).
  const jumpToFolder = useCallback(
    (path: string) => {
      setView("memos");
      setFavoritesOnly(false);
      setFolderFilter(path);
      setPaletteOpen(false);
      setLocalSearch("");
      setDebounced("");
      setSearch("");
    },
    [setView, setFavoritesOnly, setFolderFilter, setSearch],
  );

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
    // h-dvh: see the memos return below — the height chain anchors here too.
    return (
      <div className="flex h-dvh">
        {!sidebarCollapsed && (
          <Sidebar onMoveNote={onMoveFolder} onMoveFolderTree={moveFolderTree} />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <header
            data-tauri-drag-region="deep"
            className="flex h-12 shrink-0 items-center border-b border-line pr-4"
          >
            {sidebarToggle}
          </header>
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
    onMoveFolderTree: moveFolderTree,
    onCopyBody,
    onDelete,
    onNewNote,
    onNewFolder: startFolderCreate,
    onRenameFolder,
    onToggleFolderPin,
    onDeleteFolder,
    namingPath,
    onNameCommit: commitFolderName,
  };

  // h-dvh: the html/body/#root chain carries no height, so h-full
  // collapses to content height — the sidebar border stopped partway
  // down the window. Anchored to the viewport directly.
  return (
    <div className="flex h-dvh">
      {!sidebarCollapsed && (
        <Sidebar onMoveNote={onMoveFolder} onMoveFolderTree={moveFolderTree} />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          data-tauri-drag-region="deep"
          className="flex h-12 items-center gap-3 border-b border-line pr-4"
        >
          {sidebarToggle}
          <BreadcrumbBar folders={folderEntries} folderDefs={folders} onMoveNote={onMoveFolder} onMoveFolderTree={moveFolderTree} />
          {viewSwitcher}
          {folderFilter !== null && debounced.length > 0 && (
            <button
              type="button"
              onClick={() => setSearchScope(searchScope === "folder" ? "all" : "folder")}
              title={searchScope === "folder" ? t.scope_this_folder : t.scope_all}
              className="h-7 shrink-0 rounded-[var(--tag-radius)] border border-line bg-surface-raised px-2.5 text-xs text-text-muted transition-colors duration-150 hover:border-line-strong"
            >
              {searchScope === "folder" ? t.scope_this_folder : t.scope_all} ▾
            </button>
          )}
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
          {/* Finder-style toolbar affordance (browser feedback): the only
              always-visible folder-create entry in browse mode — the
              context menu stays as the secondary path. Hidden in query
              mode (same rule as the empty-area menu) so "new folder"
              never lands in an ambiguous location. */}
          {folderFilter !== null && (
            <button
              type="button"
              onClick={startFolderCreate}
              aria-label={t.folder_new}
              title={t.folder_new}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--button-radius)] text-text-muted transition-colors duration-150 hover:bg-surface-muted hover:text-text"
            >
              <FolderPlus size={15} strokeWidth={2} />
            </button>
          )}
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
        <div
          ref={scrollerCallbackRef}
          onDragOver={onScrollerDragOver}
          onDragLeave={onScrollerDragLeave}
          onDrop={stopDragScroll}
          onDragEnd={stopDragScroll}
          className="flex-1 overflow-y-auto p-2"
        >
          {/* Empty-area context menu (M20/B3): new notes anywhere; 새 폴더
              only while BROWSING a folder — query mode hides it so "new
              folder" never lands in an ambiguous location. min-h-full keeps
              the trigger covering the whole scrollable surface. */}
          <CtxRoot>
            <CtxTrigger className="min-h-full">
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
                cells={visibleCells}
                virtualizer={virtualizer}
                cols={cols}
                showFolderChip={folderFilter === null}
                folders={folders}
                folderEntries={folderEntries}
                onOpenFolder={setFolderFilter}
                onSelect={select}
                onToggleFavorite={onToggleFavorite}
                onMoveFolder={onMoveFolder}
                onMoveFolderTree={moveFolderTree}
                onCopyBody={onCopyBody}
                onDelete={onDelete}
                onNewNoteIn={onNewNoteIn}
                onRenameFolder={onRenameFolder}
                onToggleFolderPin={onToggleFolderPin}
                namingPath={namingPath}
                onNameCommit={commitFolderName}
                onDeleteFolder={onDeleteFolder}
                onExpandFolders={expandFolders}
              />
            ) : noteView === "list" ? (
              <ListView {...viewProps} />
            ) : noteView === "timeline" ? (
              <TimelineView {...viewProps} />
            ) : (
              <GraphView
                items={items}
                folders={folders}
                folderCards={folderCards}
                onOpenFolder={setFolderFilter}
                onNewFolder={startFolderCreate}
                onMoveNote={onMoveFolder}
                onMoveFolderTree={moveFolderTree}
              />
            )}
              <CtxMenu>
                <CtxItem icon={FilePlus2} label={t.new_note_md} onClick={() => onNewNote()} />
                <CtxItem icon={CodeXml} label={t.new_note_html} onClick={onNewHtmlNote} />
                {folderFilter !== null && (
                  <>
                    <CtxSeparator />
                    <CtxItem icon={FolderPlus} label={t.folder_new} onClick={startFolderCreate} />
                  </>
                )}
              </CtxMenu>
            </CtxTrigger>
          </CtxRoot>
        </div>
      </div>
      <MemoDetail />
      <FolderPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        folders={folderEntries}
        folderDefs={folders}
        onNavigate={jumpToFolder}
      />
    </div>
  );
}