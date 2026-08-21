/**
 * BreadcrumbBar — the single source of location (review §4.1).
 *
 * Browse mode renders one segment per path component (root = vault icon);
 * every segment — including the current one — carries a ▾ dropdown:
 *   - non-last: siblings (children of parent) + own children
 *   - last (current): own children only — siblings are reachable via parent
 *   - root: top-level folders only
 * This is the ONLY descent path in Timeline/Graph views and after T9
 * removes the sidebar tree.
 *
 * Query mode renders one inert label with an icon reflecting the active
 * query kind (search, favorites, tag, all notes).
 *
 * Overflow: when the bar exceeds the available width, leading segments are
 * hidden behind a `…` chip that restores them on click. A ResizeObserver
 * re-measures on viewport / sidebar / header changes.
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
import { useFolderDrop } from "../lib/dropTarget";
import type { FolderDef, FolderEntry } from "../lib/types";

export interface BreadcrumbBarProps {
  folders: FolderEntry[];
  /** Folder definitions (for color + naming). */
  folderDefs?: FolderDef[];
  /** Move a dragged note into a segment's folder (T14 drop target). */
  onMoveNote: (id: string, folder: string) => void;
  /** Move a dragged folder subtree into a segment's folder (drop target;
   *  the root segment is how a folder returns to the vault top level). */
  onMoveFolderTree?: (path: string, dest: string) => void;
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
 *  - last (current) non-root: own children only — siblings are reached
 *    through the parent segment's ▾
 *  - any other segment: children of parent (siblings incl. self) + own children
 */
function dropdownFor(
  folders: FolderEntry[],
  path: string,
  isLast: boolean,
): FolderEntry[] {
  if (path === "") return childFolders(folders, "");
  if (isLast) return childFolders(folders, path);
  const parent = parentPath(path);
  const siblings = childFolders(folders, parent);
  const self = folders.find((f) => f.path === path);
  const kids = childFolders(folders, path);
  const seen = new Set<string>();
  const out: FolderEntry[] = [];
  for (const f of [...siblings, ...(self ? [self] : []), ...kids]) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    out.push(f);
  }
  return out;
}

export function BreadcrumbBar({ folders, folderDefs = [], onMoveNote, onMoveFolderTree }: BreadcrumbBarProps) {
  const { t } = useI18n();
  const folderFilter = useUI((s) => s.folderFilter);
  const setFolderFilter = useUI((s) => s.setFolderFilter);
  const search = useUI((s) => s.search);
  const favoritesOnly = useUI((s) => s.favoritesOnly);
  const tagFilter = useUI((s) => s.tagFilter);
  const view = useUI((s) => s.view);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(0);
  // Mirror `collapsed` into a ref so the rAF measure loop sees fresh
  // values without the closure-staleness trap.
  const collapsedRef = useRef(0);
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
  //
  // Termination contract:
  //   1. collapse-only loop: each overflow pass hides +1 segment, paints,
  //      re-measures. Terminates when bar fits OR collapsed === max.
  //   2. After collapse settles, a single restore pass tries to free up
  //      exactly ONE hidden segment if there is meaningful slack — done
  //      once, not in a loop, so a partial restore that re-triggers
  //      overflow will be re-evaluated on the next ResizeObserver tick
  //      (or on the next folderFilter change), not on a self-perpetuating
  //      rAF chain.
  //   3. clientWidth === 0 (header siblings ate the bar) → bail with no
  //      state mutation; ResizeObserver re-runs when layout settles.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    collapsedRef.current = 0;
    setCollapsed(0);
    let raf = 0;
    // Pass 1: collapse-only loop. Hides segments one by one until fits or
    // no more collapsible segments. Cannot oscillate — each iteration
    // hides one MORE segment, never restores.
    const collapse = () => {
      const node = wrapRef.current;
      if (!node) return;
      if (segs.length <= 1) return;
      if (node.clientWidth === 0) return;
      const cur = collapsedRef.current;
      if (cur >= segs.length - 1) return;
      if (node.scrollWidth <= node.clientWidth) return;
      const next = cur + 1;
      collapsedRef.current = next;
      setCollapsed(next);
      raf = requestAnimationFrame(collapse);
    };
    // Pass 2: optional one-shot restore. Only fires AFTER the collapse
    // phase has fully settled and we have measurable slack. Restoring
    // by 1 may re-introduce a small overflow that the next ResizeObserver
    // tick will handle — we deliberately do NOT chain more rAF here.
    const maybeRestore = () => {
      const node = wrapRef.current;
      if (!node) return;
      if (node.clientWidth === 0) return;
      const cur = collapsedRef.current;
      if (cur === 0) return;
      // Slack: enough room that one restore won't overflow even at the
      // segment's worst-case label width (~80px including chevron-right +
      // chevron-down buttons).
      if (node.clientWidth - node.scrollWidth > 80) {
        const next = cur - 1;
        collapsedRef.current = next;
        setCollapsed(next);
      }
    };
    raf = requestAnimationFrame(() => {
      collapse();
      // After collapse settles, schedule the restore check on a separate
      // rAF so the just-painted state is what we measure against.
      raf = requestAnimationFrame(maybeRestore);
    });
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        // Restart the whole flow: reset → collapse → maybeRestore. This
        // intentionally lets the restore pass shrink the collapse count
        // toward zero when the bar widens, with the same single-step
        // guarantee.
        collapsedRef.current = 0;
        setCollapsed(0);
        raf = requestAnimationFrame(() => {
          raf = requestAnimationFrame(collapse);
          raf = requestAnimationFrame(maybeRestore);
        });
      });
      ro.observe(el);
    }
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [folderFilter, segs.length]);

  if (query) {
    return (
      <nav
        ref={wrapRef}
        aria-label={t.breadcrumb_label}
        data-tauri-drag-region="false"
        className="flex min-w-0 flex-1 items-center overflow-hidden text-[13px]"
      >
        <span aria-current="page" className="flex items-center gap-1.5 px-1 font-semibold text-text">
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
      <SegmentButton
        label={t.vault_root}
        path=""
        folders={folders}
        folderDefs={folderDefs}
        isRoot
        last={segs.length === 0}
        onClick={() => setFolderFilter("")}
        onMoveNote={onMoveNote}
        onMoveFolderTree={onMoveFolderTree}
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
            onMoveNote={onMoveNote}
            onMoveFolderTree={onMoveFolderTree}
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
  /** Move a dragged note into this segment's folder (T14 drop target). */
  onMoveNote: (id: string, folder: string) => void;
  /** Move a dragged folder subtree into this segment's folder. */
  onMoveFolderTree?: (path: string, dest: string) => void;
}

function SegmentButton({
  label,
  path,
  folders,
  folderDefs,
  isRoot,
  last,
  onClick,
  onMoveNote,
  onMoveFolderTree,
}: SegmentButtonProps) {
  const { t } = useI18n();
  // Every segment carries a ▾ dropdown. For non-last: siblings + own
  // children. For last (current): own children only — the dropdown is the
  // ONLY way to descend further when Timeline/Graph views hide the
  // sidebar tree (T9).
  const items = dropdownFor(folders, path, !!last);
  const isEmpty = items.length === 0;
  // M16: the segment is inert while the dragged note already lives here.
  // The root segment (path "") is a valid target — dropping on the vault
  // icon moves the note to the vault root. Folder drags too (cycles
  // suppressed in the hook); the root is how a folder goes back to top.
  const { dropCls, ...dropProps } = useFolderDrop(
    path,
    (id) => onMoveNote(id, path),
    onMoveFolderTree ? (p) => onMoveFolderTree(p, path) : undefined,
  );

  return (
    <span className="flex min-w-0 items-center gap-0.5">
      {isRoot ? null : (
        <ChevronRight size={11} aria-hidden="true" className="shrink-0 text-text-subtle" />
      )}
      {last ? (
        <span
          data-breadcrumb-path={path}
          aria-current="page"
          {...dropProps}
          className={`inline-flex min-w-0 items-center gap-1 truncate px-1 font-semibold text-text ${dropCls ?? ""}`}
        >
          {isRoot ? <Folder size={13} aria-hidden="true" className="shrink-0 text-text-subtle" /> : null}
          <span className="truncate">{label}</span>
        </span>
      ) : (
        <button
          type="button"
          data-breadcrumb-path={path}
          {...dropProps}
          onClick={onClick}
          aria-label={isRoot ? t.vault_root : label}
          className={`inline-flex min-w-0 items-center gap-1 truncate rounded-[var(--tag-radius)] px-1 py-0.5 text-text-muted transition-colors duration-150 hover:bg-surface-muted hover:text-text ${dropCls ?? ""}`}
        >
          {isRoot ? <Folder size={13} aria-hidden="true" className="shrink-0 text-text-subtle" /> : null}
          <span className="truncate">{label}</span>
        </button>
      )}
      <SegmentPopover
        items={items}
        folderDefs={folderDefs}
        currentPath={path}
        rootLabel={t.vault_root}
        triggerLabel={`${label} ${t.folder_open}`}
        emptyLabel={t.folder_empty}
        disabled={isEmpty}
      />
    </span>
  );
}

function SegmentPopover({
  items,
  folderDefs,
  currentPath,
  rootLabel,
  triggerLabel,
  emptyLabel,
  disabled,
}: {
  items: FolderEntry[];
  folderDefs: FolderDef[];
  currentPath: string;
  rootLabel: string;
  /** Display label for non-root triggers (e.g. "<segment> Open" — kept
   * distinct from rootLabel so screen readers can tell siblings apart).
   * Root segments ignore this and use rootLabel. */
  triggerLabel: string;
  emptyLabel: string;
  disabled: boolean;
}) {
  const setFolderFilter = useUI((s) => s.setFolderFilter);
  const [open, setOpen] = useState(false);
  if (disabled) {
    return (
      <span
        aria-disabled="true"
        title={emptyLabel}
        className="inline-flex h-5 w-5 items-center justify-center rounded text-text-subtle/40"
      >
        <ChevronDown size={10} aria-hidden="true" />
      </span>
    );
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label={currentPath === "" ? rootLabel : triggerLabel}
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