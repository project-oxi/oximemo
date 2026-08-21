/**
 * FolderTile — a 176px content-peek tile per the approved mockup C (§4.3).
 * Renders in the grid cell array ahead of note cards; opening the tile
 * navigates into the folder via the same store action the breadcrumb uses.
 *
 * FolderMenu (exported) is the shared folder context-menu wrapper — Root,
 * Trigger, and the menu itself: open, rename, sidebar pin, and the
 * two-click armed delete — used by both the tile and the List view's
 * folder rows (M20: 폴더 콘텍스트 타일·행 공통).
 */
import { Folder, FolderOpen, PenLine, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { colorForFolder } from "../lib/color";
import { useFolderDrop } from "../lib/dropTarget";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";
import { relativeTime } from "../lib/time";

import type { FolderCard, FolderDef } from "../lib/types";

import { CtxRoot, CtxTrigger, CtxMenu, CtxItem, CtxSeparator } from "./ContextMenu";

/** A naming session: which folder is being (re)named, and whether it was
 *  just created (cancel then DELETES the brand-new folder — T10's
 *  existing-folder cancel is a no-op instead). */
export interface NamingSession {
  path: string;
  isNew: boolean;
}

/** Shared folder context menu wrapper (CtxRoot + CtxTrigger + menu).
 *  `render` merges the trigger onto the folder's own element (article for
 *  the tile, div for a list row); `children` is that element's content.
 *
 *  The two-click delete arm lives in this component's state and is
 *  strictly session-scoped: first click on 삭제… arms (label becomes
 *  삭제 확인, danger styling, confirm wording as tooltip), the next click
 *  within the same menu session commits. The arm RESETS when the menu
 *  closes (Root onOpenChange(false)) and auto-expires after 4s — the
 *  same two rules as SettingsMenu's reset arm — so it can never survive
 *  into a later session and turn one stray click into a delete.
 *  window.confirm is unreliable in Tauri's WKWebView (SettingsMenu
 *  precedent). */
export function FolderMenu({
  path,
  deep,
  pinned,
  onOpen,
  onRename,
  onTogglePin,
  onDelete,
  render,
  children,
}: {
  path: string;
  /** Recursive note count — powers the confirm wording and the commit. */
  deep: number;
  pinned: boolean;
  onOpen: (path: string) => void;
  onRename: (path: string) => void;
  onTogglePin: (path: string, pinned: boolean) => void;
  onDelete: (path: string, deep: number, confirmed: boolean) => void;
  /** The folder's own element (article/div); the trigger merges onto it. */
  render: React.ReactElement<Record<string, unknown>>;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<number | null>(null);
  const disarm = () => {
    setArmed(false);
    if (armTimer.current) {
      window.clearTimeout(armTimer.current);
      armTimer.current = null;
    }
  };
  useEffect(() => () => disarm(), []);
  const name = path.split("/").at(-1) ?? path;
  return (
    <CtxRoot onOpenChange={(open) => { if (!open) disarm(); }}>
      <CtxTrigger render={render}>
        {children}
        <CtxMenu>
          <CtxItem icon={FolderOpen} label={t.folder_open} onClick={() => onOpen(path)} />
          <CtxSeparator />
          <CtxItem icon={PenLine} label={t.rename_folder} onClick={() => onRename(path)} />
          <CtxItem
            icon={pinned ? PinOff : Pin}
            label={pinned ? t.unpin_from_sidebar : t.pin_to_sidebar}
            onClick={() => onTogglePin(path, !pinned)}
          />
          <CtxSeparator />
          {armed ? (
            <CtxItem
              icon={Trash2}
              label={t.delete_confirm_arm}
              danger
              title={t.delete_folder_confirm
                .replace("{folder}", name)
                .replace("{n}", String(deep))}
              onClick={() => {
                disarm();
                onDelete(path, deep, true);
              }}
            />
          ) : (
            <CtxItem
              icon={Trash2}
              label={t.delete_folder_action}
              danger
              keepOpen
              onClick={() => {
                setArmed(true);
                if (armTimer.current) window.clearTimeout(armTimer.current);
                armTimer.current = window.setTimeout(disarm, 4000);
              }}
            />
          )}
        </CtxMenu>
      </CtxTrigger>
    </CtxRoot>
  );
}

interface Props {
  card: FolderCard;
  folders: FolderDef[];
  /** Current sidebar pin state for this folder (from config's FolderDef). */
  pinned: boolean;
  onOpen: (path: string) => void;
  onOpenNote: (id: string) => void;
  onNewNote: (path: string) => void;
  onRename: (path: string) => void;
  onTogglePin: (path: string, pinned: boolean) => void;
  onDelete: (path: string, deep: number, confirmed: boolean) => void;
  /** Move a dragged note into this tile's folder (T14 drop target). */
  onMoveFolder: (id: string, folder: string) => void;
  /** Move a dragged folder subtree into this tile's folder (drop target). */
  onMoveFolderTree?: (path: string, dest: string) => void;
  /** Naming session of the folder being edited (inline rename/create). */
  namingPath: NamingSession | null;
  /** null = cancelled (Esc) → caller handles teardown; string = confirm (rename if changed). */
  onNameCommit: (value: string | null) => void;
}

export function FolderTile({
  card,
  folders,
  pinned,
  onOpen,
  onOpenNote,
  onNewNote,
  onRename,
  onTogglePin,
  onMoveFolder,
  onMoveFolderTree,
  onDelete,
  namingPath,
  onNameCommit,
}: Props) {
  const { t, locale } = useI18n();
  const color = colorForFolder(card.path, folders);
  const naming = namingPath?.path === card.path;
  // M16: the tile is inert while the dragged note already lives here.
  // Folder drags: also a target — cycles/parent no-ops suppressed in the
  // hook; the handler moves the dragged folder INTO this tile's folder.
  const { dropCls, ...dropProps } = useFolderDrop(
    card.path,
    (id) => onMoveFolder(id, card.path),
    onMoveFolderTree ? (p) => onMoveFolderTree(p, card.path) : undefined,
  );
  const setDraggingFolder = useUI((s) => s.setDraggingFolder);
  return (
    <FolderMenu
      path={card.path}
      deep={card.note_count_deep}
      pinned={pinned}
      onOpen={onOpen}
      onRename={onRename}
      onTogglePin={onTogglePin}
      onDelete={onDelete}
      render={
        <article
          data-folder-tile={card.path}
          draggable={!naming}
          onDragStart={(e) => {
            setDraggingFolder(card.path);
            e.dataTransfer.setData("application/x-oximemo-folder", card.path);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => setDraggingFolder(null)}
          {...dropProps}
          role="button"
          aria-label={`${card.path} · ${card.note_count_deep}`}
          tabIndex={0}
          onClick={() => {
            if (naming) return;
            onOpen(card.path);
          }}
          onKeyDown={(e) => {
            if (naming) return;
            if (e.key === "Enter") onOpen(card.path);
          }}
          className={`group relative flex h-44 cursor-default flex-col overflow-hidden rounded-[var(--card-radius)] border border-line bg-[var(--folder-tile-bg)] p-4 shadow-xs transition-[border-color,box-shadow] duration-150 hover:border-line-strong hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${dropCls ?? ""}`}
        />
      }
    >
      <span
        aria-hidden
        className="absolute left-4 top-0 h-[3px] w-7 rounded-b-[3px]"
        style={{ backgroundColor: color }}
      />
      <div className="flex min-w-0 items-center gap-2">
        <Folder size={13} className="shrink-0" style={{ color }} />
        {naming ? (
          <input
            autoFocus
            defaultValue={card.path.split("/").at(-1) ?? ""}
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
            className="w-full min-w-0 flex-1 bg-transparent px-0 py-0 text-sm font-semibold text-text outline-none"
          />
        ) : (
          <span className="truncate text-sm font-semibold text-text">
            {card.path.split("/").at(-1)}
          </span>
        )}
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
    </FolderMenu>
  );
}
