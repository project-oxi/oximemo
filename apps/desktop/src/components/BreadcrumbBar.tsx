/**
 * BreadcrumbBar — the single source of location (review §4.1).
 *
 * Browse mode renders one clickable segment per path component (root = vault
 * icon); each non-last segment exposes a ▾ dropdown listing its siblings
 * (children of the parent path) plus its own children. Query mode renders
 * one inert label with an icon reflecting the active query kind (search,
 * favorites, tag, all notes).
 *
 * Overflow: when the bar exceeds the available width, leading segments are
 * hidden behind a `…` chip that restores them on click.
 */
import { Popover } from "@base-ui-components/react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  Hash,
  Layers,
  MoreHorizontal,
  Search,
  Star,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { colorForFolder } from "../lib/color";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";
import type { FolderDef, FolderEntry } from "../lib/types";

export interface BreadcrumbBarProps {
  folders: FolderEntry[];
  /** Folder definitions (for color + naming). */
  folderDefs?: FolderDef[];
}

/** Direct children of `path` ("" = root level). */
function childFolders(folders: FolderEntry[], path: string): FolderEntry[] {
  const prefix = path === "" ? "" : `${path}/`;
  return folders.filter((f) => {
    if (f.path === "" || f.path === path) return false;
    if (prefix === "") return !f.path.includes("/");
    return f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes("/");
  });
}

/** Parent path: "" → "", "a" → "", "a/b" → "a". */
function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Build the dropdown list for a segment at `path`:
 *  - root (path === ""): children of root only
 *  - any other segment: children of parent (siblings incl. self) + own children
 */
function dropdownFor(folders: FolderEntry[], path: string): FolderEntry[] {
  if (path === "") return childFolders(folders, "");
  const parent = parentPath(path);
  const siblings = childFolders(folders, parent);
  // Sibling list does not include the current segment (we skip the exact
  // path in childFolders). Add it so "this folder" is selectable.
  const self = folders.find((f) => f.path === path);
  const kids = childFolders(folders, path);
  // Dedupe.
  const seen = new Set<string>();
  const out: FolderEntry[] = [];
  for (const f of [...siblings, ...(self ? [self] : []), ...kids]) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    out.push(f);
  }
  return out;
}

export function BreadcrumbBar({ folders, folderDefs = [] }: BreadcrumbBarProps) {
  const { t } = useI18n();
  const folderFilter = useUI((s) => s.folderFilter);
  const setFolderFilter = useUI((s) => s.setFolderFilter);
  const search = useUI((s) => s.search);
  const favoritesOnly = useUI((s) => s.favoritesOnly);
  const tagFilter = useUI((s) => s.tagFilter);
  const view = useUI((s) => s.view);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(0);
  // Hide in gallery mode — it has its own header.
  if (view === "gallery") return null;

  // Query-mode label
  const query = folderFilter === null;
  const queryLabel = search
    ? t.query_search.replace("{q}", search)
    : favoritesOnly
      ? t.query_favorites
      : Object.keys(tagFilter).some((k) => tagFilter[k] !== "off")
        ? t.query_tags
        : t.query_all_notes;

  const segs = query || folderFilter === "" ? [] : folderFilter.split("/");
  const paths: string[] = [];
  for (let i = 0; i < segs.length; i++) paths.push(segs.slice(0, i + 1).join("/"));

  // Overflow: collapse leading segments while the bar exceeds its box.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setCollapsed(0);
    let h = 0;
    let raf = 0;
    const check = () => {
      if (!el) return;
      if (el.scrollWidth > el.clientWidth && h < segs.length - 1) {
        h += 1;
        setCollapsed(h);
        raf = requestAnimationFrame(check);
      }
    };
    raf = requestAnimationFrame(check);
    return () => cancelAnimationFrame(raf);
  }, [folderFilter, segs.length]);

  if (query) {
    return (
      <nav
        ref={wrapRef}
        aria-label={t.breadcrumb_label}
        data-tauri-drag-region="false"
        className="flex min-w-0 flex-1 items-center overflow-hidden text-[13px]"
      >
        <span className="flex items-center gap-1.5 px-1 font-semibold text-text">
          {search ? (
            <Search size={13} aria-hidden="true" />
          ) : favoritesOnly ? (
            <Star size={13} aria-hidden="true" />
          ) : Object.keys(tagFilter).some((k) => tagFilter[k] !== "off") ? (
            <Hash size={13} aria-hidden="true" />
          ) : (
            <Layers size={13} aria-hidden="true" />
          )}
          {queryLabel}
        </span>
      </nav>
    );
  }

  return (
    <nav
      ref={wrapRef}
      aria-label={t.breadcrumb_label}
      data-tauri-drag-region="false"
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-[13px]"
    >
      {/* Root segment — always present, has its own dropdown for top-level folders. */}
      <SegmentButton
        label={t.vault_root}
        path=""
        folders={folders}
        folderDefs={folderDefs}
        isRoot
        onClick={() => setFolderFilter("")}
      />
      {collapsed > 0 && (
        <button
          type="button"
          onClick={() => setCollapsed(0)}
          aria-label={t.vault_root}
          title={paths[collapsed - 1] ?? t.vault_root}
          className="inline-flex items-center gap-0.5 rounded-[var(--tag-radius)] px-1.5 py-0.5 text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text"
        >
          <MoreHorizontal size={12} aria-hidden="true" />
        </button>
      )}
      {segs.slice(collapsed).map((name, i) => {
        const idx = collapsed + i;
        const path = paths[idx];
        const last = idx === segs.length - 1;
        return (
          <SegmentButton
            key={path}
            label={name}
            path={path}
            folders={folders}
            folderDefs={folderDefs}
            last={last}
            onClick={() => setFolderFilter(path)}
          />
        );
      })}
    </nav>
  );
}

interface SegmentButtonProps {
  label: string;
  path: string;
  folders: FolderEntry[];
  folderDefs: FolderDef[];
  isRoot?: boolean;
  last?: boolean;
  onClick: () => void;
}

function SegmentButton({
  label,
  path,
  folders,
  folderDefs,
  isRoot,
  last,
  onClick,
}: SegmentButtonProps) {
  const { t } = useI18n();
  // Each non-last segment gets a ▾ dropdown (root is always non-last). The
  // last segment is the "you are here" indicator and has no popover.
  const items = last ? [] : dropdownFor(folders, path);

  return (
    <span className="flex min-w-0 items-center gap-0.5">
      {isRoot ? null : (
        <ChevronRight size={11} aria-hidden="true" className="shrink-0 text-text-subtle" />
      )}
      {last ? (
        <span
          data-breadcrumb-path={path}
          className="inline-flex min-w-0 items-center gap-1 truncate px-1 font-semibold text-text"
        >
          <span className="truncate">{label}</span>
        </span>
      ) : (
        <button
          type="button"
          data-breadcrumb-path={path}
          onClick={onClick}
          aria-label={isRoot ? t.vault_root : label}
          className="inline-flex min-w-0 items-center gap-1 truncate rounded-[var(--tag-radius)] px-1 py-0.5 text-text-muted transition-colors duration-150 hover:bg-surface-muted hover:text-text"
        >
          {isRoot ? <Folder size={13} aria-hidden="true" className="shrink-0 text-text-subtle" /> : null}
          <span className="truncate">{label}</span>
        </button>
      )}
      {last ? null : (
        <SegmentPopover
          items={items}
          folderDefs={folderDefs}
          currentPath={path}
          rootLabel={t.vault_root}
          emptyLabel={t.folder_empty}
        />
      )}
    </span>
  );
}

function SegmentPopover({
  items,
  folderDefs,
  currentPath,
  rootLabel,
  emptyLabel,
}: {
  items: FolderEntry[];
  folderDefs: FolderDef[];
  currentPath: string;
  rootLabel: string;
  emptyLabel: string;
}) {
  const setFolderFilter = useUI((s) => s.setFolderFilter);
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label={rootLabel}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text"
          >
            <ChevronDown size={10} aria-hidden="true" />
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={2}>
          <Popover.Popup className="z-50 min-w-48 max-h-72 overflow-y-auto rounded-[var(--popover-radius)] border border-line bg-surface-raised p-1 shadow-lg animate-popover-in">
            {items.length === 0 ? (
              <div className="px-2 py-1.5 text-[12px] text-text-subtle">{emptyLabel}</div>
            ) : (
              <ul className="flex flex-col" role="listbox">
                {items.map((f) => {
                  const color = colorForFolder(f.path, folderDefs);
                  return (
                    <li key={f.path}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={f.path === currentPath}
                        onClick={() => {
                          setFolderFilter(f.path);
                          setOpen(false);
                        }}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] transition-colors duration-150 ${
                          f.path === currentPath
                            ? "bg-surface-muted font-semibold text-text"
                            : "text-text hover:bg-surface-muted"
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className="inline-block h-2 w-2 shrink-0 rounded-full"
                          style={{ background: color || "var(--color-text-subtle)" }}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {f.path === "" ? rootLabel : f.path.split("/").pop()}
                        </span>
                        {f.note_count > 0 && (
                          <span className="ml-auto text-[11px] text-text-subtle">{f.note_count}</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
