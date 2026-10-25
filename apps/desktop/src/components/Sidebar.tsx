/**
 * Collapsible left sidebar — Finder-model curation surface: FAVORITES
 * (one icon grid: 전체 메모/즐겨찾기/갤러리 smart collections + the vault
 * root, daily + knowledge locations, and pinned first-party collections
 * growing in the same grid; regular pinned folders keep managed rows),
 * QUERIES (the installed `할 일` shortcut + saved `.query` collections),
 * TASKS (the slim overdue+today panel), RECENTS, TAGS, and the space
 * switcher pinned to the bottom edge. Folder browsing happens in the main area.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowUpDown, BookMarked, CalendarDays, ChevronRight, Clock3, Database, FileText, Folder, FolderPlus, GraduationCap, GripVertical, Images, Layers, ListChecks, MoreHorizontal, PenLine, Plus, Search, Star, Trash2, TriangleAlert, X } from "lucide-react";
import { Popover } from "@base-ui-components/react";
import { Button } from "@garden/ui";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion, useIsPresent } from "motion/react";
import { useWorkspaceMotion } from "../lib/workspaceMotion";
import { SpacePicker } from "./SpacePicker";
import { listFacets, memoStats, listMemos, getConfig, setFolderPinned, renameFolder, deleteFolder, setPinOrder, folderChildren, renameTag, listBases, renameBase, trashBase, restoreBase, listFolders } from "../lib/api";
import { createQueryCollection, defaultQueryYaml } from "../lib/queryCreation";
import { TASKS_BASE_PATH } from "../lib/tasksPanel";
import { colorForFolder } from "../lib/color";
import { listen } from "../lib/tauri";
import { CtxRoot, CtxTrigger, CtxMenu, CtxItem, CtxSeparator, BtnMenuRoot, BtnMenuTrigger, BtnMenuPopup, BtnMenuItem, BtnMenuSeparator } from "./ContextMenu";
import { useFolderDrop, parentOf } from "../lib/dropTarget";
import { useI18n } from "../lib/i18n";
import { relativeTime } from "../lib/time";
import { folderDisplayName, useFolderNames, useSchemaInfo, DEFAULT_KNOWLEDGE_FOLDER } from "../lib/folders";
import { TasksPanel } from "./TasksPanel";
import { COLLECTION_CATALOG } from "../lib/collectionCatalog";
import { TextCtxMenu } from "./TextCtxMenu";
import type { LucideIcon } from "lucide-react";
import { useUI, type TagState } from "../stores/ui";
import type { FolderDef, FolderEntry } from "../lib/types";
import { NoteCtxMenu } from "./NoteCtxMenu";
import { useFolderCreate } from "../lib/useFolderCreate";
/** 쿼리 행 메뉴 항목 — ⋯ 팝오버와 우클릭이 공유(설계 원칙 2). */
type QueryMenuItem =
  | { label: string; icon?: LucideIcon; danger?: boolean; onClick: () => void }
  | { separator: true };

/** Static preset-id → icon table (drives 위치 collection rows). */
const PRESET_ICON: Record<string, (typeof COLLECTION_CATALOG)[number]["icon"]> =
  Object.fromEntries(COLLECTION_CATALOG.map((c) => [c.id, c.icon]));

const STATE_CLASS: Record<TagState, string> = {
  off: "bg-surface-muted text-text-muted hover:bg-surface-muted/80",
  in: "bg-status-info-subtle font-semibold text-status-info-on-subtle",
  out: "border border-status-error/30 bg-status-error-subtle text-status-error-on-subtle line-through",
};

export function Sidebar({
  onMoveNote,
  onMoveFolderTree,
  noteActions,
  onRequestAdd,
}: {
  onMoveNote: (id: string, folder: string) => void;
  /** Move a dragged folder subtree into a pinned/seeded row's folder. */
  onMoveFolderTree?: (path: string, dest: string) => void;
  /** NoteCtxMenu 액션 — CardGrid가 소유(설계 §3.1 최근 항목 메뉴 재사용). */
  noteActions: {
    folderEntries: FolderEntry[];
    onToggleFavorite: (id: string, favorite: boolean) => void;
    onMoveFolder: (id: string, folder: string) => void;
    onCopyBody: (id: string) => void;
    onDelete: (id: string) => void;
  };
  /** 배경 메뉴의 새 노트 — CardGrid의 requestAdd 위임(스키마 추가 게이트 포함). */
  onRequestAdd: () => void;
}) {
  const { t, locale } = useI18n();
  const present = useIsPresent();
  const timing = useWorkspaceMotion();
  const sidebarRef = useRef<HTMLElement>(null);
  const [resizing, setResizing] = useState(false);
  useLayoutEffect(() => {
    if (!present && sidebarRef.current?.contains(document.activeElement)) {
      document.querySelector<HTMLElement>("[data-sidebar-toggle]")?.focus({ preventScroll: true });
    }
  }, [present]);
  useEffect(() => {
    if (!present) return;
    const compact = window.matchMedia("(max-width: 700px)");
    const enterNavigation = () => {
      if (!compact.matches || sidebarRef.current?.contains(document.activeElement) || document.querySelector("[role=dialog], [role=menu], [role=listbox]")) return;
      sidebarRef.current?.querySelector<HTMLButtonElement>(".sidebar-compact-close")?.focus({ preventScroll: true });
    };
    enterNavigation();
    compact.addEventListener("change", enterNavigation);
    return () => compact.removeEventListener("change", enterNavigation);
  }, [present]);
  const facets = useQuery({ queryKey: ["facets"], queryFn: listFacets });
  const stats = useQuery({ queryKey: ["stats"], queryFn: memoStats });
  const configQ = useQuery({ queryKey: ["config"], queryFn: getConfig });
  // ["memos", …] prefix: the memos:changed listener in CardGrid
  // invalidates ["memos"], so recents refresh with everything else.
  const recentsQ = useQuery({
    queryKey: ["memos", "recents"],
    queryFn: () => listMemos(null, 7),
  });
  const tagFilter = useUI((s) => s.tagFilter);
  const cycleTag = useUI((s) => s.cycleTag);
  const setTagState = useUI((s) => s.setTagState);
  const clearTagFilter = useUI((s) => s.clearTagFilter);
  const matchAll = useUI((s) => s.matchAll);
  const toggleMatchAll = useUI((s) => s.toggleMatchAll);
  const folderFilter = useUI((s) => s.folderFilter);
  const setFolderFilter = useUI((s) => s.setFolderFilter);
  const favoritesOnly = useUI((s) => s.favoritesOnly);
  const setFavoritesOnly = useUI((s) => s.setFavoritesOnly);
  const view = useUI((s) => s.view);
  const setView = useUI((s) => s.setView);
  const select = useUI((s) => s.select);
  const setError = useUI((s) => s.setError);
  const qc = useQueryClient();

  // Picking a tag is vault-wide intent — drop any folder/favorite scope
  // so the "전체 메모" smart collection owns the view (Task 9).
  const enterQueryMode = () => {
    setView("memos");
    setFavoritesOnly(false);
    setFolderFilter(null);
  };
  const tags = facets.data?.tags ?? [];
  const folders: FolderDef[] = configQ.data?.folders ?? [];
  const total = stats.data?.memos ?? 0;
  const favoritesCount = stats.data?.favorites ?? 0;
  const recents = recentsQ.data?.items ?? [];
  const [recentsOpen, setRecentsOpen] = useState(false);

  // Favorites: explicit pins only — the sidebar is curation (Finder
  // model), never a folder browser. Pin from a folder's context menu.
  /** Pin being renamed (path); the row swaps to an inline input. */
  const [pinNaming, setPinNaming] = useState<string | null>(null);

  const invalidateFolderData = () => {
    void qc.invalidateQueries({ queryKey: ["memos"] });
    void qc.invalidateQueries({ queryKey: ["config"] });
    void qc.invalidateQueries({ queryKey: ["folderChildren"] });
  };

  const commitPinRename = (path: string, name: string | null) => {
    setPinNaming(null);
    const clean = (name ?? "").trim();
    if (!clean) return; // cancel
    const base = path.split("/").at(-1) ?? path;
    if (clean === base) return;
    const parent = parentOf(path);
    const to = parent ? `${parent}/${clean}` : clean;
    renameFolder(path, to).then(invalidateFolderData).catch((e) => {
      setError(String(e).split("\n")[0]);
    });
  };

  // --- QUERIES (query views spec §5): saved .query collections. The
  // watcher emits bases:changed on external edits; we mirror the
  // memos:changed pattern from CardGrid for ["bases"]. Duplicate stems
  // stay listed with an ambiguity marker (spec §6, UI-layer contract).
  const basesQ = useQuery({ queryKey: ["bases"], queryFn: listBases });
  const openBase = useUI((s) => s.openBase);
  const openPdc = useUI((s) => s.openPdc);
  const location = useUI((s) => s.location);
  const [queryNaming, setQueryNaming] = useState<string | null>(null);
  useEffect(() => {
    let un: (() => void) | undefined;
    void listen("bases:changed", () => {
      void qc.invalidateQueries({ queryKey: ["bases"] });
    }).then((u) => {
      un = u;
    });
    return () => un?.();
  }, [qc]);
  const bases = basesQ.data ?? [];
  // The installed 할 일 base is a protected system surface with its own
  // dedicated row below — listing it here read as a duplicate and
  // offered a delete affordance on a file core refuses to delete.
  const visibleBases = bases.filter((b) => b.path !== TASKS_BASE_PATH);
  const ambiguousNames = useMemo(() => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const b of bases) (seen.has(b.name) ? dup : seen).add(b.name);
    return dup;
  }, [bases]);
  const createQuery = () => {
    const taken = new Set(bases.map((b) => b.name));
    let stem: string = t.query_new_default;
    for (let n = 2; taken.has(stem); n++) stem = `${t.query_new_default} ${n}`;
    createQueryCollection(stem, defaultQueryYaml(t.view_table))
      .then(() => {
        void qc.invalidateQueries({ queryKey: ["bases"] });
        setView("memos");
        openBase({ path: `queries/${stem}.query` });
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };
  const commitQueryRename = (path: string, name: string | null) => {
    setQueryNaming(null);
    const clean = (name ?? "").trim();
    if (!clean) return;
    const stem = path.split("/").at(-1)?.replace(/\.query$/, "") ?? path;
    if (clean === stem) return;
    const dir = parentOf(path);
    renameBase(path, dir ? `${dir}/${clean}.query` : `${clean}.query`)
      .then(() => void qc.invalidateQueries({ queryKey: ["bases"] }))
      .catch((e) => setError(String(e).split("\n")[0]));
  };
  const deleteQuery = (path: string) => {
    trashBase(path)
      .then((token) => {
        void qc.invalidateQueries({ queryKey: ["bases"] });
        if (location.kind === "base" && "path" in location.source && location.source.path === path)
          useUI.getState().exitBase();
        setToast(t.query_deleted, {
          label: t.undo,
          onClick: () => {
            restoreBase(token)
              .then(() => void qc.invalidateQueries({ queryKey: ["bases"] }))
              .catch((e) => setError(String(e).split("\n")[0]));
          },
        });
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  const deletePinFolder = (path: string) => {
    deleteFolder(path).then(invalidateFolderData).catch((e) => {
      setError(String(e).split("\n")[0]);
    });
  };
  /** Tag being renamed; the chip swaps to an inline input. */
  const [tagNaming, setTagNaming] = useState<string | null>(null);
  const setToast = useUI((s) => s.setToast);

  /** Vault-wide tag rename: rewrite bodies via core, refresh, toast. */
  const commitTagRename = (old: string, value: string | null) => {
    setTagNaming(null);
    const next = (value ?? "").trim().replace(/^#/, "");
    if (!next || next === old) return; // cancel
    clearTagFilter();
    renameTag(old, next)
      .then((n) => {
        void qc.invalidateQueries({ queryKey: ["memos"] });
        void qc.invalidateQueries({ queryKey: ["facets"] });
        setToast(t.tag_renamed_toast.replace("{n}", String(n)));
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  /** Reorder pins after a ⠿ drop: `dragged` moves before/after `target`. */
  const reorderPins = (order: string[]) => {
    setPinOrder(order)
      .then(() => qc.invalidateQueries({ queryKey: ["config"] }))
      .catch((e) => setError(String(e).split("\n")[0]));
  };
  const pins = folders.filter((f) => f.pinned);
  const pinPaths = pins.map((f) => f.path);
  // First-party tier (user prompt 2026-08-24): an installed collection
  // shows its catalog icon — a pinned folder carrying a `[meta] preset`
  // marker renders like the 볼트/데일리/지식 location rows, not as a
  // generic folder. The row keeps full pin management (rename/unpin/
  // reorder/delete) — collections ARE folders.
  const pinSchemas = useSchemaInfo(pinPaths);
  const presetIcons = useMemo(() => {
    const out: Record<string, React.ReactNode> = {};
    for (const [p, s] of Object.entries(pinSchemas)) {
      const Icon = s?.meta?.preset ? PRESET_ICON[s.meta.preset] : undefined;
      if (Icon) out[p] = <Icon size={14} className="shrink-0 text-text-subtle" aria-hidden />;
    }
    return out;
  }, [pinSchemas]);

  // Daily notes: opt-out via config (absent = enabled). The LOCATIONS row
  // below browses the daily folder; today's note opens from the main
  // area's TODAY button and the command palette, not from this sidebar.
  const dailyCfg = configQ.data?.daily;
  const dailyEnabled = dailyCfg?.enabled !== false;
  const dailyFolder = dailyCfg?.folder || "daily";
  // Tasks surface (spec 2026-08-27 §7.4/§11): gated by `[tasks] enabled`
  // (absent = enabled, like daily). The installed base itself is a
  // protected system file — core refuses trash/rename on it and
  // migrate() re-seeds it if it ever goes missing.
  const tasksEnabled = configQ.data?.tasks?.enabled !== false;
  const hasTasksBase = bases.some((b) => b.path === TASKS_BASE_PATH);
  /** Pinned first-party collections (preset icon present) join the
   *  LOCATIONS icon grid — except the two system folders that already
   *  show unconditionally, which would render twice. Regular pinned
   *  folders keep their managed rows below the grid. */
  const gridPins = pins.filter(
    (f) => presetIcons[f.path] && f.path !== dailyFolder && f.path !== DEFAULT_KNOWLEDGE_FOLDER,
  );
  const folderPins = pins.filter((f) => !presetIcons[f.path]);

  const openFolder = (path: string) => {
    setFavoritesOnly(false);
    setFolderFilter(path);
  };

  const unpin = (path: string) => {
    void setFolderPinned(path, false)
      .then(() => qc.invalidateQueries({ queryKey: ["config"] }))
      .then(() => qc.invalidateQueries({ queryKey: ["folders"] }))
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  // 배경 메뉴의 새 폴더 — 볼트 루트 대상, CardGrid와 같은 낙관적 생성 흐름.
  const createFolderAt = useFolderCreate();
  // config 기반 `folders`는 핀된 폴더만 담고 있어 접미 가드가 미비하다 —
  // 볼트 전체 스캔(listFolders)을 써야 미고정 폴더와의 이름 충돌을 피한다.
  const foldersQ = useQuery({ queryKey: ["folders"], queryFn: listFolders });

  return (
    <motion.aside
      id="workspace-sidebar"
      ref={sidebarRef}
      className="glass-sidebar"
      aria-label={t.nav_notes}
      inert={!present}
      data-resizing={resizing}
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: "var(--workspace-sidebar-width)", opacity: 1, transition: timing.move }}
      exit={{ width: 0, opacity: 0, transition: timing.move }}
      onAnimationStart={() => setResizing(true)}
      onAnimationComplete={() => setResizing(false)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || !window.matchMedia("(max-width: 700px)").matches) return;
        const target = event.target as HTMLElement;
        if (target.closest("input, textarea, [contenteditable=true], [role=menu], [role=listbox], [role=dialog]")) return;
        event.preventDefault();
        useUI.getState().toggleSidebar();
      }}
    >
      {/* 배경 메뉴(설계 §3.1): 사이드바 여백 우클릭 = 생성. `contents` div라
          레이아웃에 영향 없고, 폴더 핀·태그 칩 등 기존 개별 트리거와 중첩된다
          (CardGrid 빈 영역의 검증된 패턴). FAVORITES·LOCATIONS 고정 셀은
          의도적 no-op — 이 배경 메뉴가 여백 우클릭을 담당한다. */}
      <CtxRoot>
        <CtxTrigger className="contents">
      <div data-tauri-drag-region className="sidebar-window-handle">
        <Button type="button" size="icon" variant="ghost" aria-label={t.hide_sidebar} onClick={() => useUI.getState().toggleSidebar()} className="sidebar-compact-close">
          <X size={15} aria-hidden />
        </Button>
      </div>
      <div className="sidebar-space"><SpacePicker /></div>
      <div className="sidebar-scroll">

      {/* FAVORITES — one Finder-model curation grid: the smart
          collections (all notes / favorites / gallery), the vault
          locations (root, daily, knowledge), and pinned first-party
          collections grow in the same grid as pins are added (names on
          hover; collection cells manage rename/unpin/delete via the
          right-click menu). Regular pinned folders keep their rows. */}
      <div className="mt-3 flex items-center px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
          {t.nav_notes}
        </span>
      </div>
      <div className="flex flex-col gap-0.5 px-2 pt-1">
        {/* Smart collections lead the grid — the app's fixed,
            always-present destinations. Selection is gated on the
            authoritative `location` (not the write-through mirrors) so
            exactly one cell highlights — PDC must not read as "all
            notes". */}
        <NavCell
          icon={<Layers size={18} aria-hidden />}
          title={t.all_memos}
          count={total}
          selected={location.kind === "all" && view === "memos"}
          onClick={() => { setView("memos"); setFavoritesOnly(false); setFolderFilter(null); }}
        />
        <NavCell
          icon={<Star size={18} aria-hidden />}
          title={t.favorite}
          count={favoritesCount}
          selected={view === "memos" && favoritesOnly}
          onClick={() => { setView("memos"); setFolderFilter(null); setFavoritesOnly(true); }}
        />
        <NavCell
          icon={<Images size={18} aria-hidden />}
          title={t.gallery}
          selected={view === "gallery" && location.kind !== "pdc"}
          onClick={() => setView("gallery")}
        />
        <p className="mt-2 px-1 py-1 text-[10px] font-semibold text-text-subtle">{t.nav_folders}</p>
        <LocationCell
          path=""
          icon={<Archive size={18} aria-hidden />}
          label={t.vault_root}
          selected={view === "memos" && !favoritesOnly && folderFilter === ""}
          onClick={() => {
            setView("memos");
            setFavoritesOnly(false);
            setFolderFilter("");
          }}
          onMoveNote={onMoveNote}
          onMoveFolderTree={onMoveFolderTree}
        />
        {dailyEnabled && dailyFolder && (
          <LocationCell
            path={dailyFolder}
            icon={<CalendarDays size={18} aria-hidden />}
            label={folderDisplayName(dailyFolder, t, dailyFolder)}
            selected={view === "memos" && !favoritesOnly && folderFilter === dailyFolder}
            onClick={() => openFolder(dailyFolder)}
            onMoveNote={onMoveNote}
            onMoveFolderTree={onMoveFolderTree}
          />
        )}
        {/* The knowledge folder is a shipped system folder (migrate
            guarantees it) — always in the grid; gridPins excludes the
            system paths so a pin can no longer duplicate it. */}
        <LocationCell
          path={DEFAULT_KNOWLEDGE_FOLDER}
          icon={<GraduationCap size={18} aria-hidden />}
          label={t.sysfolder_knowledge}
          selected={view === "memos" && !favoritesOnly && folderFilter === DEFAULT_KNOWLEDGE_FOLDER}
          onClick={() => openFolder(DEFAULT_KNOWLEDGE_FOLDER)}
          onMoveNote={onMoveNote}
          onMoveFolderTree={onMoveFolderTree}
        />
        {gridPins.map((f) => (
          <CollectionCell
            key={f.path}
            path={f.path}
            icon={presetIcons[f.path]}
            folders={folders}
            selected={folderFilter === f.path}
            naming={pinNaming === f.path}
            onOpen={openFolder}
            onUnpin={unpin}
            onRename={setPinNaming}
            onNameCommit={commitPinRename}
            onDelete={deletePinFolder}
            onMoveNote={onMoveNote}
            onMoveFolderTree={onMoveFolderTree}
          />
        ))}
        <p className="mt-2 px-1 py-1 text-[10px] font-semibold text-text-subtle">{t.nav_tools}</p>
        {/* PDC destination (Stage 1): document inventory + guarded source
            editor. A fixed smart-collection cell like all-notes/gallery —
            never a folder row, so no pin/rename affordances apply. */}
        <NavCell
          icon={<BookMarked size={18} aria-hidden />}
          title={t.pdc_documents}
          selected={location.kind === "pdc"}
          onClick={() => openPdc()}
        />
      </div>
      {folderPins.map((f) => (
        <SidebarFolderRow
          key={f.path}
          path={f.path}
          folders={folders}
          selected={folderFilter === f.path}
          naming={pinNaming === f.path}
          pinPaths={pinPaths}
          onOpen={openFolder}
          onUnpin={unpin}
          onRename={setPinNaming}
          onNameCommit={commitPinRename}
          onDelete={deletePinFolder}
          onReorder={reorderPins}
          onMoveNote={onMoveNote}
          onMoveFolderTree={onMoveFolderTree}
        />
      ))}
      {/* QUERIES — saved .query collections (query views spec §5). */}
      <div className="mt-3 flex items-center justify-between pr-3 pl-3">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
          {t.section_queries}
        </span>
        <button
          type="button"
          aria-label={t.query_new}
          title={t.query_new}
          onClick={createQuery}
          className="rounded-[var(--tag-radius)] p-0.5 text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text"
        >
          <Plus size={12} />
        </button>
      </div>
      {tasksEnabled && hasTasksBase && (
        <button
          type="button"
          onClick={() => {
            setView("memos");
            openBase({ path: TASKS_BASE_PATH });
          }}
          aria-current={location.kind === "base" && "path" in location.source && location.source.path === TASKS_BASE_PATH ? "page" : undefined}
          className={`sidebar-nav-item mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${
            location.kind === "base" && "path" in location.source && location.source.path === TASKS_BASE_PATH
              ? "bg-surface-muted font-semibold text-text"
              : "text-text-muted hover:bg-surface-muted transition-colors duration-150"
          }`}
        >
          <ListChecks size={14} className="shrink-0" />
          <span className="truncate">{t.view_tasks}</span>
        </button>
      )}
      {basesQ.isError ? (
        <div className="mx-2 px-2 py-1 text-[11px] text-text-subtle">{t.query_unavailable}</div>
      ) : visibleBases.length === 0 ? (
        <div className="mx-2 px-2 py-1 text-[11px] text-text-subtle/70">{t.query_none}</div>
      ) : (
        visibleBases.map((b) => {
          const active = location.kind === "base" && "path" in location.source && location.source.path === b.path;
          const warn = !b.loadable || ambiguousNames.has(b.name);
          const renaming = queryNaming === b.path;
          const openQuery = () => {
            setView("memos");
            openBase({ path: b.path });
          };
          // ⋯ 팝오버와 우클릭 = 같은 메뉴의 두 진입점(설계 원칙 2) — 항목을
          // 한 번 정의하고 두 래퍼가 각자 렌더한다.
          const menuItems: QueryMenuItem[] = [
            { label: t.folder_open, onClick: openQuery },
            { label: t.query_rename, icon: PenLine, onClick: () => setQueryNaming(b.path) },
            { separator: true },
            { label: t.query_delete, icon: Trash2, danger: true, onClick: () => deleteQuery(b.path) },
          ];
          return (
            <CtxRoot key={b.path}>
              <BtnMenuRoot>
              <CtxTrigger render={<div className="group/query relative mx-2" />}>
                <button
                  type="button"
                  onClick={openQuery}
                  aria-current={active ? "page" : undefined}
                  className={`sidebar-nav-item flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${
                    active
                      ? "bg-surface-muted font-semibold text-text"
                      : "text-text-muted hover:bg-surface-muted transition-colors duration-150"
                  }`}
                >
                  <Database size={14} className="shrink-0" />
                  {renaming ? (
                    <input
                      autoFocus
                      defaultValue={b.name}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => commitQueryRename(b.path, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitQueryRename(b.path, e.currentTarget.value);
                        if (e.key === "Escape") setQueryNaming(null);
                      }}
                      className="w-full rounded-sm border border-line bg-surface px-1 py-0 text-[12px] outline-none"
                    />
                  ) : (
                    <span className="truncate">{b.name}</span>
                  )}
                  {warn && !renaming && (
                    <TriangleAlert
                      size={12}
                      aria-label={t.query_ambiguous}
                      className="ml-auto shrink-0 text-hue-amber"
                    />
                  )}
                </button>
                <BtnMenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label={t.query_more}
                      className="absolute top-1/2 right-1 -translate-y-1/2 rounded-[var(--tag-radius)] p-0.5 text-text-subtle opacity-0 transition-opacity duration-150 group-hover/query:opacity-100 hover:bg-surface-muted hover:text-text"
                    >
                      <MoreHorizontal size={12} />
                    </button>
                  }
                />
                <BtnMenuPopup>
                  {menuItems.map((item, i) =>
                    "separator" in item ? (
                      <BtnMenuSeparator key={i} />
                    ) : (
                      <BtnMenuItem key={item.label} icon={item.icon} label={item.label} danger={item.danger} onClick={item.onClick} />
                    ),
                  )}
                </BtnMenuPopup>
                <CtxMenu>
                  {menuItems.map((item, i) =>
                    "separator" in item ? (
                      <CtxSeparator key={i} />
                    ) : (
                      <CtxItem key={item.label} icon={item.icon} label={item.label} danger={item.danger} onClick={item.onClick} />
                    ),
                  )}
                </CtxMenu>
              </CtxTrigger>
            </BtnMenuRoot>
            </CtxRoot>
          );
        })
      )}


      {/* TASKS — slim companion to the full `할 일` base view (the
          chevron in the panel header opens the full one in the main
          area). Gated by the same `[tasks] enabled` rule as the 할 일
          row above; the installed base is protected (no user delete). */}
      {tasksEnabled && hasTasksBase && <TasksPanel />}
      {/* TAGS */}
      <div className="mt-3 flex items-center justify-between px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">{t.tags_section}</span>
        <button
          type="button"
          onClick={toggleMatchAll}
          aria-pressed={matchAll}
          className="inline-flex items-center gap-1 text-[10px] font-semibold text-text-subtle"
        >
          {matchAll ? t.match_all : t.match_any} <ArrowUpDown size={10} />
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5 px-3 pt-1">
        <button
          type="button"
          onClick={clearTagFilter}
          aria-pressed={!Object.values(tagFilter).some((state) => state !== "off")}
          className="rounded-md bg-surface-muted px-2 py-0.5 text-[11px] text-text-muted"
        >
          {t.all_tags}
        </button>
        {tags.map(([tag, count]) => {
          const st: TagState = tagFilter[tag] ?? "off";
          const renaming = tagNaming === tag;
          if (renaming) {
            return (
              <TextCtxMenu
                key={tag}
                render={
                  <input
                    autoFocus
                    defaultValue={tag}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => commitTagRename(tag, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") commitTagRename(tag, e.currentTarget.value);
                      else if (e.key === "Escape") commitTagRename(tag, null);
                    }}
                    style={{ boxShadow: "none" }}
                    className="w-24 rounded-md bg-surface-muted px-1.5 py-0.5 text-[11px] text-text outline-none"
                  />
                }
              />
            );
          }
          return (
            <CtxRoot key={tag}>
              <CtxTrigger
                render={
                  <button
                    type="button"
                    aria-pressed={st !== "off"}
                    aria-label={`#${tag} · ${count} · ${st === "in" ? t.tag_filter_included : st === "out" ? t.tag_filter_excluded : t.tag_filter_off}`}
                    onClick={() => {
                      enterQueryMode();
                      cycleTag(tag);
                    }}
                    className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${STATE_CLASS[st]}`}
                  />
                }
              >
                #{tag} <span className="opacity-60">{count}</span>
                {/* Tags are the app's ONE filter concept (favorites are a
                    collection, folders are locations) — so the chip menu
                    speaks filter, setting the state directly instead of
                    cycling. */}
                <CtxMenu>
                  <CtxItem
                    label={t.tag_menu_include}
                    active={st === "in"}
                    onClick={() => {
                      enterQueryMode();
                      setTagState(tag, "in");
                    }}
                  />
                  <CtxItem
                    label={t.tag_menu_exclude}
                    active={st === "out"}
                    onClick={() => {
                      enterQueryMode();
                      setTagState(tag, "out");
                    }}
                  />
                  <CtxItem
                    label={t.tag_menu_off}
                    active={st === "off"}
                    onClick={() => setTagState(tag, "off")}
                  />
                  <CtxSeparator />
                  <CtxItem
                    icon={PenLine}
                    label={t.tag_rename}
                    onClick={() => setTagNaming(tag)}
                  />
                  <CtxItem label={t.clear_filters} onClick={() => clearTagFilter()} />
                </CtxMenu>
              </CtxTrigger>
            </CtxRoot>
          );
        })}
      </div>
      </div>
      <div className="sidebar-footer">
        <Popover.Root open={recentsOpen} onOpenChange={setRecentsOpen}>
          <Popover.Trigger className="sidebar-recents-trigger" aria-label={t.recents_section}>
            <Clock3 size={15} aria-hidden />
            <span>{t.recents_section}</span>
            <ChevronRight size={12} aria-hidden className="ml-auto" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner side="right" align="end" sideOffset={12} className="z-[80]">
              <Popover.Popup className="recent-popup glass-menu">
                <Popover.Title className="recent-popup-title">{t.recents_section}</Popover.Title>
                {recents.length === 0 && <p className="p-3 text-xs text-text-subtle">{t.workspace_no_recents}</p>}
                {recents.map((n) => (
                  <CtxRoot key={n.id}>
                    <CtxTrigger
                      render={
                        <button
                          type="button"
                          className="recent-note"
                          onClick={() => { setRecentsOpen(false); setView("memos"); select(n.id); }}
                        />
                      }
                    >
                      <FileText size={16} aria-hidden />
                      <span className="recent-note-copy">
                        <span className="recent-note-title">{n.title || t.empty_memo}</span>
                        <span className="recent-note-meta">{n.folder ? folderDisplayName(n.folder, t, dailyFolder) : t.vault_root} · {relativeTime(n.updated_at, locale)}</span>
                      </span>
                    </CtxTrigger>
                    {/* 최근 항목도 노트 — 모든 노트 표면이 동일 메뉴(설계 §3.1).
                        팝오버 안 CtxRoot 중첩은 포털이라 충돌 없음. */}
                    <NoteCtxMenu
                      memo={n}
                      folderEntries={noteActions.folderEntries}
                      onToggleFavorite={(id, favorite) => { setRecentsOpen(false); noteActions.onToggleFavorite(id, favorite); }}
                      onMoveFolder={(id, folder) => { setRecentsOpen(false); noteActions.onMoveFolder(id, folder); }}
                      onCopyBody={(id) => { setRecentsOpen(false); noteActions.onCopyBody(id); }}
                      onDelete={(id) => { setRecentsOpen(false); noteActions.onDelete(id); }}
                    />
                  </CtxRoot>
                ))}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
        <button type="button" className="sidebar-command-trigger" aria-label={t.command_palette_title} title={`${t.command_palette_title} · ⌘K`} onClick={() => useUI.getState().setCmdPaletteOpen(true)}>
          <Search size={15} aria-hidden />
        </button>
      </div>
          <CtxMenu>
            <CtxItem icon={FileText} label={t.new_note_md} onClick={onRequestAdd} />
            <CtxItem icon={FolderPlus} label={t.folder_new} onClick={() => createFolderAt("", (foldersQ.data ?? []).map((f) => f.path))} />
            <CtxSeparator />
            <CtxItem icon={Plus} label={t.query_new} onClick={createQuery} />
          </CtxMenu>
        </CtxTrigger>
      </CtxRoot>
    </motion.aside>
  );
}
/** One pinned FOLDERS row: navigation + full management (inline rename,
 *  armed delete) + a drop target for note/folder drops (T14) AND pin
 *  reordering (⠿ handle, top/bottom-half = before/after). Extracted so
 *  the hooks run at a stable index inside the pins map. */
function SidebarFolderRow({
  path,
  icon,
  folders,
  selected,
  naming,
  pinPaths,
  onOpen,
  onUnpin,
  onRename,
  onNameCommit,
  onDelete,
  onReorder,
  onMoveNote,
  onMoveFolderTree,
}: {
  path: string;
  /** Collection icon override — pinned folder carrying a preset marker. */
  icon?: React.ReactNode;
  folders: FolderDef[];
  selected: boolean;
  /** Inline rename session active for this row. */
  naming: boolean;
  /** Current pin order (for reorder computation). */
  pinPaths: string[];
  onOpen: (path: string) => void;
  onUnpin: (path: string) => void;
  onRename: (path: string) => void;
  onNameCommit: (path: string, name: string | null) => void;
  onDelete: (path: string) => void;
  onReorder: (order: string[]) => void;
  onMoveNote: (id: string, folder: string) => void;
  /** Move a dragged folder subtree into this row's folder (drop target). */
  onMoveFolderTree?: (path: string, dest: string) => void;
}) {
  const { t } = useI18n();
  // Reveal the ⋯ button on hover OR keyboard focus (so keyboard users can
  // tab to it; without this the button stays invisible even when focused,
  // since opacity-0 hides the focus ring too).
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const showMore = hovered || focused && !naming;
  // Two-click armed delete (FolderMenu rules): arm resets when the menu
  // closes and auto-expires after 4s.
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<number | null>(null);
  const disarm = () => {
    setArmed(false);
    if (armTimer.current) {
      window.clearTimeout(armTimer.current);
      armTimer.current = null;
    }
  };
  useEffect(() => () => disarm(), []);
  // Recursive note count for the delete confirm wording. The card for
  // `path` itself lives in the PARENT's children list.
  const parent = parentOf(path);
  const siblingsQ = useQuery({
    queryKey: ["folderChildren", parent],
    queryFn: () => folderChildren(parent),
    staleTime: Infinity,
  });
  const deep =
    siblingsQ.data?.find((c) => c.path === path)?.note_count_deep ?? 0;

  // Pin-reorder drop state: which half of the row the ⠿ hovers.
  const draggingPin = useUI((s) => s.draggingPin);
  const setDraggingPin = useUI((s) => s.setDraggingPin);
  const [pinHalf, setPinHalf] = useState<"before" | "after" | null>(null);
  const pinSource = draggingPin && draggingPin !== path ? draggingPin : null;

  // M16: the row is inert while the dragged note already lives here.
  // Folder drags land here too (cycles/parent no-ops suppressed in the
  // hook) — dropping a folder on a pin moves it there.
  const { dropCls, ...dropProps } = useFolderDrop(
    path,
    (id) => onMoveNote(id, path),
    onMoveFolderTree ? (p) => onMoveFolderTree(p, path) : undefined,
  );
  const { displayName: displayFolder } = useFolderNames();
  const base = path.split("/").at(-1) ?? path;
  return (
    <CtxRoot onOpenChange={(open) => !open && disarm()}>
      <CtxTrigger
        render={
          <div
            data-sidebar-folder={path}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onDragOver={(e: React.DragEvent) => {
              if (pinSource) {
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setPinHalf(e.clientY < r.top + r.height / 2 ? "before" : "after");
                return;
              }
              dropProps.onDragOver(e);
            }}
            onDragLeave={() => {
              setPinHalf(null);
              dropProps.onDragLeave();
            }}
            onDrop={(e: React.DragEvent) => {
              if (pinSource) {
                e.preventDefault();
                const half = pinHalf ?? "after";
                setPinHalf(null);
                const rest = pinPaths.filter((p) => p !== pinSource);
                const at = rest.indexOf(path);
                const insertAt = half === "before" ? at : at + 1;
                rest.splice(insertAt, 0, pinSource);
                onReorder(rest);
                return;
              }
              dropProps.onDrop(e);
            }}
            className={`group mx-2 flex items-center gap-1 rounded-md pr-1 text-[13px] ${
              selected
                ? "bg-surface-muted font-semibold text-text"
                : "hover:bg-surface-muted text-text-muted transition-colors duration-150"
            } ${dropCls ?? ""} ${
              pinSource && pinHalf === "before"
                ? "shadow-[inset_0_2px_0_0_var(--color-focus-ring)]"
                : pinSource && pinHalf === "after"
                  ? "shadow-[inset_0_-2px_0_0_var(--color-focus-ring)]"
                  : ""
            }`}
          />
        }
      >
        {!naming && (
          <button
            type="button"
            onClick={() => onOpen(path)}
            className="flex flex-1 items-center gap-2 truncate px-2 py-1.5 text-left"
          >
            {icon ?? (
              <Folder
                size={12}
                style={{ color: colorForFolder(path, folders) }}
              />
            )}
            <span className="truncate">{displayFolder(path)}</span>
          </button>
        )}
        {naming && (
          <TextCtxMenu
            render={
              <input
                autoFocus
                defaultValue={base}
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => onNameCommit(path, e.currentTarget.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") onNameCommit(path, e.currentTarget.value);
                  else if (e.key === "Escape") onNameCommit(path, null);
                }}
                style={{ boxShadow: "none" }}
                className="flex-1 min-w-0 rounded-md bg-transparent px-1 py-1.5 text-[13px] font-semibold text-text outline-none"
              />
            }
          />
        )}
        {!naming && (
          <span
            aria-hidden
            title={t.pin_reorder_hint ?? "Reorder"}
            draggable
            onDragStart={(e) => {
              setDraggingPin(path);
              e.dataTransfer.setData("application/x-oximemo-pin", path);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => {
              setDraggingPin(null);
              setPinHalf(null);
            }}
            className={`grid size-4 cursor-grab place-items-center rounded-sm text-text-subtle hover:text-text ${
              showMore ? "opacity-100" : "opacity-0"
            }`}
          >
            <GripVertical size={11} />
          </span>
        )}
        <button
          type="button"
          aria-label={t.folder_unpin}
          title={t.folder_unpin}
          // Base UI's ContextMenu.Trigger only opens on right-click/
          // long-press — we want one-click unpin as the primary
          // affordance, so onClick is wired directly.
          onClick={() => onUnpin(path)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className={`grid size-5 place-items-center rounded-sm text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text ${
            showMore ? "opacity-100" : "opacity-0"
          }`}
        >
          <MoreHorizontal size={12} />
        </button>
        <CtxMenu>
          <CtxItem label={t.folder_open} onClick={() => onOpen(path)} />
          <CtxItem
            icon={PenLine}
            label={t.rename_folder}
            onClick={() => onRename(path)}
          />
          <CtxItem label={t.folder_unpin} onClick={() => onUnpin(path)} />
          <CtxSeparator />
          {armed ? (
            <CtxItem
              icon={Trash2}
              label={t.delete_confirm_arm}
              danger
              title={t.delete_folder_confirm
                .replace("{folder}", base)
                .replace("{n}", String(deep))}
              onClick={() => {
                disarm();
                onDelete(path);
              }}
            />
          ) : (
            <CtxItem
              icon={Trash2}
              label={t.delete_folder_action}
              danger
              keepOpen
              onClick={() => {
                setArmed(true);
                if (armTimer.current) window.clearTimeout(armTimer.current);
                armTimer.current = window.setTimeout(disarm, 4000);
              }}
            />
          )}
        </CtxMenu>
      </CtxTrigger>
    </CtxRoot>
  );
}
/** One icon cell of the FAVORITES grid: icon-only navigation whose name
 *  (and count, when any) rides a native-title hover — the sidebar's
 *  compression for fixed smart collections. */
function NavCell({
  icon,
  title,
  selected,
  onClick,
  count,
}: {
  icon: React.ReactNode;
  title: string;
  selected: boolean;
  onClick: () => void;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-current={selected ? "page" : undefined}
      className={`sidebar-nav-item flex w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs focus-visible:outline-2 focus-visible:outline-focus-ring ${
        selected
          ? "bg-surface-muted text-text"
          : "text-text-muted hover:bg-surface-muted hover:text-text transition-colors duration-150"
      }`}
    >
      {icon}
      <span className="truncate">{title}</span>
      {count !== undefined && <span className="sidebar-count">{count}</span>}
    </button>
  );
}

/** One LOCATIONS icon cell (vault root / daily / knowledge): icon-only
 *  navigation that is also a drop target — dropping a note moves it to
 *  this folder, dropping a folder subtree reparents it here (T14). */
function LocationCell({
  path,
  icon,
  label,
  selected,
  onClick,
  onMoveNote,
  onMoveFolderTree,
}: {
  path: string;
  icon: React.ReactNode;
  label: string;
  selected: boolean;
  onClick: () => void;
  onMoveNote: (id: string, folder: string) => void;
  onMoveFolderTree?: (p: string, dest: string) => void;
}) {
  const { dropCls, ...dropProps } = useFolderDrop(
    path,
    (id) => onMoveNote(id, path),
    onMoveFolderTree ? (p) => onMoveFolderTree(p, path) : undefined,
  );
  return (
    <div {...dropProps} className={dropCls ?? ""}>
      <button
        type="button"
        onClick={onClick}
        title={label}
        aria-current={selected ? "page" : undefined}
        className={`sidebar-nav-item flex w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs focus-visible:outline-2 focus-visible:outline-focus-ring ${
          selected
            ? "bg-surface-muted text-text"
            : "text-text-muted hover:bg-surface-muted hover:text-text transition-colors duration-150"
        }`}
      >
        {icon}
        <span className="truncate">{label}</span>
      </button>
    </div>
  );
}

/** One pinned first-party COLLECTION cell in the LOCATIONS grid: the
 *  preset icon identifies it, the full folder name rides the hover
 *  title, and management (rename / unpin / armed delete) lives in the
 *  right-click menu — the ⠿-reorder gesture stays on the regular pin
 *  rows. Drop target like every LOCATIONS cell (T14). */
function CollectionCell({
  path,
  icon,
  folders,
  selected,
  naming,
  onOpen,
  onUnpin,
  onRename,
  onNameCommit,
  onDelete,
  onMoveNote,
  onMoveFolderTree,
}: {
  path: string;
  icon?: React.ReactNode;
  folders: FolderDef[];
  selected: boolean;
  /** Inline rename session active for this cell. */
  naming: boolean;
  onOpen: (path: string) => void;
  onUnpin: (path: string) => void;
  onRename: (path: string) => void;
  onNameCommit: (path: string, name: string | null) => void;
  onDelete: (path: string) => void;
  onMoveNote: (id: string, folder: string) => void;
  onMoveFolderTree?: (p: string, dest: string) => void;
}) {
  const { t } = useI18n();
  // Two-click armed delete (FolderMenu rules): arm resets when the menu
  // closes and auto-expires after 4s.
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<number | null>(null);
  const disarm = () => {
    setArmed(false);
    if (armTimer.current) {
      window.clearTimeout(armTimer.current);
      armTimer.current = null;
    }
  };
  useEffect(() => () => disarm(), []);
  // Recursive note count for the delete confirm wording — same query key
  // the pin rows use, so both surfaces share one fetch.
  const parent = parentOf(path);
  const siblingsQ = useQuery({
    queryKey: ["folderChildren", parent],
    queryFn: () => folderChildren(parent),
    staleTime: Infinity,
  });
  const deep =
    siblingsQ.data?.find((c) => c.path === path)?.note_count_deep ?? 0;
  const { dropCls, ...dropProps } = useFolderDrop(
    path,
    (id) => onMoveNote(id, path),
    onMoveFolderTree ? (p) => onMoveFolderTree(p, path) : undefined,
  );
  const { displayName: displayFolder } = useFolderNames();
  const base = path.split("/").at(-1) ?? path;
  // Inline rename spans two grid columns — a 44px cell can't host an
  // input for collection-length names.
  if (naming) {
    return (
      <input
        autoFocus
        defaultValue={base}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => onNameCommit(path, e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onNameCommit(path, e.currentTarget.value);
          else if (e.key === "Escape") onNameCommit(path, null);
        }}
        style={{ boxShadow: "none" }}
        className="col-span-2 min-w-0 rounded-md bg-surface-muted px-1.5 py-1 text-[12px] font-semibold text-text outline-none"
      />
    );
  }
  return (
    <CtxRoot onOpenChange={(open) => !open && disarm()}>
      <CtxTrigger
        render={
          <div {...dropProps} className={dropCls ?? ""}>
            <button
              type="button"
              onClick={() => onOpen(path)}
              title={displayFolder(path)}
              aria-current={selected ? "page" : undefined}
              className={`sidebar-nav-item flex w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs focus-visible:outline-2 focus-visible:outline-focus-ring ${
                selected
                  ? "bg-surface-muted text-text"
                  : "text-text-muted hover:bg-surface-muted hover:text-text transition-colors duration-150"
              }`}
            >
              {icon ?? (
                <Folder size={18} style={{ color: colorForFolder(path, folders) }} />
              )}
              <span className="truncate">{displayFolder(path)}</span>
            </button>
          </div>
        }
      >
        <CtxMenu>
          <CtxItem label={t.folder_open} onClick={() => onOpen(path)} />
          <CtxItem
            icon={PenLine}
            label={t.rename_folder}
            onClick={() => onRename(path)}
          />
          <CtxItem label={t.folder_unpin} onClick={() => onUnpin(path)} />
          <CtxSeparator />
          {armed ? (
            <CtxItem
              icon={Trash2}
              label={t.delete_confirm_arm}
              danger
              title={t.delete_folder_confirm
                .replace("{folder}", base)
                .replace("{n}", String(deep))}
              onClick={() => {
                disarm();
                onDelete(path);
              }}
            />
          ) : (
            <CtxItem
              icon={Trash2}
              label={t.delete_folder_action}
              danger
              keepOpen
              onClick={() => {
                setArmed(true);
                if (armTimer.current) window.clearTimeout(armTimer.current);
                armTimer.current = window.setTimeout(disarm, 4000);
              }}
            />
          )}
        </CtxMenu>
      </CtxTrigger>
    </CtxRoot>
  );
}
