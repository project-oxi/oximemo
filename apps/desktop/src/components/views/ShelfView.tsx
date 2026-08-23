/**
 * Shelf view (user prompt 2026-08-23, after oxibuilder's movie/book
 * cards): a media wall for cover-bearing collections — poster-ratio
 * cards with the cover_url prop (stamped by the metadata fill flow),
 * a typographic fallback when a note has no cover, the user's rating
 * as stars, and the schema's badge color for status. Clicking opens
 * the note. Only surfaces for schemas that declare `cover_url`
 * (book/movie presets); everything else keeps the classic views.
 */
import { Star } from "lucide-react";

import { useI18n } from "../../lib/i18n";
import type { MemoSummary } from "../../lib/types";

interface Props {
  items: MemoSummary[];
  /** Badge declarations from the folder schema (key → option colors). */
  badges?: { key: string; colors: Record<string, string> }[];
  onSelect: (id: string) => void;
}

function propStr(props: Record<string, unknown> | undefined, key: string): string | null {
  const v = props?.[key];
  if (v && typeof v === "object" && "Str" in v) {
    const s = (v as { Str: string }).Str;
    return s.length ? s : null;
  }
  return null;
}

export function ShelfView({ items, badges, onSelect }: Props) {
  const { t } = useI18n();
  const badgeDefs = badges ?? [];
  if (items.length === 0) {
    return <p className="mt-24 text-center text-sm text-text-subtle">{t.empty_hint}</p>;
  }
  return (
    <div className="h-full overflow-y-auto px-6 pb-10 pt-2">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(118px,1fr))] gap-x-3.5 gap-y-5">
        {items.map((n) => {
          const cover = propStr(n.props, "cover_url");
          const rating = propStr(n.props, "rating");
          const stars = rating ? Number.parseInt(rating, 10) : NaN;
          const statusDef = badgeDefs.find((b) => b.key === "status");
          const status = propStr(n.props, "status");
          const statusColor =
            status && statusDef ? statusDef.colors[status] : undefined;
          const title = n.title ?? "";
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => onSelect(n.id)}
              className="group flex flex-col gap-1.5 text-left"
            >
              <div className="relative aspect-[2/3] w-full overflow-hidden rounded-[var(--card-radius)] border border-line bg-surface-sunken shadow-sm transition-all duration-150 group-hover:-translate-y-0.5 group-hover:shadow-md">
                {cover ? (
                  <img
                    src={cover}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                    onError={(e) => {
                      // Broken remote covers fall back to the typographic card.
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                ) : (
                  <div className="flex h-full w-full items-end bg-gradient-to-br from-surface-muted to-surface-sunken p-2">
                    <p className="line-clamp-4 text-[11px] font-medium leading-snug text-text-muted">
                      {title}
                    </p>
                  </div>
                )}
                {statusColor && (
                  <span
                    className={`absolute left-1.5 top-1.5 inline-block size-2 rounded-full bg-${statusColor} ring-2 ring-surface`}
                    aria-label={status ?? undefined}
                  />
                )}
              </div>
              <div className="min-w-0">
                <p className="line-clamp-1 text-[11px] font-medium text-text">{title}</p>
                {!Number.isNaN(stars) && (
                  <p className="mt-0.5 flex items-center gap-px" aria-label={`${stars}/5`}>
                    {Array.from({ length: 5 }, (_, i) => (
                      <Star
                        key={i}
                        size={8}
                        strokeWidth={0}
                        className={i < stars ? "fill-status-warning text-status-warning" : "fill-line text-line"}
                      />
                    ))}
                  </p>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
