/**
 * BoardView (query views spec §4/F): kanban over a scalar group property.
 * Column keys + counts come from one `run_base` (includeGroupCounts) over
 * the view's capped dataset; each column pages its own `run_base(group)`
 * slice (spec §3 — per-group pages cannot exceed the view limit).
 * Dragging a card commits the scalar group prop (`removes` for 그룹 없음);
 * List-valued group props disable drag while table grouping still works.
 */
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { baseProps, runBase, updateMemo } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { propValueLabel } from "../../lib/propDisplay";
import { formatBaseValue } from "../../lib/tableModel";
import type { BasePage, BaseSource, BaseValue, PropMutation, RunBaseReq } from "../../lib/types";
import { useUI } from "../../stores/ui";

const COL_PAGE = 20;

interface Props {
  source: BaseSource;
  sourceKey: string;
  viewIndex: number;
  /** Wire form: `note.<key>` / bare key / `formula.<key>`. */
  groupByProp: string | null;
  preset?: string;
  onSelect: (id: string) => void;
}

export function BoardView({ source, sourceKey, viewIndex, groupByProp, preset, onSelect }: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const setToast = useUI((s) => s.setToast);

  const propsQ = useQuery({ queryKey: ["base-props"], queryFn: baseProps });
  const groupKey = groupByProp?.replace(/^(note|formula)\./, "") ?? null;
  const groupIsList =
    groupKey !== null &&
    (propsQ.data?.find((p) => p.key === groupKey)?.observedTypes ?? []).includes("List") === true;

  // One aggregate call: group keys + counts over the capped dataset.
  const countsQ = useQuery({
    queryKey: ["base", sourceKey, viewIndex, "board-columns"],
    queryFn: async () => {
      const req: RunBaseReq = {
        viewIndex, offset: 0, limit: 1, group: null,
        nowMs: null, localOffsetSeconds: null,
        includeGroupCounts: true, includeSummaries: false, thisId: null,
      };
      return runBase(source, req);
    },
    enabled: groupByProp !== null,
  });
  const counts = countsQ.data?.groupCounts ?? [];
  const groups = [...counts.map((c) => c.key)].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : 0));

  const [dragId, setDragId] = useState<string | null>(null);

  const commitGroup = (memoId: string, column: string) => {
    if (!groupKey) return;
    const mutation: PropMutation =
      column === ""
        ? { sets: [], removes: [groupKey] }
        : { sets: [[groupKey, { Str: column }]], removes: [] };
    updateMemo(memoId, null, null, mutation)
      .then(() => qc.invalidateQueries({ queryKey: ["base"] }))
      .catch((e) => setToast(String(e).split("\n")[0]));
  };

  if (!groupByProp) {
    return <div className="mt-16 text-center text-sm text-text-subtle">{t.board_needs_group}</div>;
  }

  return (
    <div className="flex items-start gap-3 overflow-x-auto p-2">
      {groups.map((g) => (
        <BoardColumn
          key={g}
          source={source}
          sourceKey={sourceKey}
          viewIndex={viewIndex}
          column={g}
          count={counts.find((c) => c.key === g)?.count ?? 0}
          preset={preset}
          groupIsList={groupIsList}
          dragId={dragId}
          setDragId={setDragId}
          onDropCard={(id) => commitGroup(id, g)}
          onSelect={onSelect}
        />
      ))}
      {groups.length === 0 && !countsQ.isLoading && (
        <div className="p-4 text-sm text-text-subtle">{t.empty_hint}</div>
      )}
    </div>
  );
}

function BoardColumn({
  source,
  sourceKey,
  viewIndex,
  column,
  count,
  preset,
  groupIsList,
  dragId,
  setDragId,
  onDropCard,
  onSelect,
}: {
  source: BaseSource;
  sourceKey: string;
  viewIndex: number;
  column: string;
  count: number;
  preset?: string;
  groupIsList: boolean;
  dragId: string | null;
  setDragId: (id: string | null) => void;
  onDropCard: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const [dropOn, setDropOn] = useState(false);
  const q = useInfiniteQuery({
    queryKey: ["base", sourceKey, viewIndex, "group", column],
    queryFn: ({ pageParam }) => {
      const req: RunBaseReq = {
        viewIndex, offset: pageParam, limit: COL_PAGE, group: column,
        nowMs: null, localOffsetSeconds: null,
        includeGroupCounts: false, includeSummaries: false, thisId: null,
      };
      return runBase(source, req);
    },
    initialPageParam: 0,
    getNextPageParam: (_last: BasePage, all) => {
      const loaded = all.reduce((n, p) => n + p.rows.length, 0);
      return loaded < count ? loaded : undefined;
    },
  });
  const rows = q.data?.pages.flatMap((p) => p.rows) ?? [];
  const label = column === "" ? t.group_none : propValueLabel(column, column, t, preset);
  return (
    <div
      onDragOver={(e) => {
        if (groupIsList) return;
        e.preventDefault();
        setDropOn(true);
      }}
      onDragLeave={() => setDropOn(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropOn(false);
        if (dragId && !groupIsList) onDropCard(dragId);
        setDragId(null);
      }}
      className={`flex w-56 shrink-0 flex-col gap-1 rounded-[var(--popover-radius)] border p-2 ${
        dropOn ? "border-hue-blue/60 bg-hue-blue/5" : "border-line bg-surface-sunken/40"
      }`}
    >
      <div className="flex items-center gap-1 px-1 text-[11px] font-semibold text-text-muted">
        <ChevronDown size={11} aria-hidden />
        {label}
        <span className="ml-auto text-text-subtle tabular-nums">{count}</span>
      </div>
      {rows.map((r) => {
        const title = r.summary.title ?? r.summary.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
        return (
          <button
            key={r.summary.id}
            type="button"
            draggable={!groupIsList}
            onDragStart={() => setDragId(r.summary.id)}
            onDragEnd={() => setDragId(null)}
            onClick={() => onSelect(r.summary.id)}
            title={groupIsList ? t.board_drag_disabled : undefined}
            className="rounded-[var(--tag-radius)] border border-line bg-surface px-2 py-1.5 text-left text-[12px] text-text shadow-sm transition-colors duration-150 hover:border-line-strong"
          >
            <span className="block truncate font-medium">{title}</span>
            <span className="mt-0.5 block truncate text-[10px] text-text-subtle">
              {r.cells.slice(1, 3).map((c) => (c.error ? "⚠︎" : formatBaseValue(c.value as BaseValue | null))).join(" · ")}
            </span>
          </button>
        );
      })}
      {q.hasNextPage && (
        <button
          type="button"
          onClick={() => void q.fetchNextPage()}
          className="self-center rounded-[var(--tag-radius)] px-2 py-0.5 text-[10px] text-text-subtle hover:bg-surface-muted"
        >
          {t.query_more}
        </button>
      )}
      {rows.length === 0 && !q.isLoading && (
        <span className="px-1 py-2 text-center text-[11px] text-text-subtle/70">—</span>
      )}
    </div>
  );
}
