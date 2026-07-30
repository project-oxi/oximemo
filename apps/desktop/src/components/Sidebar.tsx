/**
 * Collapsible left sidebar (§7): All notes / Pinned navigation, the tag list
 * with 3-state filter chips + AND/OR toggle, and the color filter swatches.
 * Counts come from `list_facets` (page-independent). Rendered only when the
 * sidebar is open; the collapse toggle lives here, the expand toggle in the
 * main header.
 */
import { useQuery } from "@tanstack/react-query";
import { Layers, PanelLeftClose, Pin } from "lucide-react";

import { listFacets, noteStats, listCategories } from "../lib/api";
import { colorForCategory } from "../lib/color";
import { useI18n } from "../lib/i18n";
import { useUI, type TagState } from "../stores/ui";

const STATE_CLASS: Record<TagState, string> = {
  off: "bg-zinc-200/70 text-zinc-600 hover:bg-zinc-300/70 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700/70",
  in: "bg-[var(--tag)] font-semibold text-white",
  out: "border border-[var(--tag)] text-[var(--tag)] line-through",
};

export function Sidebar() {
  const { t } = useI18n();
  const facets = useQuery({ queryKey: ["facets"], queryFn: listFacets });
  const stats = useQuery({ queryKey: ["stats"], queryFn: noteStats });
  const tagFilter = useUI((s) => s.tagFilter);
  const cycleTag = useUI((s) => s.cycleTag);
  const clearTagFilter = useUI((s) => s.clearTagFilter);
  const matchAll = useUI((s) => s.matchAll);
  const toggleMatchAll = useUI((s) => s.toggleMatchAll);
  const categoryFilter = useUI((s) => s.categoryFilter);
  const setCategory = useUI((s) => s.setCategory);
  const pinnedOnly = useUI((s) => s.pinnedOnly);
  const setPinnedOnly = useUI((s) => s.setPinnedOnly);
  const toggleSidebar = useUI((s) => s.toggleSidebar);

  const tags = facets.data?.tags ?? [];
  const categories = facets.data?.categories ?? [];
  const catQuery = useQuery({ queryKey: ["categories"], queryFn: listCategories });
  const catDefs = catQuery.data ?? [];
  const total = stats.data?.notes ?? 0;
  const pinnedCount = stats.data?.pinned ?? 0;

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-950/40">
      {/* Traffic-light drag region: the macOS lights live in the top-left of
          this column, so reserve h-12 + the standard 76px clearance here. */}
      <div data-tauri-drag-region className="flex h-12 items-center pl-[76px] pr-3">
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={t.hide_sidebar}
          className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-200/60 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <PanelLeftClose size={15} />
        </button>
      </div>

      <button
        type="button"
        onClick={() => setPinnedOnly(false)}
        className={`mx-2 flex items-center justify-between rounded-md px-2 py-1.5 text-[13px] ${
          !pinnedOnly
            ? "bg-zinc-200/70 font-semibold dark:bg-zinc-800"
            : "text-zinc-600 hover:bg-zinc-200/50 dark:text-zinc-300"
        }`}
      >
        <span className="flex items-center gap-2"><Layers size={14} /> {t.all_notes}</span>
        <span className="text-[11px] text-zinc-400">{total}</span>
      </button>
      <button
        type="button"
        onClick={() => setPinnedOnly(true)}
        className={`mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${
          pinnedOnly
            ? "bg-amber-100 font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
            : "text-zinc-600 hover:bg-zinc-200/50 dark:text-zinc-300"
        }`}
      >
        <Pin size={14} /> {t.pinned}
        {pinnedCount > 0 && <span className="ml-auto text-[11px] text-zinc-400">{pinnedCount}</span>}
      </button>

      <div className="mt-3 flex items-center justify-between px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t.tags_section}</span>
        <button
          type="button"
          onClick={toggleMatchAll}
          className="text-[10px] font-semibold text-[var(--tag)]"
        >
          {matchAll ? t.match_all : t.match_any} ⇅
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5 px-3 pt-1">
        <button
          type="button"
          onClick={clearTagFilter}
          className="rounded-md bg-zinc-200/70 px-2 py-0.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
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
        <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
          Category
        </label>
        <div className="mt-1 flex flex-col gap-0.5">
          <button
            className={`flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm ${
              categoryFilter === null
                ? "bg-zinc-200/70 font-semibold dark:bg-zinc-700"
                : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
            }`}
            onClick={() => setCategory(null)}
          >
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-zinc-400" />
            <span>All</span>
          </button>
          {catDefs.map((c) => {
            const count = categories.find(([id]) => id === c.id)?.[1];
            return (
              <button
                key={c.id}
                className={`flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm ${
                  categoryFilter === c.id
                    ? "bg-zinc-200/70 font-semibold dark:bg-zinc-700"
                    : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
                }`}
                onClick={() => setCategory(categoryFilter === c.id ? null : c.id)}
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: colorForCategory(c.id, catDefs) }}
                />
                <span>{c.id}</span>
                {count !== undefined && (
                  <span className="ml-auto text-[11px] text-zinc-400">{count}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* 태그 */}

    </aside>
  );
}
