/**
 * ListView — a flat two-column list (title + preview). Rendered for users
 * who want denser scan over many notes at once (§7.2).
 *
 * When browsing a folder (not in query mode) the current folder's direct
 * subfolders appear as rows above the notes, mirroring the FolderTile layer
 * in the grid view. Each row carries `data-folder-row` for the eventual
 * drag-target hook (Task 14).
 */
import { Folder, Star } from "lucide-react";

import { colorForFolder } from "../../lib/color";
import { useI18n } from "../../lib/i18n";
import { relativeTime } from "../../lib/time";
import type { FolderCard, FolderDef, FolderEntry, MemoSummary } from "../../lib/types";

interface Props {
  items: MemoSummary[];
  folders: FolderDef[];
  folderEntries: FolderEntry[];
  folderCards: FolderCard[];
  onOpenFolder: (path: string) => void;
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string, favorite: boolean) => void;
  onMoveFolder: (id: string, folder: string) => void;
  onCopyBody: (id: string) => void;
  onDelete: (id: string) => void;
  onNewNote?: () => void;
}

export function ListView({
  items,
  folders,
  folderCards,
  onOpenFolder,
  onSelect,
  onToggleFavorite,
}: Props) {
  const { t, locale } = useI18n();
  return (
    <ul className="divide-y divide-line">
      {folderCards.map((f) => (
        <li
          key={f.path}
          data-folder-row={f.path}
          onClick={() => onOpenFolder(f.path)}
          className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-surface-muted"
        >
          <Folder size={13} style={{ color: colorForFolder(f.path, folders) }} />
          <span className="text-sm font-semibold text-text">{f.path.split("/").at(-1)}</span>
          <span className="text-xs text-text-subtle">
            {t.folder_notes.replace("{n}", String(f.note_count_deep))}
            {f.subfolder_count > 0
              ? ` · ${t.folder_subfolders.replace("{n}", String(f.subfolder_count))}`
              : ""}
          </span>
          <span className="ml-auto text-text-subtle">›</span>
        </li>
      ))}
      {items.map((n) => (
        <li
          key={n.id}
          className="group flex cursor-pointer items-baseline gap-3 px-3 py-2.5 transition-colors hover:bg-surface-muted"
          onClick={() => onSelect(n.id)}
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
            <div className="mt-0.5 line-clamp-1 text-xs text-text-subtle">{n.preview || ""}</div>
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
        </li>
      ))}
    </ul>
  );
}
