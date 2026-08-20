/**
 * FolderTile — a 176px content-peek tile per the approved mockup C (§4.3).
 * Renders in the grid cell array ahead of note cards; opening the tile
 * navigates into the folder via the same store action the breadcrumb uses.
 */
import { Folder, Plus } from "lucide-react";

import { colorForFolder } from "../lib/color";
import { useI18n } from "../lib/i18n";
import { relativeTime } from "../lib/time";
import type { FolderCard, FolderDef } from "../lib/types";

interface Props {
  card: FolderCard;
  folders: FolderDef[];
  onOpen: (path: string) => void;
  onOpenNote: (id: string) => void;
  onNewNote: (path: string) => void;
}

export function FolderTile({ card, folders, onOpen, onOpenNote, onNewNote }: Props) {
  const { t, locale } = useI18n();
  const color = colorForFolder(card.path, folders);
  return (
    <article
      data-folder-tile={card.path}
      role="button"
      aria-label={card.path}
      tabIndex={0}
      onClick={() => onOpen(card.path)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(card.path);
      }}
      className="group relative flex h-44 cursor-default flex-col overflow-hidden rounded-[var(--card-radius)] border border-line bg-[var(--folder-tile-bg)] p-4 shadow-xs transition-[border-color,box-shadow] duration-150 hover:border-line-strong hover:shadow-sm"
    >
      <span
        aria-hidden
        className="absolute left-4 top-0 h-[3px] w-7 rounded-b-[3px]"
        style={{ backgroundColor: color }}
      />
      <div className="flex min-w-0 items-center gap-2">
        <Folder size={13} className="shrink-0" style={{ color }} />
        <span className="truncate text-sm font-semibold text-text">
          {card.path.split("/").at(-1)}
        </span>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-text-subtle">
          {card.note_count_deep}
        </span>
      </div>
      <div className="my-2 border-t border-line" />
      {card.recent.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {card.recent.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenNote(r.id);
              }}
              className="truncate rounded px-1 py-0.5 text-left text-[13px] leading-relaxed text-text-muted hover:bg-surface-muted hover:text-text"
            >
              {r.title ?? t.empty_memo}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-start justify-center gap-2">
          <span className="text-[13px] text-text-subtle">{t.folder_empty}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onNewNote(card.path);
            }}
            className="rounded-[var(--tag-radius)] border border-line bg-surface-raised px-2.5 py-1 text-xs text-text-muted hover:border-line-strong hover:text-text"
          >
            <Plus size={11} className="mr-1 inline" /> {t.new_note_md}
          </button>
        </div>
      )}
      <div className="mt-auto flex gap-1.5 pt-1.5 text-[11px] text-text-subtle">
        {card.subfolder_count > 0 && (
          <span>{t.folder_subfolders.replace("{n}", String(card.subfolder_count))}</span>
        )}
        {card.subfolder_count > 0 && <span>·</span>}
        <span>{card.recent[0] ? relativeTime(card.recent[0].updated_at, locale) : ""}</span>
      </div>
    </article>
  );
}
