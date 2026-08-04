/**
 * Card component for a memo summary. The memo's color fills the whole card as
 * colored "paper" (post-it), not just a side accent — see `paperFor` in
 * lib/color.ts, which washes the OKLCH color toward the theme's card surface.
 * Renders the preview text, tags, the favorite star (pinned top-right, always
 * yellow when favorited), and hover actions (copy/delete).
 */
import { Star, Trash2, Copy, FolderInput, ClipboardCopy } from "lucide-react";
import { useMemo, useState } from "react";

import { edgeFor, paperFor } from "../lib/color";
import { colorForCategory } from "../lib/color";
import { useI18n } from "../lib/i18n";
import type { CategoryDef, MemoSummary } from "../lib/types";
import { relativeTime } from "../lib/time";
import { renderPreviewMarkdown } from "../lib/markdownPreview";
import { CtxRoot, CtxTrigger, CtxMenu, CtxItem, CtxSeparator, CtxSubmenu } from "./ContextMenu";

interface Props {
  memo: MemoSummary;
  categories: CategoryDef[];
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onMoveCategory: (id: string, category: string) => void;
  onCopyBody: (id: string) => void;
  onDelete: (id: string) => void;
}

export function Card({ memo, categories, onSelect, onToggleFavorite, onMoveCategory, onCopyBody, onDelete }: Props) {
  const { t, locale } = useI18n();
  const [copied, setCopied] = useState(false);
  const shortId = memo.id.slice(0, 8);

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
            style={{
              backgroundColor: paperFor(colorForCategory(memo.category, categories)),
              borderColor: edgeFor(colorForCategory(memo.category, categories)),
            }}
            className="group relative flex h-44 cursor-default flex-col overflow-hidden rounded-[var(--card-radius)] border p-4 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
          />
        }
      >
      <div className="flex items-center gap-1.5 pr-7 text-text-subtle">
        <span className="text-[11px]">{relativeTime(memo.updated_at, locale)}</span>
        <span aria-hidden className="text-text-subtle">
          ·
        </span>
        <span className="font-mono text-[10px] text-text-subtle">
          {shortId}
        </span>
      </div>
      <button
        type="button"
        aria-label={memo.favorite ? t.action_unfavorite : t.action_favorite}
        title={memo.favorite ? t.action_unfavorite : t.action_favorite}
        className={`absolute right-2 top-2 z-10 rounded-md p-1.5 transition-all duration-150 ${
          memo.favorite
            ? "text-hue-amber hover:text-hue-amber"
            : "text-text-subtle opacity-0 hover:bg-surface-muted hover:text-hue-amber group-hover:opacity-100"
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
              className="rounded-full bg-status-warning-subtle px-2 py-0.5 text-[10px] font-medium text-hue-amber"
            >
              {tag}
            </span>
          ))}
          {memo.tags.length > 3 && (
            <span className="text-[10px] text-text-subtle">+{memo.tags.length - 3}</span>
          )}
        </div>
      )}
      <div className="mt-3 flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          aria-label={t.copy}
          className="rounded-md p-1.5 text-text-subtle hover:bg-surface-muted hover:text-text"
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard.writeText(memo.id).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 800);
            });
          }}
        >
          <Copy size={14} />
          {copied && <span className="ml-1 text-[10px]">{t.copied}</span>}
        </button>
        <button
          type="button"
          aria-label={t.action_delete}
          className="rounded-md p-1.5 text-text-subtle hover:bg-status-error-subtle hover:text-status-error"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(memo.id);
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
        <CtxMenu>
          <CtxItem
            icon={Star}
            label={memo.favorite ? t.action_unfavorite : t.action_favorite}
            onClick={() => onToggleFavorite(memo.id)}
          />
          <CtxSubmenu icon={FolderInput} label={t.action_move_category}>
            {categories.map((c) => (
              <CtxItem
                key={c.id}
                label={c.id}
                disabled={memo.category === c.id}
                onClick={() => onMoveCategory(memo.id, c.id)}
              />
            ))}
          </CtxSubmenu>
          <CtxSeparator />
          <CtxItem icon={ClipboardCopy} label={t.action_copy_body} onClick={() => onCopyBody(memo.id)} />
          <CtxItem
            icon={Copy}
            label={t.action_copy_id}
            onClick={() => {
              void navigator.clipboard.writeText(memo.id).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 800);
              });
            }}
          />
          <CtxSeparator />
          <CtxItem icon={Trash2} label={t.action_delete} danger onClick={() => onDelete(memo.id)} />
        </CtxMenu>
      </CtxTrigger>
    </CtxRoot>
  );
}
