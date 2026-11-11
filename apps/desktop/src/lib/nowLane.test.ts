/** NowLane · DateAxis 날짜 계산 — 늦음 막대 칸 · 행 간격 · 정렬 · 사이드바 조각 · 축 범위. */
import { describe, expect, test } from "bun:test";

import {
  axisDateAt,
  axisOrderIssues,
  axisPosition,
  axisRange,
  buildLane,
  defaultDateFor,
  LANE_GAP_MAX,
  laneGap,
  latenessSteps,
  panelSlice,
} from "./nowLane";
import type { TaskDto } from "./types";

const TODAY = "2026-11-11";

type Row = { row_id: string; task: Pick<TaskDto, "due" | "scheduled" | "priority" | "status_type"> & { text: string } };

function row(text: string, task: Partial<Row["task"]> = {}): Row {
  return {
    row_id: text,
    task: { text, due: null, scheduled: null, priority: "none", status_type: "TODO", ...task },
  };
}

describe("latenessSteps", () => {
  test("log2 steps, capped at 8", () => {
    expect(latenessSteps(0)).toBe(0);
    expect(latenessSteps(1)).toBe(1);
    expect(latenessSteps(2)).toBe(2);
    expect(latenessSteps(3)).toBe(2);
    expect(latenessSteps(4)).toBe(3);
    expect(latenessSteps(12)).toBe(4);
    expect(latenessSteps(90)).toBe(7);
    expect(latenessSteps(128)).toBe(8);
    expect(latenessSteps(5000)).toBe(8);
  });
});

describe("laneGap", () => {
  test("same day is flush, grows with distance, capped", () => {
    expect(laneGap(0)).toBe(0);
    expect(laneGap(1)).toBe(6);
    expect(laneGap(2)).toBeGreaterThan(laneGap(1));
    expect(laneGap(7)).toBeGreaterThan(laneGap(2));
    expect(laneGap(400)).toBe(LANE_GAP_MAX);
  });
});

describe("buildLane", () => {
  test("overdue most-late first, upcoming nearest first, undated last", () => {
    const lane = buildLane(
      [
        row("later", { due: "2026-12-02" }),
        row("late3", { due: "2026-11-08" }),
        row("none"),
        row("today", { scheduled: TODAY }),
        row("late12", { due: "2026-10-30" }),
        row("fri", { due: "2026-11-13" }),
      ],
      TODAY,
    );
    expect(lane.overdue.map((e) => e.row.row_id)).toEqual(["late12", "late3"]);
    expect(lane.overdue.map((e) => e.steps)).toEqual([4, 2]);
    expect(lane.upcoming.map((e) => e.row.row_id)).toEqual(["today", "fri", "later"]);
    expect(lane.upcoming.map((e) => e.gap)).toEqual([0, laneGap(2), laneGap(19)]);
    expect(lane.undated.map((r) => r.row_id)).toEqual(["none"]);
  });

  test("due wins over scheduled for the position", () => {
    const lane = buildLane([row("a", { due: "2026-11-12", scheduled: "2026-11-01" })], TODAY);
    expect(lane.overdue).toHaveLength(0);
    expect(lane.upcoming[0]!.diff).toBe(1);
  });

  test("same day sorts by priority, then input order; repeats are flagged", () => {
    const lane = buildLane(
      [
        row("low", { due: TODAY, priority: "low" }),
        row("none1", { due: TODAY }),
        row("high", { due: TODAY, priority: "high" }),
        row("none2", { due: TODAY }),
      ],
      TODAY,
    );
    expect(lane.upcoming.map((e) => e.row.row_id)).toEqual(["high", "none1", "none2", "low"]);
    expect(lane.upcoming.map((e) => e.sameDayAsPrev)).toEqual([false, true, true, true]);
  });

  test("finished tasks keep their place but carry no lateness bar", () => {
    const lane = buildLane([row("done", { due: "2026-11-01", status_type: "DONE" })], TODAY);
    expect(lane.overdue[0]!.steps).toBe(0);
  });
});

describe("panelSlice", () => {
  test("top overdue + rest, today/tomorrow only, open only, de-duplicated", () => {
    const rows = [
      row("o1", { due: "2026-11-01" }),
      row("o2", { due: "2026-11-02" }),
      row("o3", { due: "2026-11-03" }),
      row("o4", { due: "2026-11-04" }),
      row("t", { due: TODAY }),
      row("t", { due: TODAY }),
      row("tm", { due: "2026-11-12" }),
      row("far", { due: "2026-11-13" }),
      row("done", { due: TODAY, status_type: "DONE" }),
      row("nd"),
    ];
    const s = panelSlice(rows, TODAY);
    expect(s.overdueTop.map((e) => e.row.row_id)).toEqual(["o1", "o2", "o3"]);
    expect(s.overdueRest.map((e) => e.row.row_id)).toEqual(["o4"]);
    expect(s.upcoming.map((e) => e.row.row_id)).toEqual(["t", "tm"]);
    expect(s.undated.map((r) => r.row_id)).toEqual(["nd"]);
  });
});

describe("DateAxis math", () => {
  test("range covers dates and today with padding, at least 14 days", () => {
    const r = axisRange({ start: null, scheduled: null, due: null }, TODAY);
    expect(r.span).toBe(14);
    expect(axisPosition(TODAY, r)).toBeGreaterThan(0);
    const wide = axisRange({ start: "2026-10-01", scheduled: null, due: "2026-12-31" }, TODAY);
    expect(axisPosition("2026-10-01", wide)).toBeGreaterThan(0);
    expect(axisPosition("2026-12-31", wide)).toBeLessThan(1);
  });

  test("ratio maps back to whole days", () => {
    const r = { from: "2026-11-01", span: 20 };
    expect(axisDateAt(0, r)).toBe("2026-11-01");
    expect(axisDateAt(0.5, r)).toBe("2026-11-11");
    expect(axisDateAt(2, r)).toBe("2026-11-21");
    expect(axisPosition("2026-11-11", r)).toBe(0.5);
  });

  test("order issues", () => {
    expect(axisOrderIssues({ start: "2026-11-01", scheduled: "2026-11-05", due: "2026-11-09" })).toEqual([]);
    expect(axisOrderIssues({ start: "2026-11-10", scheduled: null, due: "2026-11-09" })).toEqual([["start", "due"]]);
    expect(axisOrderIssues({ start: null, scheduled: "2026-11-10", due: "2026-11-09" })).toEqual([["scheduled", "due"]]);
  });

  test("a new date defaults to today but keeps the order", () => {
    const none = { start: null, scheduled: null, due: null };
    expect(defaultDateFor("due", none, TODAY)).toBe(TODAY);
    expect(defaultDateFor("start", { ...none, due: "2026-11-05" }, TODAY)).toBe("2026-11-05");
    expect(defaultDateFor("due", { ...none, start: "2026-11-20" }, TODAY)).toBe("2026-11-20");
    expect(defaultDateFor("scheduled", { ...none, due: "2026-11-09" }, TODAY)).toBe("2026-11-09");
  });
});
