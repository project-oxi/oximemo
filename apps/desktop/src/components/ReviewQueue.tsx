/**
 * Review queue (design 2026-08-23 §7.3): notes whose review property is
 * one of the schema's `due_values`, oldest-first by `order_by` (falling
 * back to core `updated` when the date property is missing). Two actions
 * per item — "설명 가능함" reasserts the same value (backend `on="write"`
 * rule stamps the review date) and "막힘" transitions to `decay_to` (the
 * max-merge rule preserves `peak_status`).
 *
 * Renders only for folders whose SCHEMA.toml declares `[review]`.
 */
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";

import { queryNotes, updateMemo } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { relativeTime } from "../lib/time";
import type { PropValue, SchemaReviewDef } from "../lib/types";

function first(v: PropValue | undefined): string | undefined {
  if (!v) return undefined;
  if ("Str" in v) return v.Str;
  if ("List" in v) return v.List[0];
  return String((v as { Bool: boolean }).Bool);
}

export function ReviewQueue({ folder, review }: { folder: string; review: SchemaReviewDef }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const list = useInfiniteQuery({
    queryKey: ["review", folder, review.property],
    queryFn: ({ pageParam }) =>
      queryNotes({
        folder,
        props: [
          { key: review.property, op: "In", values: review.due_values },
        ],
        sort: review.order_by
          ? { PropAsc: review.order_by }
          : "UpdatedAsc",
        offset: pageParam as number,
        limit: 50,
      }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });

  const act = async (id: string, value: string) => {
    try {
      await updateMemo(id, null, null, { sets: [[review.property, { Str: value }]], removes: [] });
      await qc.invalidateQueries({ queryKey: ["review"] });
      await qc.invalidateQueries({ queryKey: ["memos"] });
    } catch {
      /* grid surfaces IPC errors */
    }
  };

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages.at(-1)?.total ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-10 pt-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-subtle">
          {t.review_due_count.replace("{n}", String(total))}
        </span>
        <div className="flex gap-1">
          {review.due_values.map((v) => (
            <span
              key={v}
              className="rounded-[var(--tag-radius)] bg-surface-muted px-1.5 py-0.5 text-[11px] text-text-subtle"
            >
              {v}: {items.filter((n) => first(n.props?.[review.property]) === v).length}
            </span>
          ))}
        </div>
      </div>
      {items.length === 0 && (
        <div className="flex flex-1 items-center justify-center text-sm text-text-subtle">
          {t.review_empty}
        </div>
      )}
      <ul className="flex flex-col gap-1.5">
        {items.map((n) => (
          <li
            key={n.id}
            className="flex items-center gap-3 rounded-[var(--card-radius)] border border-line bg-surface px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-text">
                {n.title ?? n.path}
              </div>
              <div className="text-[11px] text-text-subtle">
                {first(n.props?.[review.property])} ·{" "}
                {first(n.props?.[review.order_by ?? ""]) ??
                  relativeTime(n.updated_at, locale)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void act(n.id, first(n.props?.[review.property]) ?? review.due_values[0])}
              className="inline-flex items-center gap-1 rounded-[var(--button-radius)] bg-interactive-primary px-2.5 py-1.5 text-[11px] font-medium text-interactive-primary-foreground transition-colors duration-150 hover:bg-interactive-primary/90"
              title={t.review_still_valid}
            >
              <Check size={12} />
              {t.review_pass}
            </button>
            <button
              type="button"
              onClick={() => void act(n.id, review.decay_to)}
              className="inline-flex items-center gap-1 rounded-[var(--button-radius)] border border-line bg-surface px-2.5 py-1.5 text-[11px] font-medium text-hue-red transition-colors duration-150 hover:bg-surface-muted"
            >
              <X size={12} />
              {t.review_fail}
            </button>
          </li>
        ))}
      </ul>
      {list.hasNextPage && (
        <button
          type="button"
          onClick={() => void list.fetchNextPage()}
          className="self-center rounded-[var(--button-radius)] bg-surface-muted px-3 py-1.5 text-xs text-text-subtle hover:text-text"
        >
          +
        </button>
      )}
    </div>
  );
}
