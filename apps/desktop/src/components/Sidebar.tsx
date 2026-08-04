/**
 * Collapsible left sidebar (§7): All memos / Favorites navigation, the tag list
 * with 3-state filter chips + AND/OR toggle, and the color filter swatches.
 * Counts come from `list_facets` (page-independent). Rendered only when the
 * sidebar is open; the collapse/expand toggle is a single fixed button
 * rendered by CardGrid so it never moves between states.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, Images, Star, Pencil, Palette, Trash2 } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import { listFacets, memoStats, listCategories, renameCategory, updateCategory, deleteCategory } from "../lib/api";
import { colorForCategory, COLOR_PRESETS, presetToString } from "../lib/color";
import { useI18n } from "../lib/i18n";
import { useUI, type TagState } from "../stores/ui";
import type { CategoryDef } from "../lib/types";
import { CtxRoot, CtxTrigger, CtxMenu, CtxItem, CtxSeparator, CtxSubmenu } from "./ContextMenu";

const STATE_CLASS: Record<TagState, string> = {
  off: "bg-surface-muted text-text-muted hover:bg-surface-muted/80",
  in: "bg-hue-amber font-semibold text-text-inverse",
  out: "border border-hue-amber text-hue-amber line-through",
};
/** One category row: click filters, right-click opens a context menu
 *  (rename / recolor / delete). Rename is inline, reusing the commit/Escape
 *  single-path guard from SettingsMenu's CategoriesSection. */
function CategoryRow({
  def,
  count,
  selected,
  catDefs,
}: {
  def: CategoryDef;
  count: number | undefined;
  selected: boolean;
  catDefs: CategoryDef[];
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const setCategory = useUI((s) => s.setCategory);
  const setToast = useUI((s) => s.setToast);
  const setError = useUI((s) => s.setError);
  const isInbox = def.id === "inbox";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(def.id);
  const cancelRef = useRef(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["facets"] });
    qc.invalidateQueries({ queryKey: ["memos"] });
  };

  // Enter blurs → onBlur commits; Escape sets a flag so the induced blur cancels
  // rather than committing (otherwise both keys would double-fire renameCategory).
  const commit = async () => {
    if (cancelRef.current) {
      cancelRef.current = false;
      setEditing(false);
      return;
    }
    const next = draft.trim();
    setEditing(false);
    if (!next || next === def.id) return;
    if (catDefs.some((c) => c.id === next)) {
      setError(`"${next}" already exists`);
      return;
    }
    try {
      const moved = await renameCategory(def.id, next);
      setToast(`${moved} ${moved === 1 ? "memo moved" : "memos moved"}`);
      invalidate();
    } catch (e) {
      setError(String(e).split("\n")[0]);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.currentTarget as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRef.current = true;
      (e.currentTarget as HTMLInputElement).blur();
    }
  };

  const btnCls = `flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm ${
    selected ? "bg-surface-muted font-semibold text-text" : "hover:bg-surface-muted"
  }`;

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
        className="min-w-0 rounded-md bg-surface px-2 py-1 text-sm outline-none shadow-[var(--input-shadow)] focus-visible:shadow-[var(--input-shadow-focus)] focus-visible:outline-none"
      />
    );
  }

  return (
    <CtxRoot>
      <CtxTrigger
        render={
          <button type="button" className={btnCls} onClick={() => setCategory(selected ? null : def.id)} />
        }
      >
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: colorForCategory(def.id, catDefs) }}
        />
        <span>{def.id}</span>
        {count !== undefined && <span className="ml-auto text-[11px] text-text-subtle">{count}</span>}
        <CtxMenu>
          <CtxItem
            icon={Pencil}
            label={t.action_rename}
            disabled={isInbox}
            onClick={() => {
              setDraft(def.id);
              setEditing(true);
            }}
          />
          <CtxSubmenu icon={Palette} label={t.color}>
            {COLOR_PRESETS.map((p) => (
              <CtxItem
                key={p.id}
                swatch={presetToString(p)}
                label={p.id}
                active={def.color === presetToString(p)}
                onClick={() =>
                  void updateCategory(def.id, presetToString(p))
                    .then(invalidate)
                    .catch((e) => setError(String(e).split("\n")[0]))
                }
              />
            ))}
            <CtxSeparator />
            <CtxItem
              label={t.no_color}
              active={def.color === ""}
              onClick={() =>
                void updateCategory(def.id, "")
                  .then(invalidate)
                  .catch((e) => setError(String(e).split("\n")[0]))
              }
            />
          </CtxSubmenu>
          <CtxSeparator />
          <CtxItem
            icon={Trash2}
            label={t.action_delete}
            danger
            disabled={isInbox}
            onClick={() =>
              void deleteCategory(def.id)
                .then(invalidate)
                .catch((e) => setError(String(e).split("\n")[0]))
            }
          />
        </CtxMenu>
      </CtxTrigger>
    </CtxRoot>
  );
}

export function Sidebar() {
  const { t } = useI18n();
  const facets = useQuery({ queryKey: ["facets"], queryFn: listFacets });
  const stats = useQuery({ queryKey: ["stats"], queryFn: memoStats });
  const tagFilter = useUI((s) => s.tagFilter);
  const cycleTag = useUI((s) => s.cycleTag);
  const clearTagFilter = useUI((s) => s.clearTagFilter);
  const matchAll = useUI((s) => s.matchAll);
  const toggleMatchAll = useUI((s) => s.toggleMatchAll);
  const categoryFilter = useUI((s) => s.categoryFilter);
  const setCategory = useUI((s) => s.setCategory);
  const favoritesOnly = useUI((s) => s.favoritesOnly);
  const setFavoritesOnly = useUI((s) => s.setFavoritesOnly);
  const view = useUI((s) => s.view);
  const setView = useUI((s) => s.setView);

  const tags = facets.data?.tags ?? [];
  const categories = facets.data?.categories ?? [];
  const catQuery = useQuery({ queryKey: ["categories"], queryFn: listCategories });
  const catDefs = catQuery.data ?? [];
  const total = stats.data?.memos ?? 0;
  const favoritesCount = stats.data?.favorites ?? 0;

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-surface-sunken/60">
      {/* Traffic-light drag region: reserve the 48px header band at the top of
          the sidebar so its content starts below the macOS lights. The sidebar
          toggle itself is a single fixed element rendered in CardGrid, so this
          strip only needs to hold the title-bar drag area. */}
      <div data-tauri-drag-region className="h-12 shrink-0" />

      <button
        type="button"
        onClick={() => { setView("memos"); setFavoritesOnly(false); }}
        className={`mx-2 flex items-center justify-between rounded-md px-2 py-1.5 text-[13px] ${
          view === "memos" && !favoritesOnly
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
          className="text-[10px] font-semibold text-hue-amber"
        >
          {matchAll ? t.match_all : t.match_any} ⇅
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
              onClick={() => cycleTag(tag)}
              className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${STATE_CLASS[st]}`}
            >
              #{tag} <span className="opacity-60">{count}</span>
            </button>
          );
        })}
      </div>

      {/* 카테고리 라디오 필터 */}
      <div className="mt-3 px-3">
        <label className="text-[11px] font-medium uppercase tracking-wider text-text-subtle">
          Category
        </label>
        <div className="mt-1 flex flex-col gap-0.5">
          <button
            className={`flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm ${
              categoryFilter === null
                ? "bg-surface-muted font-semibold text-text"
                : "hover:bg-surface-muted"
            }`}
            onClick={() => setCategory(null)}
          >
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-text-subtle" />
            <span>All</span>
          </button>
          {catDefs.map((c) => (
            <CategoryRow
              key={c.id}
              def={c}
              catDefs={catDefs}
              count={categories.find(([id]) => id === c.id)?.[1]}
              selected={categoryFilter === c.id}
            />
          ))}
        </div>
      </div>

      {/* 태그 */}

    </aside>
  );
}
