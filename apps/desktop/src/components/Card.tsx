/**
 * Card component for a memo summary. The memo's color fills the whole card as
 * colored "paper" (post-it), not just a side accent — see `paperFor` in
 * lib/color.ts, which washes the OKLCH color toward the theme's card surface.
 * Renders the preview text, tags, and hover actions (favorite/delete/copy).
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
            className="group relative flex h-44 cursor-default flex-col overflow-hidden rounded-2xl border p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_3px_10px_-3px_rgba(0,0,0,0.08)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_2px_5px_rgba(0,0,0,0.06),0_10px_24px_-6px_rgba(0,0,0,0.14)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.3),0_3px_10px_-3px_rgba(0,0,0,0.5)] dark:hover:shadow-[0_2px_5px_rgba(0,0,0,0.4),0_10px_24px_-6px_rgba(0,0,0,0.6)]"
          />
        }
      >
      <div className="flex items-center gap-1.5 text-zinc-500/90 dark:text-zinc-400">
        <span className="text-[11px]">{relativeTime(memo.updated_at, locale)}</span>
        <span aria-hidden className="text-zinc-400/50 dark:text-zinc-600">
          ·
        </span>
        <span className="font-mono text-[10px] text-zinc-400/90 dark:text-zinc-500">
          {shortId}
        </span>
        {memo.favorite && (
          <span className="ml-auto inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <Star size={10} /> {t.favorite}
          </span>
        )}
      </div>
      {memo.preview ? (
        <div
          className="md-preview mt-2 line-clamp-4 flex-1 text-sm leading-relaxed text-zinc-700 dark:text-zinc-200"
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      ) : (
        <p className="mt-2 line-clamp-4 flex-1 text-sm leading-relaxed text-zinc-700 dark:text-zinc-200">
          {t.empty_memo}
        </p>
      )}
      {memo.tags.length > 0 && (
        <div className="mt-auto flex flex-wrap gap-1 pt-2">
          {memo.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-[var(--tag-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--tag)]"
            >
              {tag}
            </span>
          ))}
          {memo.tags.length > 3 && (
            <span className="text-[10px] text-zinc-400">+{memo.tags.length - 3}</span>
          )}
        </div>
      )}
      <div className="mt-3 flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          aria-label={t.copy}
          className="rounded-md p-1.5 text-zinc-500 hover:bg-black/5 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100"
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
          aria-label={t.action_favorite}
          className="rounded-md p-1.5 text-zinc-500 hover:bg-black/5 hover:text-amber-600 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-amber-400"
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(memo.id);
          }}
        >
          <Star size={14} />
        </button>
        <button
          type="button"
          aria-label={t.action_delete}
          className="rounded-md p-1.5 text-zinc-500 hover:bg-red-500/10 hover:text-red-500 dark:text-zinc-400 dark:hover:bg-red-500/20"
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
