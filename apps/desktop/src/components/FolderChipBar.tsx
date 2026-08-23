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
import { useUI } from "../stores/ui";
import { colorForFolder } from "../lib/color";
import { useI18n } from "../lib/i18n";
import { useFolderNames } from "../lib/folders";
import { useFolderDrop } from "../lib/dropTarget";
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
  /** Move a dragged note into the chip's folder (T14 drop target). */
  onMoveNote: (id: string, folder: string) => void;
  /** Move a dragged folder subtree into the chip's folder (drop target). */
  onMoveFolderTree?: (path: string, dest: string) => void;
}

export function FolderChipBar({ cards, folderDefs, onOpen, onNewFolder, onMoveNote, onMoveFolderTree }: FolderChipBarProps) {
  const { t } = useI18n();
  // Empty state hides the bar entirely — no orphan "＋ 새 폴더" chip
  // alone; the header FolderPlus button is the always-visible create
  // affordance, so the chip only needs to exist where sibling chips do.
  if (cards.length === 0) return null;
  return (
    <div role="list" className="mb-3 flex flex-wrap gap-1.5">
      {cards.map((card) => (
        <FolderChip
          key={card.path}
          card={card}
          folderDefs={folderDefs ?? []}
          onOpen={onOpen}
          onMoveNote={onMoveNote}
          onMoveFolderTree={onMoveFolderTree}
        />
      ))}
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

/** One folder chip: a drop target (T14) extracted so useFolderDrop runs
 *  at a stable hook index inside the cards map. */
function FolderChip({
  card,
  folderDefs,
  onOpen,
  onMoveNote,
  onMoveFolderTree,
}: {
  card: FolderCard;
  folderDefs: FolderDef[];
  onOpen: (path: string) => void;
  onMoveNote: (id: string, folder: string) => void;
  onMoveFolderTree?: (path: string, dest: string) => void;
}) {
  const color = colorForFolder(card.path, folderDefs);
  const name = useFolderNames().leafName(card.path);
  const setDraggingFolder = useUI((s) => s.setDraggingFolder);
  // M16: the chip is inert while the dragged note already lives here.
  // Folder drags land here too (cycles/parent no-ops suppressed in the hook).
  const { dropCls, ...dropProps } = useFolderDrop(
    card.path,
    (id) => onMoveNote(id, card.path),
    onMoveFolderTree ? (p) => onMoveFolderTree(p, card.path) : undefined,
  );
  return (
    <button
      type="button"
      role="listitem"
      draggable
      onDragStart={(e) => {
        setDraggingFolder(card.path);
        e.dataTransfer.setData("application/x-oximemo-folder", card.path);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => setDraggingFolder(null)}
      data-chip-folder={card.path}
      onClick={() => onOpen(card.path)}
      {...dropProps}
      className={`inline-flex h-8 items-center gap-1.5 rounded-[var(--tag-radius)] border border-line bg-surface-raised px-3 text-[13px] text-text transition-colors duration-150 hover:border-line-strong ${dropCls ?? ""}`}
    >
      <Folder size={13} className="shrink-0" style={{ color }} />
      <span className="truncate">{name}</span>
      <span className="text-[11px] tabular-nums text-text-subtle">
        {card.note_count_deep}
      </span>
    </button>
  );
}
