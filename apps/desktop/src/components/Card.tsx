/**
 * Neutral note card. Folder hue is carried by a compact marker rather than a
 * full tinted surface, preserving ink-on-paper readability in both themes.
 */
import { Star } from "lucide-react";
import { useMemo, useSyncExternalStore } from "react";

import { colorForFolder } from "../lib/color";
import { useI18n } from "../lib/i18n";
import { useFolderNames } from "../lib/folders";
import { propValueLabel, badgeTone } from "../lib/propDisplay";
import type { FolderDef, FolderEntry, MemoSummary } from "../lib/types";


import { relativeTime } from "../lib/time";
import { renderPreviewMarkdown } from "../lib/markdownPreview";
import { queryCountVersion, subscribeQueryCounts } from "../lib/queryPreviewCounts";
import { useUI } from "../stores/ui";
import { CtxRoot, CtxTrigger } from "./ContextMenu";
import { NoteCtxMenu } from "./NoteCtxMenu";

interface Props {
  memo: MemoSummary;
  folders: FolderDef[];
  folderEntries: FolderEntry[];
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string, favorite: boolean) => void;
  onMoveFolder: (id: string, folder: string) => void;
  onCopyBody: (id: string) => void;
  onDelete: (id: string) => void;
  /** Enter the folder shown by the query-mode chip (browse that folder). */
  onOpenFolder?: (folder: string) => void;
  showFolderChip?: boolean;
  /** Badge declarations from the folder schema: badge = true select
   *  properties, mapped to value → token color (design §7.2). */
  badges?: { key: string; colors: Record<string, string> }[];
  /** Folder preset id for the first-party value vocabulary (§7.2):
   *  `status` words are per-collection (완독 vs 완결). */
  preset?: string;
}


export function Card({ memo, folders, folderEntries, onSelect, onToggleFavorite, onMoveFolder, onCopyBody, onDelete, onOpenFolder, showFolderChip, badges, preset }: Props) {
  const { t, locale } = useI18n();
  const { displayName: displayFolder } = useFolderNames();
  const setDraggingNote = useUI((s) => s.setDraggingNote);
  const folderColor = colorForFolder(memo.folder, folders);
  const queryCountVer = useSyncExternalStore(subscribeQueryCounts, queryCountVersion);
  const previewHtml = useMemo(
    () =>
      memo.preview
        ? renderPreviewMarkdown(memo.preview, 200, {
            thisId: memo.id,
            resultsN: t.query_embed_results_n,
          })
        : "",
    [memo.preview, memo.id, t.query_embed_results_n, queryCountVer],
  );
  return (
    <CtxRoot>
      <CtxTrigger
        render={
          <article
            draggable
            onDragStart={(e) => {
              setDraggingNote(memo);
              e.dataTransfer.setData(
                "application/x-oximemo-notes",
                JSON.stringify([memo.id]),
              );
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => setDraggingNote(null)}
            onClick={() => onSelect(memo.id)}
            className="group relative flex h-44 cursor-default flex-col overflow-hidden rounded-[var(--card-radius)] border border-line bg-surface-raised p-4 shadow-xs transition-[border-color,box-shadow] duration-150 hover:border-line-strong hover:shadow-sm"
          />
        }
      >
      <div className="flex min-w-0 items-center gap-2 pr-8 text-text-subtle">
        {memo.folder && (
          <>
            {folderColor && (
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: folderColor }}
              />
            )}
            <span className="truncate text-xs font-medium text-text-muted">
              {displayFolder(memo.folder)}
            </span>
            <span aria-hidden className="text-text-subtle">·</span>
          </>
        )}
        <time className="shrink-0 text-[11px]">{relativeTime(memo.updated_at, locale)}</time>
        {badges?.map((b) => {
          const v = memo.props?.[b.key];
          const value = v
            ? "Str" in v
              ? v.Str
              : "List" in v
                ? v.List[0]
                : "Bool" in v
                  ? String(v.Bool)
                  : undefined
            : undefined;
          if (!value) return null;
          const token = b.colors[value];
          const tone = badgeTone(token);
          return (
            <span
              key={b.key}
              className={`rounded-[var(--tag-radius)] px-1.5 py-px text-[9px] font-semibold tracking-wide ${tone}`}
            >
              {propValueLabel(b.key, value, t, preset)}
            </span>
          );
        })}
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
          onToggleFavorite(memo.id, memo.favorite);
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
      {(memo.tags.length > 0 || (showFolderChip && memo.folder)) && (
        <div className="mt-auto pt-2">
          {memo.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
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
          {showFolderChip && memo.folder && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenFolder?.(memo.folder);
              }}
              className="mt-1 flex items-center gap-1 text-[10px] text-text-subtle transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <i className="size-1.5 shrink-0 rounded-[2px]" style={{ backgroundColor: folderColor }} />
              <span className="truncate">{displayFolder(memo.folder)}</span>
            </button>
          )}
        </div>
      )}
        <NoteCtxMenu
          memo={memo}
          folderEntries={folderEntries}
          onToggleFavorite={onToggleFavorite}
          onMoveFolder={onMoveFolder}
          onCopyBody={onCopyBody}
          onDelete={onDelete}
        />
      </CtxTrigger>
    </CtxRoot>
  );
}