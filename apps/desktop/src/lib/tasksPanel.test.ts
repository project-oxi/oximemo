/**
 * Pure tests for the sidebar TasksPanel model: 날짜 없음 view
 * resolution by name, and the overdue/today/no-date row partitioning
 * with terminal-status drops and per-bucket caps.
 */
import { describe, expect, test } from "bun:test";

import { noDateViewIndex, partitionPanelRows } from "./tasksPanel";
import type { BaseDef, BaseRow, TaskDto } from "./types";

const TODAY = "2026-08-29";


function row(task: Partial<TaskDto>): BaseRow {
  return {
    row_id: `r${JSON.stringify(task)}`,
    summary: { path: "notes/a.md", title: "a" },
    task: {
      task_ref: { memo_id: "m1", line: 0, line_hash: "h" },
      symbol: "*",
      status_type: "TODO",
      text: "t",
      tags: [],
      section: null,
      created: null,
      start: null,
      scheduled: null,
      due: null,
      done: null,
      cancelled: null,
      priority: "none",
      recurrence: null,
      warnings: [],
      ...task,
    } as TaskDto,
  } as BaseRow;
}
describe("noDateViewIndex", () => {
  test("finds the 날짜 없음 tasks view wherever it sits", () => {
    const def: BaseDef = {
      views: [
        { type: "tasks", name: "오늘" },
        { type: "table", name: "테이블" },
        { type: "tasks", name: "날짜 없음" },
      ],
    };
    expect(noDateViewIndex(def)).toBe(2);
  });

  test("a user view sharing only the name does not satisfy the lookup", () => {
    const def: BaseDef = { views: [{ type: "table", name: "날짜 없음" }] };
    expect(noDateViewIndex(def)).toBe(-1);
  });

  test("absent / null defs resolve to -1 (pre-v2 base)", () => {
    expect(noDateViewIndex({ views: [{ type: "tasks", name: "오늘" }] })).toBe(-1);
    expect(noDateViewIndex(null)).toBe(-1);
    expect(noDateViewIndex(undefined)).toBe(-1);
  });
});

describe("partitionPanelRows", () => {
  test("buckets dated rows into overdue/today and undated rows into noDate", () => {
    const dated = [
      row({ text: "past", due: "2026-08-27" }),
      row({ text: "today", due: TODAY }),
      row({ text: "sched today", scheduled: TODAY }),
    ];
    const undated = [row({ text: "quick add" })];
    const out = partitionPanelRows(dated, undated, TODAY, 50);
    expect(out.overdue.map((r) => r.task!.text)).toEqual(["past"]);
    expect(out.today.map((r) => r.task!.text)).toEqual(["today", "sched today"]);
    expect(out.noDate.map((r) => r.task!.text)).toEqual(["quick add"]);
  });

  test("drops terminal statuses from both inputs", () => {
    const dated = [row({ text: "done", due: "2026-08-27", status_type: "DONE" })];
    const undated = [row({ text: "cancelled", status_type: "CANCELLED" })];
    const out = partitionPanelRows(dated, undated, TODAY, 50);
    expect(out.overdue).toHaveLength(0);
    expect(out.noDate).toHaveLength(0);
  });

  test("rows landing in the wrong input are skipped defensively", () => {
    // a future-dated row in the dated input (view filter drift)
    // and a dated row in the undated input must not surface.
    const dated = [row({ text: "future", due: "2026-09-15" })];
    const undated = [row({ text: "overdue leaking", due: "2026-08-01" })];
    const out = partitionPanelRows(dated, undated, TODAY, 50);
    expect(out.overdue).toHaveLength(0);
    expect(out.today).toHaveLength(0);
    expect(out.noDate).toHaveLength(0);
  });

  test("each bucket is capped independently", () => {
    const dated = [
      row({ text: "o1", due: "2026-08-01" }),
      row({ text: "t1", due: TODAY }),
    ];
    const undated = [row({ text: "n1" }), row({ text: "n2" })];
    const out = partitionPanelRows(dated, undated, TODAY, 1);
    expect(out.overdue).toHaveLength(1);
    expect(out.today).toHaveLength(1);
    expect(out.noDate.map((r) => r.task!.text)).toEqual(["n1"]);
  });
});
