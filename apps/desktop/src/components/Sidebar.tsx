/**
 * Collapsible left sidebar (§7): All memos / Favorites navigation, the tag list
 * with 3-state filter chips + AND/OR toggle, and the folder tree. Counts come
 * from `list_facets` (page-independent). Rendered only when the sidebar is
 * open; the collapse/expand toggle is a single fixed button rendered by
 * CardGrid so it never moves between states.
 */
import { useQuery } from "@tanstack/react-query";
import { ArrowUpDown, ChevronRight, Folder, Images, Layers, Star } from "lucide-react";
import { useMemo, useState } from "react";

import { listFacets, memoStats, listFolders, getConfig } from "../lib/api";
import { colorForFolder } from "../lib/color";
import { useI18n } from "../lib/i18n";
import { useUI, type TagState } from "../stores/ui";
import type { FolderEntry, FolderDef } from "../lib/types";

const STATE_CLASS: Record<TagState, string> = {
  off: "bg-surface-muted text-text-muted hover:bg-surface-muted/80",
  in: "bg-hue-amber font-semibold text-text-inverse",
  out: "border border-hue-amber text-hue-amber line-through",
};

interface FolderNode {
  name: string;
  fullPath: string;
  note_count: number;
  children: FolderNode[];
}

function buildTree(entries: FolderEntry[]): FolderNode[] {
  const root: FolderNode = {
    name: "(root)",
    fullPath: "",
    note_count: 0,
    children: [],
  };
  const byPath = new Map<string, FolderNode>();
  byPath.set("", root);
  // Normalize once: Rust's `list_folders` already returns `{ path, note_count }`,
  // but any future IPC shape change (or a stale mock) must not crash the tree.
  const rows = entries
    .map((e) => ({ path: e.path ?? "", note_count: e.note_count ?? 0 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const e of rows) {
    if (e.path === "") {
      root.note_count = e.note_count;
      continue;
    }
    const segs = e.path.split("/");
    const parentPath = segs.slice(0, -1).join("/");
    const parent = byPath.get(parentPath);
    if (!parent) continue;
    const node: FolderNode = {
      name: segs.at(-1) ?? e.path,
      fullPath: e.path,
      note_count: e.note_count,
      children: [],
    };
    parent.children.push(node);
    byPath.set(e.path, node);
  }
  return [root];
}

function FolderTreeNode({
  node,
  depth,
  selectedPath,
  onSelect,
  folders,
}: {
  node: FolderNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
  folders: FolderDef[];
}) {
  const [open, setOpen] = useState(depth < 1);
  const isSelected = (selectedPath ?? "") === node.fullPath;
  const indent = { paddingLeft: `${depth * 12 + 8}px` };
  return (
    <div>
      <div
        className={`flex items-center gap-1 rounded-md py-0.5 pr-2 text-[13px] ${
          isSelected ? "bg-surface-muted font-semibold text-text" : "hover:bg-surface-muted text-text-muted"
        }`}
        style={indent}
      >
        {node.children.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Collapse" : "Expand"}
            className="grid h-4 w-4 place-items-center rounded-sm text-text-subtle hover:bg-surface-muted"
          >
            <ChevronRight
              size={11}
              className={`transition-transform ${open ? "rotate-90" : ""}`}
            />
          </button>
        ) : (
          <span className="inline-block h-4 w-4" />
        )}
        <button
          type="button"
          onClick={() => onSelect(node.fullPath || null)}
          className="flex flex-1 items-center gap-2 truncate text-left"
        >
          <Folder
            size={12}
            style={node.fullPath ? { color: colorForFolder(node.fullPath, folders) } : undefined}
          />
          <span className="truncate">{node.fullPath || "(root)"}</span>
          <span className="ml-auto text-[10px] text-text-subtle">{node.note_count}</span>
        </button>
      </div>
      {open && node.children.length > 0 && (
        <div>
          {node.children.map((c) => (
            <FolderTreeNode
              key={c.fullPath}
              node={c}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              folders={folders}
            />
          ))}
        </div>
      )}
    </div>
  );
}

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

  const tags = facets.data?.tags ?? [];
  const tree = useMemo(() => buildTree(foldersQ.data ?? []), [foldersQ.data]);
  const folders = configQ.data?.folders ?? [];
  const total = stats.data?.memos ?? 0;
  const favoritesCount = stats.data?.favorites ?? 0;

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
              onClick={() => cycleTag(tag)}
              className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${STATE_CLASS[st]}`}
            >
              #{tag} <span className="opacity-60">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">Folders</span>
      </div>
      <div className="flex flex-col px-2 pt-1">
        {tree.map((n) => (
          <FolderTreeNode
            key={n.fullPath || "(root)"}
            node={n}
            depth={0}
            selectedPath={folderFilter}
            onSelect={setFolderFilter}
            folders={folders}
          />
        ))}
      </div>
    </aside>
  );
}