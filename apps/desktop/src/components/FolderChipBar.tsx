/**
 * FolderChipBar — shared 32px navigation chip bar above Timeline/Graph
 * views (§mockup E/F). Each chip carries `data-chip-folder` so Task 14's
 * drag/drop hook can identify the destination folder. The trailing
 * `＋ {t.folder_new}` chip delegates folder creation to the host view
 * (CardGrid wires it to startFolderCreate); Task 12 replaces the minimal
 * inline-create flow with the optimistic-rename version.
 *
 * Visual reference: docs/superpowers/specs/assets/2026-08-20-folder-tile-mockup.html
 * (sections E and F, .chip / .bar classes).
 */
import { Folder, Plus } from "lucide-react";

import { colorForFolder } from "../lib/color";
import { useI18n } from "../lib/i18n";
import type { FolderCard, FolderDef } from "../lib/types";

export interface FolderChipBarProps {
  /** Direct-children cards of the current browse level. Empty → render nothing. */
  cards: FolderCard[];
  /** Folder definitions for color resolution; falls back to hashed hue if empty. */
  folderDefs?: FolderDef[];
  /** Called when a folder chip is clicked. */
  onOpen: (path: string) => void;
  /** Called when the trailing `＋ {t.folder_new}` chip is clicked. */
  onNewFolder: () => void;
}

export function FolderChipBar({ cards, folderDefs, onOpen, onNewFolder }: FolderChipBarProps) {
  const { t } = useI18n();
  // Empty state hides the bar entirely — no orphan "＋ 새 폴더" chip alone
  // because creating a folder with no siblings is already covered by the
  // sidebar/tree UX; surfacing it everywhere would clutter root browse.
  if (cards.length === 0) return null;
  return (
    <div role="list" className="mb-3 flex flex-wrap gap-1.5">
      {cards.map((card) => {
        const color = colorForFolder(card.path, folderDefs ?? []);
        const name = card.path.split("/").at(-1) ?? card.path;
        return (
          <button
            key={card.path}
            type="button"
            role="listitem"
            data-chip-folder={card.path}
            onClick={() => onOpen(card.path)}
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--tag-radius)] border border-line bg-surface-raised px-3 text-[13px] text-text transition-colors duration-150 hover:border-line-strong"
          >
            <Folder size={13} className="shrink-0" style={{ color }} />
            <span className="truncate">{name}</span>
            <span className="text-[11px] tabular-nums text-text-subtle">
              {card.note_count_deep}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        role="listitem"
        onClick={onNewFolder}
        className="inline-flex h-8 items-center gap-1 rounded-[var(--tag-radius)] border border-line bg-surface-raised px-3 text-[13px] text-text-subtle transition-colors duration-150 hover:border-line-strong hover:text-text"
      >
        <Plus size={13} strokeWidth={2} /> {t.folder_new}
      </button>
    </div>
  );
}
