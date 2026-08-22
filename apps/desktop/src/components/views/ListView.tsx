/**
 * ListView — a flat two-column list (title + preview). Rendered for users
 * who want denser scan over many notes at once (§7.2).
 *
 * When browsing a folder (not in query mode) the current folder's direct
 * subfolders appear as rows above the notes, mirroring the FolderTile layer
 * in the grid view. Each row carries `data-folder-row` for the eventual
 * drag-target hook (Task 14).
 *
 * M20: every row is a context-menu trigger — note rows share NoteCtxMenu
 * with the grid Card, folder rows share FolderCtxMenu with the FolderTile
 * (open / rename / pin / armed delete + inline rename input).
 */
import { Folder, Star } from "lucide-react";

import { colorForFolder } from "../../lib/color";
import { useI18n } from "../../lib/i18n";
import { useFolderDrop } from "../../lib/dropTarget";
import { relativeTime } from "../../lib/time";
import { useUI } from "../../stores/ui";
import { previewText } from "../../lib/markdownPreview";
import type { FolderCard, FolderDef, FolderEntry, MemoSummary } from "../../lib/types";

import { CtxRoot, CtxTrigger } from "../ContextMenu";
import { FolderMenu, type NamingSession } from "../FolderTile";
import { NoteCtxMenu } from "../NoteCtxMenu";
import { TextCtxMenu } from "../TextCtxMenu";

interface Props {
  items: MemoSummary[];
  folders: FolderDef[];
  folderEntries: FolderEntry[];
  folderCards: FolderCard[];
  onOpenFolder: (path: string) => void;
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string, favorite: boolean) => void;
  onMoveFolder: (id: string, folder: string) => void;
  onMoveFolderTree?: (path: string, dest: string) => void;
  onCopyBody: (id: string) => void;
  onDelete: (id: string) => void;
  onNewNote?: () => void;
  onRenameFolder: (path: string) => void;
  onToggleFolderPin: (path: string, pinned: boolean) => void;
  onDeleteFolder: (path: string, deep: number, confirmed?: boolean) => void;
  namingPath: NamingSession | null;
  onNameCommit: (value: string | null) => void;
}

export function ListView({
  items,
  folders,
  folderEntries,
  folderCards,
  onOpenFolder,
  onSelect,
  onToggleFavorite,
  onMoveFolder,
  onMoveFolderTree,
  onCopyBody,
  onDelete,
  onRenameFolder,
  onToggleFolderPin,
  onDeleteFolder,
  namingPath,
  onNameCommit,
}: Props) {
  const { t, locale } = useI18n();
  const setDraggingNote = useUI((s) => s.setDraggingNote);
  return (
    <ul className="divide-y divide-line">
      {folderCards.map((f) => (
        <FolderRow
          key={f.path}
          f={f}
          folders={folders}
          naming={namingPath?.path === f.path}
          onOpenFolder={onOpenFolder}
          onRenameFolder={onRenameFolder}
          onToggleFolderPin={onToggleFolderPin}
          onDeleteFolder={onDeleteFolder}
          onMoveFolder={onMoveFolder}
          onMoveFolderTree={onMoveFolderTree}
          onNameCommit={onNameCommit}
        />
      ))}
      {items.map((n) => (
        <li key={n.id}>
          <CtxRoot>
            <CtxTrigger
              render={
                <div
                  draggable
                  onDragStart={(e) => {
                    setDraggingNote(n);
                    e.dataTransfer.setData(
                      "application/x-oximemo-notes",
                      JSON.stringify([n.id]),
                    );
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => setDraggingNote(null)}
                  className="group flex cursor-pointer items-baseline gap-3 px-3 py-2.5 transition-colors hover:bg-surface-muted"
                  onClick={() => onSelect(n.id)}
                />
              }
            >
              <button
                type="button"
                aria-label={n.favorite ? t.action_unfavorite : t.action_favorite}
                className={`shrink-0 self-center rounded-md p-1 transition-colors duration-150 ${
                  n.favorite
                    ? "text-hue-amber"
                    : "text-text-subtle hover:bg-surface-muted hover:text-hue-amber"
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFavorite(n.id, n.favorite);
                }}
              >
                <Star size={13} className={n.favorite ? "fill-hue-amber" : undefined} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  {n.title ? (
                    <span className="truncate text-sm font-semibold text-text">{n.title}</span>
                  ) : (
                    <span className="truncate text-sm text-text-subtle">{t.empty_memo}</span>
                  )}
                  {n.folder && (
                    <span className="shrink-0 font-mono text-[10px] text-text-subtle">
                      {n.folder}/
                    </span>
                  )}
                </div>
                <div className="mt-0.5 line-clamp-2 whitespace-pre-line text-xs text-text-subtle">
                  {previewText(n.preview) || ""}
                </div>
              </div>
              <div className="flex shrink-0 items-baseline gap-2 text-[11px] text-text-subtle">
                {n.tags.slice(0, 3).map((tag) => (
                  <span
                    key={tag}
                    className="rounded-[var(--tag-radius)] bg-surface-muted px-1.5 py-0.5 text-text-muted"
                  >
                    #{tag}
                  </span>
                ))}
                <span className="w-16 text-right tabular-nums">{relativeTime(n.updated_at, locale)}</span>
              </div>
              <NoteCtxMenu
                memo={n}
                folderEntries={folderEntries}
                onToggleFavorite={onToggleFavorite}
                onMoveFolder={onMoveFolder}
                onCopyBody={onCopyBody}
                onDelete={onDelete}
              />
            </CtxTrigger>
          </CtxRoot>
        </li>
      ))}
    </ul>
  );
}

/** One folder row: a drop target (T14) wrapping the shared FolderMenu.
 *  Extracted from the map so useFolderDrop runs at a stable hook index. */
function FolderRow({
  f,
  folders,
  naming,
  onOpenFolder,
  onRenameFolder,
  onToggleFolderPin,
  onDeleteFolder,
  onMoveFolder,
  onMoveFolderTree,
  onNameCommit,
}: {
  f: FolderCard;
  folders: FolderDef[];
  naming: boolean;
  onOpenFolder: (path: string) => void;
  onRenameFolder: (path: string) => void;
  onToggleFolderPin: (path: string, pinned: boolean) => void;
  onDeleteFolder: (path: string, deep: number, confirmed?: boolean) => void;
  onMoveFolder: (id: string, folder: string) => void;
  onMoveFolderTree?: (path: string, dest: string) => void;
  onNameCommit: (value: string | null) => void;
}) {
  const { t } = useI18n();
  const setDraggingFolder = useUI((s) => s.setDraggingFolder);
  // M16: the row is inert while the dragged note already lives here.
  // Folder drags land here too (cycles/parent no-ops suppressed in the hook).
  const { dropCls, ...dropProps } = useFolderDrop(
    f.path,
    (id) => onMoveFolder(id, f.path),
    onMoveFolderTree ? (p) => onMoveFolderTree(p, f.path) : undefined,
  );
  return (
    <li data-folder-row={f.path} {...dropProps} className={dropCls}>
      <FolderMenu
        path={f.path}
        deep={f.note_count_deep}
        pinned={folders.find((d) => d.path === f.path)?.pinned ?? false}
        onOpen={onOpenFolder}
        onRename={onRenameFolder}
        onTogglePin={onToggleFolderPin}
        onDelete={onDeleteFolder}
        render={
          <div
            draggable={!naming}
            onDragStart={(e) => {
              setDraggingFolder(f.path);
              e.dataTransfer.setData("application/x-oximemo-folder", f.path);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => setDraggingFolder(null)}
            onClick={() => {
              if (!naming) onOpenFolder(f.path);
            }}
            className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-surface-muted"
          />
        }
      >
        <Folder size={13} style={{ color: colorForFolder(f.path, folders) }} />
        {naming ? (
          <TextCtxMenu
            render={
              <input
                autoFocus
                defaultValue={f.path.split("/").at(-1) ?? ""}
                onFocus={(e) => e.currentTarget.select()}
                ref={(el) => el?.select()}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => onNameCommit(e.currentTarget.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") onNameCommit(e.currentTarget.value);
                  else if (e.key === "Escape") onNameCommit(null);
                }}
                style={{ boxShadow: "none" }}
                className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-0 text-sm font-semibold text-text outline-none"
              />
            }
          />
        ) : (
          <span className="text-sm font-semibold text-text">
            {f.path.split("/").at(-1)}
          </span>
        )}
        <span className="text-xs text-text-subtle">
          {t.folder_notes.replace("{n}", String(f.note_count_deep))}
          {f.subfolder_count > 0
            ? ` · ${t.folder_subfolders.replace("{n}", String(f.subfolder_count))}`
            : ""}
        </span>
        <span className="ml-auto text-text-subtle">›</span>
      </FolderMenu>
    </li>
  );
}
