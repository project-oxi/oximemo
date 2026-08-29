/**
 * Sidebar TasksPanel data model (tasks spec §7.4). Pure: bucket
 * partitioning and the 날짜 없음 view resolution — the component only
 * wires queries and renders.
 *
 * The panel reads TWO views of the installed `queries/할 일.query`:
 *  - 오늘 (index 0): overdue + due/scheduled-today, engine-filtered;
 *  - 날짜 없음: the undated backlog (seed v2), resolved BY NAME —
 *    quick-added tasks carry neither date, so without this view they
 *    would surface nowhere but 전체.
 */
import { taskBucket } from "./taskBucket";
import type { BaseDef, BaseRow, TaskDto } from "./types";

/** The seed-v2 view name. Must match the Rust `TASKS_NO_DATE_VIEW`. */
export const TASKS_NO_DATE_VIEW = "날짜 없음";

/** Index of the base's 날짜 없음 tasks view, or -1 when the base
 *  predates seed v2 or the user renamed the view. By name, never by
 *  fixed index: user-reordered/extended bases keep working, and a
 *  user view that merely SHARES the name (any type) does not satisfy
 *  the lookup. */
export function noDateViewIndex(def: BaseDef | null | undefined): number {
  const views = def?.views ?? [];
  return views.findIndex((view) => view.type === "tasks" && view.name === TASKS_NO_DATE_VIEW);
}

export interface PanelBuckets {
  overdue: BaseRow[];
  today: BaseRow[];
  noDate: BaseRow[];
}

/** Status types that count as still-open work (the views return ALL
 *  rows matching their filter; terminal ones hide in the sidebar). */
function isOpen(statusType: TaskDto["status_type"]): boolean {
  return statusType !== "DONE" && statusType !== "CANCELLED";
}

/** Partition base rows into the sidebar's three buckets, dropping
 *  terminal statuses and capping each bucket. `dated` rows come from
 *  the 오늘 view (its filter already excludes future work); `undated`
 *  from the 날짜 없음 view. Rows landing in the "wrong" input are
 *  skipped defensively — a view-filter drift must never surface as a
 *  mis-bucketed row. */
export function partitionPanelRows(
  dated: BaseRow[],
  undated: BaseRow[],
  todayISO: string,
  cap: number,
): PanelBuckets {
  const overdue: BaseRow[] = [];
  const today: BaseRow[] = [];
  const noDate: BaseRow[] = [];
  for (const row of dated) {
    const task = row.task;
    if (!task || !isOpen(task.status_type)) continue;
    const bucket = taskBucket(task, todayISO);
    if (bucket === "overdue") {
      if (overdue.length < cap) overdue.push(row);
    } else if (bucket === "today") {
      if (today.length < cap) today.push(row);
    }
  }
  for (const row of undated) {
    const task = row.task;
    if (!task || !isOpen(task.status_type)) continue;
    if (taskBucket(task, todayISO) === "no_date" && noDate.length < cap) noDate.push(row);
  }
  return { overdue, today, noDate };
}
