/** taskBucket boundaries (tasks spec §7.4): the six default groups are
 *  computed from `due` with `scheduled` fallback against a local ISO
 *  today. 이번 주 follows dates.ts's Sunday-first week convention —
 *  the week ENDS on Saturday, so next Sunday is already 이후. */
import { describe, expect, test } from "bun:test";

import { taskBucket } from "./taskBucket";

/** 2026-08-27 is a Thursday; its Sunday-first week runs
 *  2026-08-23 .. 2026-08-29 (Saturday). */
const THU = "2026-08-27";
/** 2026-08-29 is the Saturday ending that week. */
const SAT = "2026-08-29";
/** 2026-08-30 is the Sunday starting the NEXT week. */
const NEXT_SUN = "2026-08-30";

const t = (due: string | null, scheduled: string | null) => taskBucket({ due, scheduled }, THU);

describe("taskBucket", () => {
  test("overdue: anything before today (due or scheduled-only)", () => {
    expect(t("2026-08-26", null)).toBe("overdue");
    expect(t("2026-01-01", null)).toBe("overdue");
    expect(t(null, "2026-08-20")).toBe("overdue");
  });

  test("today: due == today", () => {
    expect(t(THU, null)).toBe("today");
    expect(t(null, THU)).toBe("today");
  });

  test("tomorrow: exactly today + 1", () => {
    expect(t("2026-08-28", null)).toBe("tomorrow");
  });

  test("this_week: after tomorrow through the Saturday ending the Sunday-first week", () => {
    expect(t("2026-08-28", null)).not.toBe("this_week"); // tomorrow, not this_week
    expect(t(SAT, null)).toBe("this_week");
    expect(t(null, SAT)).toBe("this_week");
  });

  test("later: from the next Sunday onward", () => {
    expect(t(NEXT_SUN, null)).toBe("later");
    expect(t("2026-09-15", null)).toBe("later");
    expect(t("2027-01-02", null)).toBe("later");
  });

  test("no_date: both due and scheduled null", () => {
    expect(t(null, null)).toBe("no_date");
  });

  test("due wins over scheduled when both present", () => {
    // Overdue scheduled but a future due date: the due date buckets it.
    expect(t("2026-08-28", "2026-08-20")).toBe("tomorrow");
    // And the reverse: an overdue due wins over a future scheduled.
    expect(t("2026-08-26", SAT)).toBe("overdue");
  });

  test("week-boundary edge: on Saturday, the day after tomorrow is already later", () => {
    // Today = Saturday 2026-08-29: tomorrow is Sunday 2026-08-30
    // (still `tomorrow`), and Monday 2026-08-31 falls past the week end.
    expect(taskBucket({ due: "2026-08-30", scheduled: null }, SAT)).toBe("tomorrow");
    expect(taskBucket({ due: "2026-08-31", scheduled: null }, SAT)).toBe("later");
  });
});
