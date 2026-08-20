/**
 * GridView — the original virtualized multi-column card grid (§7.2). The
 * cell array is now FLAT: folders come first (via FolderTile), then notes
 * (via Card). Both render in the same row slice — no scrollMargin, no
 * separate section, so the virtualizer's `rowCount * ROW_H` height keeps
 * every row anchored in the same coordinate space.
 */
import type { Virtualizer } from "@tanstack/react-virtual";

import { Card } from "../Card";
import { FolderTile } from "../FolderTile";
import type { FolderCard, FolderDef, FolderEntry, MemoSummary } from "../../lib/types";

export type Cell =
  | { kind: "folder"; card: FolderCard }
  | { kind: "note"; note: MemoSummary };

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
  onCopyBody: (id: string) => void;
  onDelete: (id: string) => void;
  onNewNoteIn: (folder: string) => void;
  /** Path of a folder whose name is being edited (inline rename). */
  namingPath: string | null;
  /** null = cancelled (Esc) → caller handles teardown; string = confirm (rename if changed). */
  onNameCommit: (value: string | null) => void;
  /** Delete folder (trash + undo toast); context menu lands in Task 12. */
  onDeleteFolder: (path: string, deep: number, confirmed?: boolean) => void;
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
  onCopyBody,
  onDelete,
  onNewNoteIn,
  namingPath,
  onNameCommit,
}: Props) {
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
                    onOpen={onOpenFolder}
                    onOpenNote={onSelect}
                    onNewNote={onNewNoteIn}
                    namingPath={namingPath}
                    onNameCommit={onNameCommit}
                  />
                ) : (
                  <Card
                    key={cell.note.id}
                    memo={cell.note}
                    folders={folders}
                    folderEntries={folderEntries}
                    onSelect={onSelect}
                    onToggleFavorite={onToggleFavorite}
                    onMoveFolder={onMoveFolder}
                    onCopyBody={onCopyBody}
                    onDelete={onDelete}
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
