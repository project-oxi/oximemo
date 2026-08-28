/**
 * BoardView (query views spec §4/F): kanban over a scalar group property.
 * Column keys + counts come from one `run_base` (includeGroupCounts) over
 * the view's capped dataset; each column pages its own `run_base(group)`
 * slice (spec §3 — per-group pages cannot exceed the view limit).
 * Dragging a card commits the scalar group prop (`removes` for 그룹 없음);
 * List-valued group props disable drag while table grouping still works.
 *
 * Plan C: row identity is `BaseRow.row_id` (spec §4). Two task rows under
 * one parent stay distinct by row_id; drag state and selection key on
 * row_id, never on the parent memo id. When `groupBy.property === "task.status"`
 * a drop commits `SetStatus(column)` per dragged `row.task.task_ref`
 * through guarded `patch_task` (Task 6); any other group-by routes the
 * drop through `update_memo` or disables drag for view-only grouping
 * (`task.type`).
 */
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { baseProps, patchTask, runBase, updateMemo } from "../../lib/api";
import { todayLocalISO } from "../../lib/dates";
import { useI18n } from "../../lib/i18n";
import { propValueLabel } from "../../lib/propDisplay";
import { formatBaseValue } from "../../lib/tableModel";
import { dragCommitsStatus } from "../../lib/taskCellCommit";
import type { BasePage, BaseRow, BaseSource, BaseValue, PropMutation, RunBaseReq, TaskRef } from "../../lib/types";
import { useUI } from "../../stores/ui";
import { TaskCheckbox } from "../TaskCheckbox";

const COL_PAGE = 20;

interface Props {
  source: BaseSource;
  sourceKey: string;
  viewIndex: number;
  /** Wire form: `note.<key>` / `task.<key>` / `formula.<key>`. */
  groupByProp: string | null;
  preset?: string;
  onSelect: (id: string) => void;
}

/** Drag payload (spec §4). Carries the task_ref when the dragged row
 *  carries a task, so the drop handler can commit `SetStatus` per
 *  `row.task.task_ref` without re-resolving the row from per-column
 *  queries. */
interface DragPayload {
  rowId: string;
  taskRef: TaskRef | null;
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
  // True only when the groupBy is `task.status`: that's the one case
  // a drop commits a task edit through guarded `patch_task`. Anything
  // else (note.* / task.type / formula.*) keeps the scalar-prop path
  // or disables drag (view-only).
  const statusDrag = dragCommitsStatus(groupByProp);

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

  /** Drag state (spec §4): row_id + optional task_ref. */
  const [drag, setDrag] = useState<DragPayload | null>(null);

  /** Drop on a column with key `column` — three paths:
   *  1. status groupBy + task ref → `patch_task({ SetStatus: column })`
   *     per `row.task.task_ref`.
   *  2. status groupBy but row has no task → falls back to the note-prop
   *     path so a misplaced note drag still mutates the underlying note.
   *  3. note/formula groupBy → `updateMemo` with the scalar group prop
   *     (or `removes` for the "" group). */
  const onDropCard = (column: string) => {
    if (!drag) return;
    const { rowId, taskRef } = drag;
    setDrag(null);
    if (statusDrag && taskRef) {
      patchTask({ Exact: taskRef }, { SetStatus: column }, todayLocalISO())
        .then(() => qc.invalidateQueries({ queryKey: ["base"] }))
        .catch((e) => {
          const msg = String(e);
          if (msg.includes("task conflict")) setToast(t.task_conflict_reload);
          else setToast(msg.split("\n")[0] ?? msg);
          void qc.invalidateQueries({ queryKey: ["base"] });
        });
      return;
    }
    if (!groupKey) return;
    // Note-prop path: resolve the parent memo id from the row_id
    // prefix (`n:<memo_id>` / `t:<memo_id>:<line>`). Board columns
    // mutate the underlying note's scalar group prop; we don't carry
    // BaseRow.task for the group-by column under note grouping.
    const memoId = rowId.startsWith("n:") ? rowId.slice(2) : rowId;
    const colon = memoId.indexOf(":");
    const parentMemoId = colon === -1 ? memoId : memoId.slice(0, colon);
    const mutation: PropMutation =
      column === ""
        ? { sets: [], removes: [groupKey] }
        : { sets: [[groupKey, { Str: column }]], removes: [] };
    updateMemo(parentMemoId, null, null, mutation)
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
          groupByProp={groupByProp}
          groupIsList={groupIsList}
          statusDrag={statusDrag}
          drag={drag}
          setDrag={setDrag}
          onDrop={() => onDropCard(g)}
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
  groupByProp,
  groupIsList,
  statusDrag,
  drag,
  setDrag,
  onDrop,
  onSelect,
}: {
  source: BaseSource;
  sourceKey: string;
  viewIndex: number;
  column: string;
  count: number;
  preset?: string;
  groupByProp: string | null;
  groupIsList: boolean;
  statusDrag: boolean;
  drag: DragPayload | null;
  setDrag: (d: DragPayload | null) => void;
  onDrop: () => void;
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
  // Drag is only enabled when the grouping has a kernel surface:
  //   • `task.status` → status drop (task rows commit SetStatus; note
  //     rows fall through to note-prop).
  //   • `note.<scalar>` → note-prop drag (existing behavior).
  // Anything else (`task.type`, `formula.*`, `file.*`, list props)
  // disables drag and surfaces the `board_drag_disabled` tooltip.
  const dragSupported = statusDrag || (groupByProp?.startsWith("note.") ?? false);
  const draggable = dragSupported && !groupIsList;
  return (
    <div
      onDragOver={(e) => {
        if (!draggable) return;
        e.preventDefault();
        setDropOn(true);
      }}
      onDragLeave={() => setDropOn(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropOn(false);
        if (drag && draggable) onDrop();
        setDrag(null);
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
      {rows.map((r) => (
        <BoardCard
          key={r.row_id}
          row={r}
          draggable={draggable}
          onDragStart={() => setDrag({ rowId: r.row_id, taskRef: r.task?.task_ref ?? null })}
          onDragEnd={() => setDrag(null)}
          onSelect={onSelect}
          titleDisabled={!draggable}
          statusDrag={statusDrag}
        />
      ))}
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

/** One board card: note rows show title + formula cell snippet; task
 *  rows show `TaskCheckbox` + text + parent breadcrumb (spec §7.0).
 *  The checkbox click wires to `patch_task` Toggle (Task 6). */
function BoardCard({
  row,
  draggable,
  onDragStart,
  onDragEnd,
  onSelect,
  titleDisabled,
  statusDrag,
}: {
  row: BaseRow;
  draggable: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onSelect: (id: string) => void;
  titleDisabled: boolean;
  statusDrag: boolean;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const setToast = useUI((s) => s.setToast);
  const title = row.summary.title ?? row.summary.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  // The view doesn't carry a config-aware status table; send bare
  // `Toggle` so the kernel resolves the next symbol from its
  // effective status table (spec §5/§6).
  const onToggle = () => {
    if (!row.task) return;
    patchTask({ Exact: row.task.task_ref }, "Toggle", todayLocalISO())
      .then(() => qc.invalidateQueries({ queryKey: ["base"] }))
      .catch((e) => {
        const msg = String(e);
        if (msg.includes("task conflict")) setToast(t.task_conflict_reload);
        else setToast(msg.split("\n")[0] ?? msg);
        void qc.invalidateQueries({ queryKey: ["base"] });
      });
  };
  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(row.summary.id)}
      title={
        titleDisabled
          ? t.board_drag_disabled
          : !statusDrag && row.task
            ? t.board_task_only_status
            : undefined
      }
      className="rounded-[var(--tag-radius)] border border-line bg-surface px-2 py-1.5 text-left text-[12px] text-text shadow-sm transition-colors duration-150 hover:border-line-strong"
    >
      {row.task ? (
        <div className="flex items-center gap-1.5">
          <TaskCheckbox
            statusType={row.task.status_type}
            label={row.task.text}
            onToggle={onToggle}
          />
          <span className="block truncate font-medium">{row.task.text}</span>
        </div>
      ) : (
        <span className="block truncate font-medium">{title}</span>
      )}
      <span className="mt-0.5 block truncate text-[10px] text-text-subtle">
        {row.task
          ? `@ ${title}`
          : row.cells.slice(1, 3).map((c) => (c.error ? "⚠︎" : formatBaseValue(c.value as BaseValue | null))).join(" · ")}
      </span>
    </button>
  );
}