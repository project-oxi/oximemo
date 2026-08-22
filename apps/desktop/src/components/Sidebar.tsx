/**
 * Collapsible left sidebar — Finder-model curation surface: FAVORITES
 * (smart collections 전체 메모/즐겨찾기/갤러리), LOCATIONS (볼트 root
 * browse entry + explicitly pinned folders), DAILY (today row + mini
 * calendar as one block), RECENTS, and TAGS. Folder browsing happens in
 * the main area; the 볼트 row enters it at the root.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowUpDown, CalendarDays, Folder, Images, Layers, MoreHorizontal, Star } from "lucide-react";
import { useState } from "react";

import { listFacets, memoStats, listMemos, getConfig, setFolderPinned, openDailyNote } from "../lib/api";
import { colorForFolder } from "../lib/color";
import { dayLabel, todayLocalISO } from "../lib/dates";
import { useFolderDrop } from "../lib/dropTarget";
import { useI18n } from "../lib/i18n";
import { CtxRoot, CtxTrigger, CtxMenu, CtxItem, CtxSeparator } from "./ContextMenu";
import { Calendar } from "./Calendar";
import { useUI, type TagState } from "../stores/ui";
import type { FolderDef } from "../lib/types";

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
  const pins = folders.filter((f) => f.pinned);

  // Daily notes: opt-out via config (absent = enabled). Config drives
  // folder + flag; the calendar query refreshes the dot set as memos
  // change (T5 added the openDailyNote + listMemos(folder) wiring and
  // the memos:changed listener invalidates ["memos"] prefix).
  const dailyCfg = configQ.data?.daily;
  const dailyEnabled = dailyCfg?.enabled !== false;
  const dailyFolder = dailyCfg?.folder || "daily";
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
          label={dailyFolder}
        />
      )}
      {pins.map((f) => (
        <SidebarFolderRow
          key={f.path}
          path={f.path}
          folders={folders}
          selected={folderFilter === f.path}
          onOpen={openFolder}
          onUnpin={unpin}
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
            <Calendar dates={dailyDates} today={todayLocalISO()} locale={locale} onSelect={openDaily} />
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
/** One pinned FOLDERS row: a drop target (T14) with its own hover/focus
 *  state (the ⋯ unpin button reveal). Extracted so useFolderDrop runs at
 *  a stable hook index inside the pins map. */
function SidebarFolderRow({
  path,
  folders,
  selected,
  onOpen,
  onUnpin,
  onMoveNote,
  onMoveFolderTree,
}: {
  path: string;
  folders: FolderDef[];
  selected: boolean;
  onOpen: (path: string) => void;
  onUnpin: (path: string) => void;
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
  const showMore = hovered || focused;
  // M16: the row is inert while the dragged note already lives here.
  // Folder drags land here too (cycles/parent no-ops suppressed in the
  // hook) — dropping a folder on a pin moves it there.
  const { dropCls, ...dropProps } = useFolderDrop(
    path,
    (id) => onMoveNote(id, path),
    onMoveFolderTree ? (p) => onMoveFolderTree(p, path) : undefined,
  );
  return (
    <div
      data-sidebar-folder={path}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      {...dropProps}
      className={`group flex items-center gap-1 rounded-md py-0.5 pr-1 text-[13px] ${
        selected
          ? "bg-surface-muted font-semibold text-text"
          : "hover:bg-surface-muted text-text-muted"
      } ${dropCls ?? ""}`}
    >
      <button
        type="button"
        onClick={() => onOpen(path)}
        className="flex flex-1 items-center gap-2 truncate px-2 py-0.5 text-left"
      >
        <Folder
          size={12}
          style={{ color: colorForFolder(path, folders) }}
        />
        <span className="truncate">{path}</span>
      </button>
      <CtxRoot>
        <CtxTrigger
          render={
            <button
              type="button"
              aria-label={t.folder_unpin}
              title={t.folder_unpin}
              // Base UI's ContextMenu.Trigger only opens on
              // right-click/long-press — left-click / Enter on
              // the rendered button does nothing on its own.
              // We want one-click unpin (the row's primary
              // affordance) and keep the menu for the secondary
              // "open" path, so we wire onClick=unpin too.
              onClick={() => onUnpin(path)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              className={`grid size-5 place-items-center rounded-sm text-text-subtle hover:bg-surface-muted hover:text-text ${
                showMore ? "opacity-100" : "opacity-0"
              }`}
            />
          }
        >
          <MoreHorizontal size={12} />
        </CtxTrigger>
        <CtxMenu>
          <CtxItem
            label={t.folder_open}
            onClick={() => onOpen(path)}
          />
          <CtxItem
            label={t.folder_unpin}
            onClick={() => onUnpin(path)}
          />
        </CtxMenu>
      </CtxRoot>
    </div>
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
