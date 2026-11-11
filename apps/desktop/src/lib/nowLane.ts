/**
 * NowLane 날짜 계산 (2026-11-11 · 할 일 「지금 선 레인」).
 *
 * 할 일 목록은 묶음 머리 여섯 개(지남/오늘/내일/이번 주/나중/날짜 없음) 대신
 * 「지금 선」 하나를 두고 위아래에 놓는다. 앱 색이 무채색이라 「지남」 색 칩은
 * 「오늘」과 거의 구분되지 않았다 — 그래서 늦은 정도는 막대 칸 수, 남은 날은
 * 행 사이 간격으로 말한다. 여기는 그 계산만 둔다(순수 함수 · 화면은 그리기만).
 *
 * 날짜 기준은 예전 묶음과 같다: `due`, 없으면 `scheduled`.
 * DateAxis(할 일 편집 팝오버의 날짜 한 축) 계산도 함께 둔다 — 같은 날짜 셈이다.
 */
import { daysBetween, shiftISODate } from "./dates";
import type { TaskDto } from "./types";

type LaneTask = Pick<TaskDto, "due" | "scheduled" | "priority" | "status_type">;

/** 레인 위치를 정하는 날짜: `due`, 없으면 `scheduled`. 둘 다 없으면 null. */
export function effectiveDate(task: Pick<TaskDto, "due" | "scheduled">): string | null {
  return task.due ?? task.scheduled;
}

/** 늦음 막대 최대 칸 수. 석 달 늦은 것과 반년 늦은 것을 더 나눠 봐야 판단이 바뀌지 않는다. */
export const LATENESS_MAX_STEPS = 8;

/** 늦은 날수 → 막대 칸 수 (로그 2 · 1일 = 1칸, 2~3일 = 2칸, 4~7일 = 3칸 … 최대 8칸).
 *  선형이면 사흘과 석 달이 한 줄에 같이 못 들어간다 — 로그라야 둘 다 읽힌다. */
export function latenessSteps(daysLate: number): number {
  if (daysLate <= 0) return 0;
  return Math.min(LATENESS_MAX_STEPS, 1 + Math.floor(Math.log2(daysLate)));
}

/** 행 사이 간격 상한(px). 이보다 벌어지면 화면이 비어 보여 「다음 일」이 화면 밖으로 밀린다. */
export const LANE_GAP_MAX = 28;

/** 앞 행과 이 행의 날짜 차(일) → 위 여백(px). 같은 날은 0, 하루 6px, 이후 로그로 눌러 상한에서 멈춘다.
 *  색 없이 「얼마나 먼가」를 눈으로 읽게 하는 유일한 단서라 0 과 1 일은 분명히 달라야 한다. */
export function laneGap(deltaDays: number): number {
  if (deltaDays <= 0) return 0;
  return Math.min(LANE_GAP_MAX, Math.round(6 * (1 + Math.log2(deltaDays))));
}

/** 같은 날 안에서는 우선순위 순(높음 먼저). `none` 은 medium 과 low 사이 — Tasks 플러그인 규칙과 같다. */
const PRIORITY_RANK: Record<TaskDto["priority"], number> = {
  highest: 0,
  high: 1,
  medium: 2,
  none: 3,
  low: 4,
  lowest: 5,
};

function isOpen(statusType: TaskDto["status_type"]): boolean {
  return statusType !== "DONE" && statusType !== "CANCELLED";
}

export interface LaneEntry<R> {
  row: R;
  /** 날짜 − 오늘 (일). 음수 = 지남. */
  diff: number;
  /** 지금 선 아래 행의 위 여백(px). 위 행은 0 — 늦음은 막대가 말한다. */
  gap: number;
  /** 늦음 막대 칸 수. 끝난 일(완료 · 취소)은 0 — 다 한 일을 「늦었다」고 말하지 않는다. */
  steps: number;
  /** 바로 위 행과 같은 날인가 — 같은 날짜 글자를 줄마다 되풀이하지 않으려고. */
  sameDayAsPrev: boolean;
}

export interface Lane<R> {
  /** 지금 선 위: 가장 늦은 것이 맨 위. */
  overdue: LaneEntry<R>[];
  /** 지금 선 아래: 오늘부터 가까운 순. */
  upcoming: LaneEntry<R>[];
  /** 날짜 없음 — 접힌 한 줄로 맨 아래. 받은 순서 그대로. */
  undated: R[];
}

/** 행들을 레인으로 편다. 날짜 → 우선순위 → 받은 순서(쿼리 정렬)로 정렬해 같은 값끼리 자리가 흔들리지 않게 한다. */
export function buildLane<R extends { task?: LaneTask | null }>(rows: readonly R[], todayISO: string): Lane<R> {
  const dated: { row: R; diff: number; rank: number; index: number }[] = [];
  const undated: R[] = [];
  rows.forEach((row, index) => {
    const task = row.task;
    if (!task) return;
    const eff = effectiveDate(task);
    if (eff === null) {
      undated.push(row);
      return;
    }
    dated.push({ row, diff: daysBetween(eff, todayISO), rank: PRIORITY_RANK[task.priority] ?? 3, index });
  });
  dated.sort((a, b) => a.diff - b.diff || a.rank - b.rank || a.index - b.index);

  const overdue: LaneEntry<R>[] = [];
  const upcoming: LaneEntry<R>[] = [];
  let prevDiff: number | null = null;
  for (const d of dated) {
    const sameDayAsPrev = prevDiff === d.diff;
    if (d.diff < 0) {
      const open = isOpen(d.row.task!.status_type);
      overdue.push({ row: d.row, diff: d.diff, gap: 0, steps: open ? latenessSteps(-d.diff) : 0, sameDayAsPrev });
    } else {
      // 선 바로 아래 첫 행은 오늘(0)에서 잰다 — 내일 일이 선에 붙어 「오늘」처럼 보이지 않게.
      const from: number = prevDiff !== null && prevDiff >= 0 ? prevDiff : 0;
      upcoming.push({ row: d.row, diff: d.diff, gap: laneGap(d.diff - from), steps: 0, sameDayAsPrev });
    }
    prevDiff = d.diff;
  }
  return { overdue, upcoming, undated };
}

/** 사이드바 조각 기본값: 지난 것은 위에서 3개만, 선 아래는 오늘 · 내일까지. */
export const PANEL_OVERDUE_TOP = 3;
export const PANEL_HORIZON_DAYS = 1;

export interface PanelSlice<R> {
  /** 가장 늦은 것부터 `overdueTop` 개. */
  overdueTop: LaneEntry<R>[];
  /** 나머지 지난 것 — 펼치면 보인다. */
  overdueRest: LaneEntry<R>[];
  /** 오늘 ~ `horizon` 일 뒤. */
  upcoming: LaneEntry<R>[];
  undated: R[];
}

/** 사이드바용 조각 (2026-11-11 · 지금 ±2일 화면). 끝난 일은 빼고, 같은 행이 두 쿼리에서 오면 하나만 남긴다. */
export function panelSlice<R extends { row_id: string; task?: LaneTask | null }>(
  rows: readonly R[],
  todayISO: string,
  overdueTop: number = PANEL_OVERDUE_TOP,
  horizon: number = PANEL_HORIZON_DAYS,
): PanelSlice<R> {
  const seen = new Set<string>();
  const open: R[] = [];
  for (const row of rows) {
    if (!row.task || !isOpen(row.task.status_type) || seen.has(row.row_id)) continue;
    seen.add(row.row_id);
    open.push(row);
  }
  const lane = buildLane(open, todayISO);
  return {
    overdueTop: lane.overdue.slice(0, overdueTop),
    overdueRest: lane.overdue.slice(overdueTop),
    upcoming: lane.upcoming.filter((e) => e.diff <= horizon),
    undated: lane.undated,
  };
}

/* ---- DateAxis (편집 팝오버의 날짜 한 축) ---------------------------------- */

export type AxisField = "start" | "scheduled" | "due";

export interface AxisDates {
  start: string | null;
  scheduled: string | null;
  due: string | null;
}

export interface AxisRange {
  /** 축 왼쪽 끝 날짜. */
  from: string;
  /** 축 길이(일) — 오른쪽 끝 = from + span. */
  span: number;
}

/** 축이 너무 짧으면 하루 차이가 손잡이 폭보다 넓어져 끌기가 튄다 — 2주는 보이게 한다. */
const AXIS_MIN_SPAN = 14;

/** 날짜들과 오늘이 모두 들어가게 축 범위를 맞춘다. 양 끝에 길이의 15% (최소 2일) 여백을 둔다. */
export function axisRange(dates: AxisDates, todayISO: string): AxisRange {
  const all = [dates.start, dates.scheduled, dates.due, todayISO].filter((d): d is string => d !== null);
  let lo = 0;
  let hi = 0;
  for (const d of all) {
    const diff = daysBetween(d, todayISO);
    lo = Math.min(lo, diff);
    hi = Math.max(hi, diff);
  }
  const pad = Math.max(2, Math.round((hi - lo) * 0.15));
  lo -= pad;
  hi += pad;
  if (hi - lo < AXIS_MIN_SPAN) {
    // 모자란 길이는 앞날 쪽에 더한다 — 할 일은 대개 앞으로 잡는다.
    hi = lo + AXIS_MIN_SPAN;
  }
  return { from: shiftISODate(todayISO, lo), span: hi - lo };
}

/** 날짜 → 축 위 비율(0~1). */
export function axisPosition(iso: string, range: AxisRange): number {
  return Math.min(1, Math.max(0, daysBetween(iso, range.from) / range.span));
}

/** 축 위 비율(0~1) → 가장 가까운 날짜. 끌기는 하루 단위로만 움직인다. */
export function axisDateAt(ratio: number, range: AxisRange): string {
  const clamped = Math.min(1, Math.max(0, ratio));
  return shiftISODate(range.from, Math.round(clamped * range.span));
}

/** 앞뒤가 어긋난 쌍 — 시작 ≤ 예정 ≤ 기한이어야 한다. 화면은 이것으로 겹침 표시와 짧은 글을 그린다. */
export function axisOrderIssues(dates: AxisDates): [AxisField, AxisField][] {
  const issues: [AxisField, AxisField][] = [];
  const pairs: [AxisField, AxisField][] = [["start", "due"], ["start", "scheduled"], ["scheduled", "due"]];
  for (const [a, b] of pairs) {
    const va = dates[a];
    const vb = dates[b];
    if (va !== null && vb !== null && daysBetween(vb, va) < 0) issues.push([a, b]);
  }
  return issues;
}

/** 빠진 날짜를 더할 때 놓을 자리: 오늘을 기본으로, 이미 있는 날짜와 앞뒤가 어긋나지 않게 당기거나 민다. */
export function defaultDateFor(field: AxisField, dates: AxisDates, todayISO: string): string {
  const min = (a: string, b: string) => (daysBetween(a, b) <= 0 ? a : b);
  const max = (a: string, b: string) => (daysBetween(a, b) >= 0 ? a : b);
  let d = todayISO;
  if (field === "start") {
    const later = dates.scheduled ?? dates.due;
    if (later) d = min(d, later);
  } else if (field === "scheduled") {
    if (dates.start) d = max(d, dates.start);
    if (dates.due) d = min(d, dates.due);
  } else {
    if (dates.start) d = max(d, dates.start);
    if (dates.scheduled) d = max(d, dates.scheduled);
  }
  return d;
}
