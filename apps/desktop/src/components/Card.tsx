/**
 * Card component for a note summary. Renders a color bar on the left, the
 * preview text, tags, and hover actions (pin/delete/copy). The visual
 * language stays minimal: thin separators, generous whitespace, no icons
 * unless they add meaning.
 */
import { Pin, Trash2, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";

import { barFor } from "../lib/color";
import { useI18n } from "../lib/i18n";
import type { NoteSummary } from "../lib/types";
import { relativeTime } from "../lib/time";

interface Props {
  note: NoteSummary;
  onSelect: (id: string) => void;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
}

export function Card({ note, onSelect, onTogglePin, onDelete }: Props) {
  const { t, locale } = useI18n();
  const [copied, setCopied] = useState(false);
  const shortId = note.id.slice(0, 8);

  function renderInline(text: string): ReactNode[] {
    if (!text) return [];
    return text
      .split(/\*\*(.+?)\*\*/)
      .map((seg, i) =>
        i % 2 === 1 ? (
          <strong key={i} className="font-semibold">
            {seg}
          </strong>
        ) : (
          seg
        ),
      );
  }
  return (
    <article
      className="group relative flex h-44 flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900"
      onClick={() => onSelect(note.id)}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1"
        style={{ background: barFor(note.color) }}
      />
      <div className="flex items-center gap-1.5 pl-2 text-zinc-500 dark:text-zinc-400">
        <span className="text-[11px]">{relativeTime(note.updated_at, locale)}</span>
        <span aria-hidden className="text-zinc-300 dark:text-zinc-600">·</span>
        <span className="font-mono text-[10px] text-zinc-400">{shortId}</span>
        {note.pinned && (
          <span className="ml-auto inline-flex items-center gap-1 text-amber-500">
            <Pin size={10} /> {t.pinned}
          </span>
        )}
      </div>
      <p className="mt-2 line-clamp-4 flex-1 whitespace-pre-wrap pl-2 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
        {note.preview ? renderInline(note.preview) : "(empty)"}
      </p>
      {note.tags.length > 0 && (
        <div className="mt-auto flex flex-wrap gap-1 pl-2 pt-2">
          {note.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
            >
              {tag}
            </span>
          ))}
          {note.tags.length > 3 && (
            <span className="text-[10px] text-zinc-400">+{note.tags.length - 3}</span>
          )}
        </div>
      )}
      <div className="mt-3 flex items-center justify-end gap-1 pl-2 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          aria-label="copy"
          className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard.writeText(note.id).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 800);
            });
          }}
        >
          <Copy size={14} />
          {copied && <span className="ml-1 text-[10px]">copied</span>}
        </button>
        <button
          type="button"
          aria-label="pin"
          className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-amber-500 dark:hover:bg-zinc-800"
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin(note.id);
          }}
        >
          <Pin size={14} />
        </button>
        <button
          type="button"
          aria-label="delete"
          className="rounded-md p-1.5 text-zinc-500 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(note.id);
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </article>
  );
}
