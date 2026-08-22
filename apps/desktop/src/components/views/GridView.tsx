/**
 * GridView — the original virtualized multi-column card grid (§7.2). The
 * cell array is now FLAT: folders come first (via FolderTile), then notes
 * (via Card). Both render in the same row slice — no scrollMargin, no
 * separate section, so the virtualizer's `rowCount * ROW_H` height keeps
 * every row anchored in the same coordinate space. A `folderOverflow`
 * cell (T15) renders the tile-sized "show all N folders" toggle that
 * CardGrid appends when the folder layer is collapsed.
 */
import type { Virtualizer } from "@tanstack/react-virtual";
import { MoreHorizontal } from "lucide-react";

import { Card } from "../Card";
import { FolderTile, type NamingSession } from "../FolderTile";
import { useI18n } from "../../lib/i18n";
import type { FolderCard, FolderDef, FolderEntry, MemoSummary } from "../../lib/types";

export type Cell =
  | { kind: "folder"; card: FolderCard }
  | { kind: "note"; note: MemoSummary }
  | { kind: "folderOverflow"; total: number };

interface Props {
  cells: Cell[];
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  cols: number;
  folders: FolderDef[];
  folderEntries: FolderEntry[];
  onOpenFolder: (path: string) => void;
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string, favorite: boolean) => void;
  onMoveFolder: (id: string, folder: string) => void;
  onMoveFolderTree?: (path: string, dest: string) => void;
  onCopyBody: (id: string) => void;
  onDelete: (id: string) => void;
  onNewNoteIn: (folder: string) => void;
  onRenameFolder: (path: string) => void;
  onToggleFolderPin: (path: string, pinned: boolean) => void;
  /** Naming session of the folder being edited (inline rename/create). */
  namingPath: NamingSession | null;
  /** null = cancelled (Esc) → caller handles teardown; string = confirm (rename if changed). */
  onNameCommit: (value: string | null) => void;
  /** Delete folder (trash + undo toast); armed confirm lives in FolderCtxMenu. */
  onDeleteFolder: (path: string, deep: number, confirmed?: boolean) => void;
  /** Query-mode folder chip on note cards (T13): true when browsing is off. */
  showFolderChip?: boolean;
  /** Schema badge declarations passed through to note cards (§7.2). */
  badges?: { key: string; colors: Record<string, string> }[];
  /** T15: expand the collapsed folder layer for this browse location. */
  onExpandFolders: () => void;
}

const CARD_H = 176;
const ROW_GAP = 12;

export function GridView({
  cells,
  virtualizer,
  cols,
  folders,
  folderEntries,
  onOpenFolder,
  onSelect,
  onToggleFavorite,
  onMoveFolder,
  onMoveFolderTree,
  onCopyBody,
  onDelete,
  onNewNoteIn,
  onRenameFolder,
  onToggleFolderPin,
  namingPath,
  onNameCommit,
  onDeleteFolder,
  showFolderChip,
  badges,
  onExpandFolders,
}: Props) {
  const { t } = useI18n();
  const rowCount = Math.ceil(cells.length / cols);
  return (
    <div style={{ height: virtualizer.getTotalSize() }} className="relative w-full">
      {virtualizer.getVirtualItems().map((v) => {
        const start = v.index * cols;
        const row = cells.slice(start, start + cols);
        return (
          <div
            key={v.key}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              transform: `translateY(${v.start}px)`,
              width: "100%",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gridAutoRows: `${CARD_H}px`,
                gap: `${ROW_GAP}px`,
              }}
            >
              {row.map((cell) =>
                cell.kind === "folder" ? (
                  <FolderTile
                    key={`f:${cell.card.path}`}
                    card={cell.card}
                    folders={folders}
                    pinned={folders.find((f) => f.path === cell.card.path)?.pinned ?? false}
                    onOpen={onOpenFolder}
                    onOpenNote={onSelect}
                    onNewNote={onNewNoteIn}
                    onRename={onRenameFolder}
                    onTogglePin={onToggleFolderPin}
                    onMoveFolder={onMoveFolder}
                    onMoveFolderTree={onMoveFolderTree}
                    onDelete={onDeleteFolder}
                    namingPath={namingPath}
                    onNameCommit={onNameCommit}
                  />
                ) : cell.kind === "folderOverflow" ? (
                  <button
                    key="folder-overflow"
                    type="button"
                    onClick={onExpandFolders}
                    className="flex h-44 cursor-default flex-col items-center justify-center gap-2 rounded-[var(--card-radius)] border border-dashed border-line p-4 text-text-subtle transition-colors duration-150 hover:border-line-strong hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    <MoreHorizontal size={16} aria-hidden />
                    <span className="text-center text-xs font-medium">
                      {t.show_all_folders.replace("{n}", String(cell.total))}
                    </span>
                  </button>
                ) : (
                  <Card
                    key={cell.note.id}
                    memo={cell.note}
                    folders={folders}
                    folderEntries={folderEntries}
                    onOpenFolder={onOpenFolder}
                    onSelect={onSelect}
                    onToggleFavorite={onToggleFavorite}
                    onMoveFolder={onMoveFolder}
                    onCopyBody={onCopyBody}
                    onDelete={onDelete}
                    showFolderChip={showFolderChip}
                    badges={badges}
                  />
                ),
              )}
            </div>
          </div>
        );
      })}
      {rowCount === 0 && null}
    </div>
  );
}
