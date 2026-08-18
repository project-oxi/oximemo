/**
 * GridView — the original virtualized multi-column card grid (§7.2).
 * Same responsive auto-fill layout as the original CardGrid body, just
 * extracted so CardGrid can switch between views.
 */
import type { Virtualizer } from "@tanstack/react-virtual";

import { Card } from "../Card";
import type { FolderDef, FolderEntry, MemoSummary } from "../../lib/types";

interface Props {
  items: MemoSummary[];
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  cols: number;
  folders: FolderDef[];
  folderEntries: FolderEntry[];
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string, favorite: boolean) => void;
  onMoveFolder: (id: string, folder: string) => void;
  onCopyBody: (id: string) => void;
  onDelete: (id: string) => void;
}

const CARD_H = 176;
const ROW_GAP = 12;

export function GridView({
  items,
  virtualizer,
  cols,
  folders,
  folderEntries,
  onSelect,
  onToggleFavorite,
  onMoveFolder,
  onCopyBody,
  onDelete,
}: Props) {
  const rowCount = Math.ceil(items.length / cols);
  return (
    <div style={{ height: virtualizer.getTotalSize() }} className="relative w-full">
      {virtualizer.getVirtualItems().map((v) => {
        const start = v.index * cols;
        const row = items.slice(start, start + cols);
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
              {row.map((n) => (
                <Card
                  key={n.id}
                  memo={n}
                  folders={folders}
                  folderEntries={folderEntries}
                  onSelect={onSelect}
                  onToggleFavorite={(id) => onToggleFavorite(id, n.favorite)}
                  onMoveFolder={onMoveFolder}
                  onCopyBody={onCopyBody}
                  onDelete={onDelete}
                />
              ))}
            </div>
          </div>
        );
      })}
      {rowCount === 0 && null}
    </div>
  );
}