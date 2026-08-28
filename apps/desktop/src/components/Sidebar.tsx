/**
 * Collapsible left sidebar — Finder-model curation surface: FAVORITES
 * (smart collections 전체 메모/즐겨찾기/갤러리), LOCATIONS (볼트 root
 * browse entry + explicitly pinned folders), DAILY (today row + mini
 * calendar as one block), RECENTS, and TAGS. Folder browsing happens in
 * the main area; the 볼트 row enters it at the root.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowUpDown, CalendarDays, Database, Folder, GraduationCap, GripVertical, Images, Layers, ListChecks, MoreHorizontal, PenLine, Plus, Star, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { listFacets, memoStats, listMemos, getConfig, setFolderPinned, openDailyNote, renameFolder, deleteFolder, setPinOrder, folderChildren, renameTag, listBases, renameBase, trashBase, restoreBase } from "../lib/api";
import { createQueryCollection, defaultQueryYaml } from "../lib/queryCreation";
import { colorForFolder } from "../lib/color";
import { dayLabel, todayLocalISO } from "../lib/dates";
import { useFolderDrop, parentOf } from "../lib/dropTarget";
import { useI18n } from "../lib/i18n";
import { folderDisplayName, useFolderNames, useSchemaInfo, DEFAULT_KNOWLEDGE_FOLDER } from "../lib/folders";
import { COLLECTION_CATALOG } from "../lib/collectionCatalog";
import { toneBg } from "../lib/propDisplay";
import { listen } from "../lib/tauri";
import { CtxRoot, CtxTrigger, CtxMenu, CtxItem, CtxSeparator } from "./ContextMenu";
import { Calendar } from "./Calendar";
import { TextCtxMenu } from "./TextCtxMenu";
import { useUI, type TagState } from "../stores/ui";
import type { FolderDef } from "../lib/types";
/** Static preset-id → icon table (drives 위치 collection rows). */
const PRESET_ICON: Record<string, (typeof COLLECTION_CATALOG)[number]["icon"]> =
  Object.fromEntries(COLLECTION_CATALOG.map((c) => [c.id, c.icon]));

/** The one-shot installed `할 일` base (tasks spec §7.4) — must match
 *  the Rust `TASKS_BASE_REL` seed path in vault.rs. */
const TASKS_BASE_PATH = "queries/할 일.query";

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
  const { t, locale } = useI18n();
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
  const setDraftId = useUI((s) => s.setDraftId);
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

  // Daily notes: opt-out via config (absent = enabled). Config drives
  // folder + flag; the calendar query refreshes the dot set as memos
  // change (T5 added the openDailyNote + listMemos(folder) wiring and
  // the memos:changed listener invalidates ["memos"] prefix).
  const dailyCfg = configQ.data?.daily;
  const dailyEnabled = dailyCfg?.enabled !== false;
  const dailyFolder = dailyCfg?.folder || "daily";
  // Tasks surface (spec 2026-08-27 §7.4/§11): the installed `할 일`
  // base entry is gated by `[tasks] enabled` (absent = enabled, like
  // daily) and by the base file existing — deliberate deletion is
  // permanent, so the entry disappears with it.
  const tasksEnabled = configQ.data?.tasks?.enabled !== false;
  const hasTasksBase = bases.some((b) => b.path === TASKS_BASE_PATH);
  const dailyQ = useQuery({
    queryKey: ["memos", "daily", dailyFolder],
    queryFn: () => listMemos(null, 500, { folder: dailyFolder }),
    enabled: dailyEnabled,
  });
  const dailyDates = new Set(
    (dailyQ.data?.items ?? [])
      .filter((n) => n.path.startsWith(`${dailyFolder}/`))
      .map((n) => n.path.match(/\/(\d{4}-\d{2}-\d{2})\.(md|html)$/)?.[1])
      .filter((d): d is string => Boolean(d)),
  );
  // Mood-colored dots (user prompt 2026-08-23): the daily folder's
  // badge property (declared by its SCHEMA.toml — mood in the shipped
  // preset) tints the day's dot. Days without the property stay
  // neutral; folders without a schema keep plain dots.
  const dailySchemas = useSchemaInfo(dailyEnabled ? [dailyFolder] : []);
  const dailySchema = dailySchemas[dailyFolder];
  const badgeProp = useMemo(() => {
    const props = dailySchema?.properties;
    if (!props) return null;
    const key = Object.keys(props).find((k) => props[k].badge);
    return key ? { key, colors: props[key].colors } : null;
  }, [dailySchema]);
  const moodDot = useMemo(() => {
    if (!badgeProp) return undefined;
    const byDate = new Map<string, string>();
    for (const n of dailyQ.data?.items ?? []) {
      const d = n.path.match(/\/(\d{4}-\d{2}-\d{2})\.(md|html)$/)?.[1];
      const v = d ? n.props?.[badgeProp.key] : undefined;
      if (d && v && "Str" in v) byDate.set(d, v.Str);
    }
    return (date: string) => {
      const v = byDate.get(date);
      return v ? toneBg(badgeProp.colors?.[v]) : null;
    };
  }, [badgeProp, dailyQ.data]);

  const openDaily = (date: string) => {
    openDailyNote(date)
      .then(({ memo, created }) => {
        setView("memos");
        select(memo.id);
        // Fresh daily note: closing it untouched (template body intact)
        // discards it. Adopted/visited notes are never discardable.
        if (created) setDraftId(memo.id, memo.body);
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  const openFolder = (path: string) => {
    setView("memos");
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
    <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface-sunken/60">
      <div data-tauri-drag-region className="h-12 shrink-0" />

      {/* FAVORITES — smart collections only. Folder locations (pinned or
          the vault root) live in LOCATIONS below. */}
      <div className="flex items-center px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
          {t.favorites_section}
        </span>
      </div>
      <button
        type="button"
        onClick={() => { setView("memos"); setFavoritesOnly(false); setFolderFilter(null); }}
        className={`mx-2 flex items-center justify-between rounded-md px-2 py-1.5 text-[13px] ${
          view === "memos" && !favoritesOnly && folderFilter === null
            ? "bg-surface-muted font-semibold text-text"
            : "text-text-muted hover:bg-surface-muted"
        }`}
      >
        <span className="flex items-center gap-2"><Layers size={14} /> {t.all_memos}</span>
        <span className="text-[11px] text-text-subtle">{total}</span>
      </button>
      <button
        type="button"
        onClick={() => { setView("memos"); setFolderFilter(null); setFavoritesOnly(true); }}
        className={`mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${
          view === "memos" && favoritesOnly
            ? "bg-surface-muted font-semibold text-text"
            : "text-text-muted hover:bg-surface-muted"
        }`}
      >
        <Star size={14} /> {t.favorite}
        {favoritesCount > 0 && <span className="ml-auto text-[11px] text-text-subtle">{favoritesCount}</span>}
      </button>
      <button
        type="button"
        onClick={() => setView("gallery")}
        className={`mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${
          view === "gallery"
            ? "bg-surface-muted font-semibold text-text"
            : "text-text-muted hover:bg-surface-muted"
        }`}
      >
        <Images size={14} /> {t.gallery}
      </button>
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
      ) : bases.length === 0 ? (
        <div className="mx-2 px-2 py-1 text-[11px] text-text-subtle/70">{t.query_none}</div>
      ) : (
        bases.map((b) => {
          const active = location.kind === "base" && "path" in location.source && location.source.path === b.path;
          const warn = !b.loadable || ambiguousNames.has(b.name);
          const renaming = queryNaming === b.path;
          return (
            <CtxRoot key={b.path}>
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
                <CtxTrigger
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
                <CtxMenu>
                  <CtxItem
                    icon={PenLine}
                    label={t.query_rename}
                    onClick={() => setQueryNaming(b.path)}
                  />
                  <CtxItem
                    icon={Trash2}
                    label={t.query_delete}
                    onClick={() => deleteQuery(b.path)}
                  />
                </CtxMenu>
              </div>
            </CtxRoot>
          );
        })
      )}
      {/* LOCATIONS — the vault root browse entry (folder tiles live in the
          main area; this is how you get back to top-level browsing), the
          daily folder (a real path — the calendar block below navigates
          notes, this browses the folder), and pinned folders. */}
      <div className="mt-3 flex items-center px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
          {t.locations_section}
        </span>
      </div>
      <LocationsRow
        path=""
        selected={view === "memos" && !favoritesOnly && folderFilter === ""}
        onClick={() => {
          setView("memos");
          setFavoritesOnly(false);
          setFolderFilter("");
        }}
        onMoveNote={onMoveNote}
        onMoveFolderTree={onMoveFolderTree}
        icon={<Archive size={14} />}
        label={t.vault_root}
      />
      {dailyEnabled && dailyFolder && (
        <LocationsRow
          path={dailyFolder}
          selected={view === "memos" && !favoritesOnly && folderFilter === dailyFolder}
          onClick={() => openFolder(dailyFolder)}
          onMoveNote={onMoveNote}
          onMoveFolderTree={onMoveFolderTree}
          icon={<CalendarDays size={14} />}
          label={folderDisplayName(dailyFolder, t, dailyFolder)}
        />
      )}
      {/* The knowledge folder is a shipped system folder (migrate
          guarantees it, macOS Desktop-style) — always present in
          LOCATIONS like the daily row, unless the user pinned it
          (a pin would render a duplicate row below). */}
      {!pinPaths.includes(DEFAULT_KNOWLEDGE_FOLDER) && (
        <LocationsRow
          path={DEFAULT_KNOWLEDGE_FOLDER}
          selected={view === "memos" && !favoritesOnly && folderFilter === DEFAULT_KNOWLEDGE_FOLDER}
          onClick={() => openFolder(DEFAULT_KNOWLEDGE_FOLDER)}
          onMoveNote={onMoveNote}
          onMoveFolderTree={onMoveFolderTree}
          icon={<GraduationCap size={14} />}
          label={t.sysfolder_knowledge}
        />
      )}
      {pins.map((f) => (
        <SidebarFolderRow
          key={f.path}
          path={f.path}
          icon={presetIcons[f.path]}
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

      {/* DAILY — one integrated block: the today row opens today's note,
          the mini calendar below it dots days that have one; clicking a
          day opens or creates it. */}
      {dailyEnabled && (
        <>
          <div className="mt-3 flex items-center px-3">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
              {t.daily_section}
            </span>
          </div>
          <button
            data-daily-today
            type="button"
            onClick={() => openDaily(todayLocalISO())}
            className="mx-2 mt-1 flex w-[calc(100%-1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-text-muted transition-colors hover:bg-surface-muted hover:text-text"
          >
            <CalendarDays size={14} className="text-hue-blue" />
            <span className="font-medium">{t.today_note}</span>
            <span className="ml-auto text-[10px] text-text-subtle">{dayLabel(todayLocalISO(), locale)}</span>
          </button>
          <div className="px-2 pt-1">
            <Calendar
              dates={dailyDates}
              today={todayLocalISO()}
              locale={locale}
              onSelect={openDaily}
              dotTone={moodDot}
            />
          </div>
        </>
      )}
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
                key={n.id}
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

/** One LOCATIONS row (볼트 root / daily): navigation button that is
 *  also a drop target — dropping a note moves it to this folder,
 *  dropping a folder subtree reparents it here (T14 semantics).
 *  Extracted so useFolderDrop runs at a stable hook index. */
function LocationsRow({
  path,
  selected,
  onClick,
  onMoveNote,
  onMoveFolderTree,
  icon,
  label,
}: {
  path: string;
  selected: boolean;
  onClick: () => void;
  onMoveNote: (id: string, folder: string) => void;
  onMoveFolderTree?: (p: string, dest: string) => void;
  icon: React.ReactNode;
  label: string;
}) {
  const { dropCls, ...dropProps } = useFolderDrop(
    path,
    (id) => onMoveNote(id, path),
    onMoveFolderTree ? (p) => onMoveFolderTree(p, path) : undefined,
  );
  return (
    <div {...dropProps} className={`mx-2 rounded-md ${dropCls ?? ""}`}>
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${
          selected
            ? "bg-surface-muted font-semibold text-text"
            : "text-text-muted hover:bg-surface-muted"
        }`}
      >
        {icon} <span className="truncate">{label}</span>
      </button>
    </div>
  );
}
