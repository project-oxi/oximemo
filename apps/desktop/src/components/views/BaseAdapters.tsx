/**
 * Note-only adapters over a base's rows (query views spec §4): `cards`
 * reuses the browse Card renderer (its own note-drag contract — the
 * folder-card handlers of GridView/ListView are deliberately absent) and
 * `list` is a lean title+preview row list. Both honor the view's
 * filters/order/limit through the shared BaseView run query, ignore
 * columns/summaries, and offer no cell editing.
 */
import { Card } from "../Card";
import { useI18n } from "../../lib/i18n";
import { useFolderNames } from "../../lib/folders";
import { previewText } from "../../lib/markdownPreview";
import { relativeTime } from "../../lib/time";
import type { BaseRow, FolderDef, FolderEntry } from "../../lib/types";

interface CardsProps {
  rows: BaseRow[];
  folders: FolderDef[];
  folderEntries: FolderEntry[];
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string, favorite: boolean) => void;
}

export function BaseCardsAdapter({ rows, folders, folderEntries, onSelect, onToggleFavorite }: CardsProps) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3 p-2">
      {rows.map((r) => (
        <Card
          key={r.summary.id}
          memo={r.summary}
          folders={folders}
          folderEntries={folderEntries}
          onSelect={onSelect}
          onToggleFavorite={onToggleFavorite}
          onMoveFolder={() => {}}
          onCopyBody={() => {}}
          onDelete={() => {}}
        />
      ))}
    </div>
  );
}

export function BaseListAdapter({
  rows,
  onSelect,
}: {
  rows: BaseRow[];
  onSelect: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const { displayName } = useFolderNames();
  return (
    <div className="flex flex-col">
      {rows.map((r) => {
        const title = r.summary.title ?? r.summary.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
        return (
          <button
            key={r.summary.id}
            type="button"
            onClick={() => onSelect(r.summary.id)}
            className="flex items-baseline gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-surface-muted/60"
          >
            <span className="min-w-0 flex-1 truncate text-[13px] text-text">{title}</span>
            <span className="w-40 shrink-0 truncate text-[11px] text-text-subtle">
              {previewText(r.summary.preview, 90)}
            </span>
            <span className="w-24 shrink-0 truncate text-right text-[11px] text-text-subtle">
              {displayName(r.summary.folder) || t.vault_root}
            </span>
            <span className="w-16 shrink-0 text-right text-[11px] text-text-subtle">
              {relativeTime(r.summary.updated_at, locale)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
