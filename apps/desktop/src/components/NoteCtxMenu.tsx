/**
 * NoteCtxMenu — the shared note context menu (Task 12). Every note surface
 * (grid Card, List row, Timeline row) renders this exact menu so right-click
 * affordances stay identical across views. Extracted verbatim from Card.tsx.
 */
import { Star, Trash2, Copy, FolderInput, ClipboardCopy } from "lucide-react";

import { useI18n } from "../lib/i18n";
import type { FolderEntry, MemoSummary } from "../lib/types";

import { CtxMenu, CtxItem, CtxSeparator, CtxSubmenu } from "./ContextMenu";

interface Props {
  memo: MemoSummary;
  folderEntries: FolderEntry[];
  /** Receives the note's CURRENT favorite state; the handler flips it. */
  onToggleFavorite: (id: string, favorite: boolean) => void;
  onMoveFolder: (id: string, folder: string) => void;
  onCopyBody: (id: string) => void;
  onDelete: (id: string) => void;
}

export function NoteCtxMenu({
  memo,
  folderEntries,
  onToggleFavorite,
  onMoveFolder,
  onCopyBody,
  onDelete,
}: Props) {
  const { t } = useI18n();
  return (
    <CtxMenu>
      <CtxItem
        icon={Star}
        label={memo.favorite ? t.action_unfavorite : t.action_favorite}
        onClick={() => onToggleFavorite(memo.id, memo.favorite)}
      />
      <CtxSubmenu icon={FolderInput} label={t.action_move_folder ?? "Move to folder"}>
        {folderEntries.map((f) => (
          <CtxItem
            key={f.path || "root"}
            label={f.path || t.folder_root}
            disabled={memo.folder === f.path}
            onClick={() => onMoveFolder(memo.id, f.path)}
          />
        ))}
      </CtxSubmenu>
      <CtxSeparator />
      <CtxItem icon={ClipboardCopy} label={t.action_copy_body} onClick={() => onCopyBody(memo.id)} />
      <CtxItem
        icon={Copy}
        label={t.action_copy_id}
        onClick={() => {
          void navigator.clipboard.writeText(memo.id);
        }}
      />
      <CtxSeparator />
      <CtxItem icon={Trash2} label={t.action_delete} danger onClick={() => onDelete(memo.id)} />
    </CtxMenu>
  );
}
