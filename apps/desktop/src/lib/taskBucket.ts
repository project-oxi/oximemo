/**
 * Default task grouping (tasks spec §7.4): 지연 / 오늘 / 내일 / 이번 주 /
 * 이후 / 날짜 없음, computed from `task.due` with `task.scheduled`
 * fallback. Pure — takes the two nullable dates plus a local ISO today
 * so callers can pin the key from `useTodayKey`.
 *
 * 이번 주 follows dates.ts's Sunday-first week convention (the sidebar
 * calendar grid): the current week ends on SATURDAY, so the next Sunday
 * already buckets as 이후.
 */
import { daysBetween } from "./dates";
import type { TaskDto } from "./types";

export type TaskBucket = "overdue" | "today" | "tomorrow" | "this_week" | "later" | "no_date";

/** Days from `todayISO` to the Saturday ending its Sunday-first week. */
function daysToWeekEnd(todayISO: string): number {
  const [y, m, d] = todayISO.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay(); // 0 = Sunday … 6 = Saturday
  return 6 - dow;
}

/** Bucket one task relative to `todayISO` (a local YYYY-MM-DD key):
 *  `due` with `scheduled` fallback, both optional. */
export function taskBucket(task: Pick<TaskDto, "due" | "scheduled">, todayISO: string): TaskBucket {
  const eff = task.due ?? task.scheduled;
  if (eff === null) return "no_date";
  const diff = daysBetween(eff, todayISO); // eff − today
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff <= daysToWeekEnd(todayISO)) return "this_week";
  return "later";
}
