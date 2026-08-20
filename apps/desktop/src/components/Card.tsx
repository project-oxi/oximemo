/**
 * Neutral note card. Folder hue is carried by a compact marker rather than a
 * full tinted surface, preserving ink-on-paper readability in both themes.
 */
import { Star, Trash2, Copy, FolderInput, ClipboardCopy } from "lucide-react";
import { useMemo } from "react";

import { colorForFolder } from "../lib/color";
import { useI18n } from "../lib/i18n";
import type { FolderDef, FolderEntry, MemoSummary } from "../lib/types";
import { relativeTime } from "../lib/time";
import { renderPreviewMarkdown } from "../lib/markdownPreview";
import { CtxRoot, CtxTrigger, CtxMenu, CtxItem, CtxSeparator, CtxSubmenu } from "./ContextMenu";

interface Props {
  memo: MemoSummary;
  folders: FolderDef[];
  folderEntries: FolderEntry[];
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onMoveFolder: (id: string, folder: string) => void;
  onCopyBody: (id: string) => void;
  onDelete: (id: string) => void;
}

export function Card({ memo, folders, folderEntries, onSelect, onToggleFavorite, onMoveFolder, onCopyBody, onDelete }: Props) {
  const { t, locale } = useI18n();
  const folderColor = colorForFolder(memo.folder, folders);

  const previewHtml = useMemo(
    () => (memo.preview ? renderPreviewMarkdown(memo.preview) : ""),
    [memo.preview],
  );
  return (
    <CtxRoot>
      <CtxTrigger
        render={
          <article
            onClick={() => onSelect(memo.id)}
            className="group relative flex h-44 cursor-default flex-col overflow-hidden rounded-[var(--card-radius)] border border-line bg-surface-raised p-4 shadow-xs transition-[border-color,box-shadow] duration-150 hover:border-line-strong hover:shadow-sm"
          />
        }
      >
      <div className="flex min-w-0 items-center gap-2 pr-8 text-text-subtle">
        {folderColor && (
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-[2px]"
            style={{ backgroundColor: folderColor }}
          />
        )}
        <span className="truncate text-xs font-medium text-text-muted">
          {memo.folder || t.all_memos}
        </span>
        <span aria-hidden className="text-text-subtle">·</span>
        <time className="shrink-0 text-[11px]">{relativeTime(memo.updated_at, locale)}</time>
        {memo.path?.endsWith(".html") && (
          <span className="rounded-[var(--tag-radius)] bg-surface-muted px-1 py-px font-mono text-[9px] font-semibold tracking-wide text-text-subtle">
            HTML
          </span>
        )}
      </div>
      <button
        type="button"
        aria-label={memo.favorite ? t.action_unfavorite : t.action_favorite}
        title={memo.favorite ? t.action_unfavorite : t.action_favorite}
        className={`absolute right-2 top-2 z-10 rounded-md p-1.5 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
          memo.favorite
            ? "text-hue-amber hover:bg-surface-muted"
            : "text-text-subtle hover:bg-surface-muted hover:text-hue-amber"
        }`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite(memo.id);
        }}
      >
        <Star size={14} className={memo.favorite ? "fill-hue-amber" : undefined} />
      </button>
      {memo.preview ? (
        <div
          className="md-preview mt-2 line-clamp-4 flex-1 text-sm leading-relaxed text-text"
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      ) : (
        <p className="mt-2 line-clamp-4 flex-1 text-sm leading-relaxed text-text">
          {t.empty_memo}
        </p>
      )}
      {memo.tags.length > 0 && (
        <div className="mt-auto flex flex-wrap gap-1 pt-2">
          {memo.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="rounded-[var(--tag-radius)] bg-surface-muted px-2 py-0.5 text-[10px] font-medium text-text-muted"
            >
              {tag}
            </span>
          ))}
          {memo.tags.length > 3 && (
            <span className="text-[10px] text-text-subtle">+{memo.tags.length - 3}</span>
          )}
        </div>
      )}
        <CtxMenu>
          <CtxItem
            icon={Star}
            label={memo.favorite ? t.action_unfavorite : t.action_favorite}
            onClick={() => onToggleFavorite(memo.id)}
          />
          <CtxSubmenu icon={FolderInput} label={t.action_move_folder ?? "Move to folder"}>
            {folderEntries.map((f) => (
              <CtxItem
                key={f.path || "(root)"}
                label={f.path || "(root)"}
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
      </CtxTrigger>
    </CtxRoot>
  );
}