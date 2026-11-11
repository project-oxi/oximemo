/**
 * Sidebar TasksPanel data model (tasks spec §7.4). Pure: the by-name
 * view resolution — the component only wires queries and renders.
 *
 * The panel reads THREE views of the installed `queries/할 일.query`:
 *  - 오늘 (index 0): overdue + due/scheduled-today, engine-filtered;
 *  - 날짜 없음: the undated backlog (seed v2), resolved BY NAME —
 *    quick-added tasks carry neither date, so without this view they
 *    would surface nowhere but 전체.
 *  - 예정 (2026-11-11): the future window, resolved BY NAME — the
 *    sidebar NowLane slice shows today AND tomorrow below the now
 *    rule, and 오늘 alone stops at today.
 *
 * Lane layout (overdue top-N · today/tomorrow · undated) is
 * `panelSlice` in nowLane.ts.
 */
import type { BaseDef } from "./types";

/** The seed-v2 view name. Must match the Rust `TASKS_NO_DATE_VIEW`. */
export const TASKS_NO_DATE_VIEW = "날짜 없음";

/** Vault-relative path of the installed `할 일` base — must match the
 *  Rust `TASKS_BASE_REL` seed (vault.rs). A protected system surface:
 *  core refuses trash/rename on it, and the generic query lists
 *  (sidebar QUERIES, palette 쿼리 열기) exclude it — the dedicated
 *  sidebar row + TasksPanel are its only surfaces. */
export const TASKS_BASE_PATH = "queries/할 일.query";

/** Index of the base's 날짜 없음 tasks view, or -1 when the base
 *  predates seed v2 or the user renamed the view. By name, never by
 *  fixed index: user-reordered/extended bases keep working, and a
 *  user view that merely SHARES the name (any type) does not satisfy
 *  the lookup. */
export function noDateViewIndex(def: BaseDef | null | undefined): number {
  return tasksViewIndex(def, TASKS_NO_DATE_VIEW);
}

/** The seed 예정 view name. Must match the Rust `TASKS_BASE_MD` seed. */
export const TASKS_UPCOMING_VIEW = "예정";

/** Index of the base's 예정 tasks view (same by-name rule), or -1. */
export function upcomingViewIndex(def: BaseDef | null | undefined): number {
  return tasksViewIndex(def, TASKS_UPCOMING_VIEW);
}

function tasksViewIndex(def: BaseDef | null | undefined, name: string): number {
  const views = def?.views ?? [];
  return views.findIndex((view) => view.type === "tasks" && view.name === name);
}
