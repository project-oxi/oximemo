/**
 * Collapsible left sidebar (§7): curation-only surface. Smart collections
 * (모든 노트 / 즐겨찾기 / 갤러리) sit at the top, TAGS in the middle, and a
 * flat FOLDERS list at the bottom. The FOLDERS list mirrors the user's
 * explicit pins from config; before any pin exists we fall back to the
 * top-level folders so the sidebar is never empty on first run.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpDown, Folder, Images, Layers, MoreHorizontal, Star } from "lucide-react";
import { useState } from "react";

import { listFacets, memoStats, listFolders, getConfig, setFolderPinned } from "../lib/api";
import { colorForFolder } from "../lib/color";
import { useI18n } from "../lib/i18n";
import { CtxRoot, CtxTrigger, CtxMenu, CtxItem } from "./ContextMenu";
import { useUI, type TagState } from "../stores/ui";
import type { FolderEntry, FolderDef } from "../lib/types";

const STATE_CLASS: Record<TagState, string> = {
  off: "bg-surface-muted text-text-muted hover:bg-surface-muted/80",
  in: "bg-hue-amber font-semibold text-text-inverse",
  out: "border border-hue-amber text-hue-amber line-through",
};

export function Sidebar() {
  const { t } = useI18n();
  const facets = useQuery({ queryKey: ["facets"], queryFn: listFacets });
  const stats = useQuery({ queryKey: ["stats"], queryFn: memoStats });
  const foldersQ = useQuery({ queryKey: ["folders"], queryFn: listFolders });
  const configQ = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const tagFilter = useUI((s) => s.tagFilter);
  const cycleTag = useUI((s) => s.cycleTag);
  const clearTagFilter = useUI((s) => s.clearTagFilter);
  const matchAll = useUI((s) => s.matchAll);
  const toggleMatchAll = useUI((s) => s.toggleMatchAll);
  const folderFilter = useUI((s) => s.folderFilter);
  const setFolderFilter = useUI((s) => s.setFolderFilter);
  const favoritesOnly = useUI((s) => s.favoritesOnly);
  const setFavoritesOnly = useUI((s) => s.setFavoritesOnly);
  const view = useUI((s) => s.view);
  const setView = useUI((s) => s.setView);
  const setError = useUI((s) => s.setError);
  const qc = useQueryClient();

  // Track which pinned row the user is currently hovering OR has keyboard-focused
  // so the ⋯ button stays visible in both cases. The ⋯ is the row's primary
  // unpin affordance; we mirror hover with focus so keyboard users can reach it.
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);

  const tags = facets.data?.tags ?? [];
  const folders: FolderDef[] = configQ.data?.folders ?? [];
  const total = stats.data?.memos ?? 0;
  const favoritesCount = stats.data?.favorites ?? 0;

  // FOLDERS section: explicit pinned rows when the user has set any pin;
  // otherwise show top-level folder entries so the sidebar is never empty
  // on first run. Nested folders stay out — browse is what reveals them.
  const pins = folders.filter((f) => f.pinned);
  const explicit = pins.length > 0;
  const seed: FolderEntry[] = explicit
    ? []
    : (foldersQ.data ?? []).filter((f) => f.path !== "" && !f.path.includes("/"));
  const shownPaths: string[] = explicit
    ? pins.map((f) => f.path)
    : seed.map((f) => f.path);

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
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-surface-sunken/60">
      <div data-tauri-drag-region className="h-12 shrink-0" />

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
        onClick={() => { setView("memos"); setFavoritesOnly(true); }}
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
            <button
              key={tag}
              type="button"
              onClick={() => {
                // Picking a tag from the curation sidebar is a vault-wide
                // intent — drop any folder/favorite scope so the "모든 노트"
                // smart collection owns the view (Task 9 acceptance).
                setView("memos");
                setFavoritesOnly(false);
                setFolderFilter(null);
                cycleTag(tag);
              }}
              className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${STATE_CLASS[st]}`}
            >
              #{tag} <span className="opacity-60">{count}</span>
            </button>
          );
        })}
      </div>

      {shownPaths.length > 0 && (
        <>
          <div className="mt-3 flex items-center px-3">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
              {t.folders_pinned_section}
            </span>
          </div>
          <div className="flex flex-col px-2 pt-1">
            {shownPaths.map((path) => {
              const selected = folderFilter === path;
              // Reveal the ⋯ button on hover OR keyboard focus (so keyboard
              // users can tab to it; without this the button stays invisible
              // even when focused, since opacity-0 hides the focus ring too).
              const showMore = explicit && (hoveredPath === path || focusedPath === path);
              return (
                <div
                  key={path}
                  data-sidebar-folder={path}
                  onMouseEnter={() => setHoveredPath(path)}
                  onMouseLeave={() => setHoveredPath((cur) => (cur === path ? null : cur))}
                  className={`group flex items-center gap-1 rounded-md py-0.5 pr-1 text-[13px] ${
                    selected
                      ? "bg-surface-muted font-semibold text-text"
                      : "hover:bg-surface-muted text-text-muted"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => openFolder(path)}
                    className="flex flex-1 items-center gap-2 truncate px-2 py-0.5 text-left"
                  >
                    <Folder
                      size={12}
                      style={{ color: colorForFolder(path, folders) }}
                    />
                    <span className="truncate">{path}</span>
                  </button>
                  {explicit && (
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
                            onClick={() => unpin(path)}
                            onFocus={() => setFocusedPath(path)}
                            onBlur={() => setFocusedPath((cur) => (cur === path ? null : cur))}
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
                          onClick={() => openFolder(path)}
                        />
                        <CtxItem
                          label={t.folder_unpin}
                          onClick={() => unpin(path)}
                        />
                      </CtxMenu>
                    </CtxRoot>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </aside>
  );
}
