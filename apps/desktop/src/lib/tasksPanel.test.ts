/**
 * Pure tests for the sidebar TasksPanel model: 날짜 없음 · 예정 view
 * resolution by name. The lane slice is tested in nowLane.test.ts.
 */
import { describe, expect, test } from "bun:test";

import { noDateViewIndex, upcomingViewIndex } from "./tasksPanel";
import type { BaseDef } from "./types";

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

describe("upcomingViewIndex", () => {
  test("finds the 예정 tasks view by name, -1 when absent", () => {
    const def: BaseDef = {
      views: [
        { type: "tasks", name: "오늘" },
        { type: "table", name: "예정" },
        { type: "tasks", name: "예정" },
      ],
    };
    expect(upcomingViewIndex(def)).toBe(2);
    expect(upcomingViewIndex({ views: [{ type: "tasks", name: "오늘" }] })).toBe(-1);
  });
});
