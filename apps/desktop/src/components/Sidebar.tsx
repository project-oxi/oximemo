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
import { Archive, ArrowUpDown, CalendarDays, Database, Folder, GraduationCap, GripVertical, Images, Layers, ListChecks, MoreHorizontal, PenLine, Plus, Star, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SpacePicker } from "./SpacePicker";
import { listFacets, memoStats, listMemos, getConfig, setFolderPinned, renameFolder, deleteFolder, setPinOrder, folderChildren, renameTag, listBases, renameBase, trashBase, restoreBase } from "../lib/api";
import { createQueryCollection, defaultQueryYaml } from "../lib/queryCreation";
import { TASKS_BASE_PATH } from "../lib/tasksPanel";
import { colorForFolder } from "../lib/color";
import { listen } from "../lib/tauri";
import { CtxRoot, CtxTrigger, CtxMenu, CtxItem, CtxSeparator, BtnMenuRoot, BtnMenuTrigger, BtnMenuPopup, BtnMenuItem, BtnMenuSeparator } from "./ContextMenu";
import { useFolderDrop, parentOf } from "../lib/dropTarget";
import { useI18n } from "../lib/i18n";
import { folderDisplayName, useFolderNames, useSchemaInfo, DEFAULT_KNOWLEDGE_FOLDER } from "../lib/folders";
import { TasksPanel } from "./TasksPanel";
import { COLLECTION_CATALOG } from "../lib/collectionCatalog";
import { TextCtxMenu } from "./TextCtxMenu";
import { useUI, type TagState } from "../stores/ui";
import type { FolderDef } from "../lib/types";
/** Static preset-id → icon table (drives 위치 collection rows). */
const PRESET_ICON: Record<string, (typeof COLLECTION_CATALOG)[number]["icon"]> =
  Object.fromEntries(COLLECTION_CATALOG.map((c) => [c.id, c.icon]));

const STATE_CLASS: Record<TagState, string> = {
  off: "bg-surface-muted text-text-muted hover:bg-surface-muted/80",
  in: "bg-hue-amber font-semibold text-text-inverse",
  out: "border border-hue-amber text-hue-amber line-through",
};

export function Sidebar({
  onMoveNote,
  onMoveFolderTree,
}: {
  onMoveNote: (id: string, folder: string) => void;
  /** Move a dragged folder subtree into a pinned/seeded row's folder. */
  onMoveFolderTree?: (path: string, dest: string) => void;
}) {
  const { t } = useI18n();
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

  return (
    <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface-sunken/60 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div data-tauri-drag-region className="h-12 shrink-0" />

      {/* FAVORITES — one Finder-model curation grid: the smart
          collections (all notes / favorites / gallery), the vault
          locations (root, daily, knowledge), and pinned first-party
          collections grow in the same grid as pins are added (names on
          hover; collection cells manage rename/unpin/delete via the
          right-click menu). Regular pinned folders keep their rows. */}
      <div className="mt-3 flex items-center px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
          {t.favorites_section}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1 px-2 pt-1">
        {/* Smart collections lead the grid — the app's fixed,
            always-present destinations. */}
        <NavCell
          icon={<Layers size={18} aria-hidden />}
          title={total > 0 ? `${t.all_memos} · ${total}` : t.all_memos}
          selected={view === "memos" && !favoritesOnly && folderFilter === null}
          onClick={() => { setView("memos"); setFavoritesOnly(false); setFolderFilter(null); }}
        />
        <NavCell
          icon={<Star size={18} aria-hidden />}
          title={favoritesCount > 0 ? `${t.favorite} · ${favoritesCount}` : t.favorite}
          selected={view === "memos" && favoritesOnly}
          onClick={() => { setView("memos"); setFolderFilter(null); setFavoritesOnly(true); }}
        />
        <NavCell
          icon={<Images size={18} aria-hidden />}
          title={t.gallery}
          selected={view === "gallery"}
          onClick={() => setView("gallery")}
        />
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
          className={`mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${
            location.kind === "base" && "path" in location.source && location.source.path === TASKS_BASE_PATH
              ? "bg-surface-muted font-semibold text-text"
              : "text-text-muted hover:bg-surface-muted"
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
          return (
            <BtnMenuRoot key={b.path}>
              <div className="group/query relative mx-2">
                <button
                  type="button"
                  onClick={() => {
                    setView("memos");
                    openBase({ path: b.path });
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${
                    active
                      ? "bg-surface-muted font-semibold text-text"
                      : "text-text-muted hover:bg-surface-muted"
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
                  <BtnMenuItem
                    icon={PenLine}
                    label={t.query_rename}
                    onClick={() => setQueryNaming(b.path)}
                  />
                  <BtnMenuSeparator />
                  <BtnMenuItem
                    icon={Trash2}
                    label={t.query_delete}
                    danger
                    onClick={() => deleteQuery(b.path)}
                  />
                </BtnMenuPopup>
              </div>
            </BtnMenuRoot>
          );
        })
      )}


      {/* TASKS — slim companion to the full `할 일` base view (the
          chevron in the panel header opens the full one in the main
          area). Gated by the same `[tasks] enabled` rule as the 할 일
          row above; the installed base is protected (no user delete). */}
      {tasksEnabled && hasTasksBase && <TasksPanel />}
      {/* RECENTS — recently updated notes, one click to open. */}
      {recents.length > 0 && (
        <>
          <div className="mt-3 flex items-center px-3">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
              {t.recents_section}
            </span>
          </div>
          <div className="flex flex-col px-2 pt-1">
            {recents.map((n) => (
              <button
                type="button"
                onClick={() => { setView("memos"); select(n.id); }}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] text-text-muted hover:bg-surface-muted hover:text-text"
              >
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: colorForFolder(n.folder, folders) }}
                />
                <span className="truncate">{n.title ?? t.empty_memo}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {/* TAGS */}
      <div className="mt-3 flex items-center justify-between px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">{t.tags_section}</span>
        <button
          type="button"
          onClick={toggleMatchAll}
          className="inline-flex items-center gap-1 text-[10px] font-semibold text-hue-amber"
        >
          {matchAll ? t.match_all : t.match_any} <ArrowUpDown size={10} />
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5 px-3 pt-1">
        <button
          type="button"
          onClick={clearTagFilter}
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
      {/* SPACE — pinned to the sidebar's bottom edge (sticky inside the
          scroll container): the vault-level context stays reachable no
          matter how long the content above grows. */}
      <div className="sticky bottom-0 mt-auto border-t border-line bg-surface-sunken">
        <SpacePicker />
      </div>
    </aside>
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
                : "hover:bg-surface-muted text-text-muted"
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
          className={`grid size-5 place-items-center rounded-sm text-text-subtle hover:bg-surface-muted hover:text-text ${
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
}: {
  icon: React.ReactNode;
  title: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`grid size-11 place-items-center rounded-md ${
        selected
          ? "bg-surface-muted text-text"
          : "text-text-muted hover:bg-surface-muted hover:text-text"
      }`}
    >
      {icon}
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
        className={`grid size-11 place-items-center rounded-md ${
          selected
            ? "bg-surface-muted text-text"
            : "text-text-muted hover:bg-surface-muted hover:text-text"
        }`}
      >
        {icon}
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
              className={`grid size-11 place-items-center rounded-md ${
                selected
                  ? "bg-surface-muted text-text"
                  : "text-text-muted hover:bg-surface-muted hover:text-text"
              }`}
            >
              {icon ?? (
                <Folder size={18} style={{ color: colorForFolder(path, folders) }} />
              )}
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
