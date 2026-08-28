import { describe, expect, test } from "bun:test";
import * as lucide from "lucide-react";

import { statusMark } from "../components/TaskCheckbox";
import { TASK_FIELD_ICONS, type TaskIconField } from "./taskIcons";

/** Spec §7.0 icon table — field → lucide export name in the pinned catalog. */
const SPEC_TABLE: Record<TaskIconField, string> = {
  created: "CalendarPlus",
  start: "Play",
  scheduled: "CalendarClock",
  due: "CalendarDays",
  done: "CalendarCheck",
  cancelled: "CalendarX",
  recurrence: "Repeat",
  "priority-highest": "ChevronsUp",
  "priority-high": "ChevronUp",
  "priority-medium": "Equal",
  "priority-low": "ChevronDown",
  "priority-lowest": "ChevronsDown",
  "invalid-date": "TriangleAlert",
  "unsupported-recurrence": "CircleAlert",
};

const appCss = await Bun.file(`${import.meta.dir}/../app.css`).text();

describe("TASK_FIELD_ICONS", () => {
  test("covers exactly the spec §7.0 catalog", () => {
    expect(Object.keys(TASK_FIELD_ICONS).sort()).toEqual(Object.keys(SPEC_TABLE).sort());
  });

  test("every row is the lucide-react component named by the spec table", () => {
    const lucideExports = new Set(Object.values(lucide));
    for (const field of Object.keys(SPEC_TABLE) as TaskIconField[]) {
      const def = TASK_FIELD_ICONS[field];
      expect(def.lucide.displayName).toBe(SPEC_TABLE[field]);
      expect(lucideExports.has(def.lucide)).toBe(true);
    }
  });

  test("every row has a mask-image rule in app.css (CM6 render path)", () => {
    for (const def of Object.values(TASK_FIELD_ICONS)) {
      const rule = new RegExp(
        `\\.${def.maskClass}\\s*\\{[^}]*mask-image\\s*:\\s*url\\("data:image/svg\\+xml`,
        "u",
      );
      expect(rule.test(appCss), def.maskClass).toBe(true);
    }
  });
});

describe("statusMark", () => {
  test("check for DONE, minus for CANCELLED, half for IN_PROGRESS, none otherwise", () => {
    expect(statusMark("DONE")).toBe("check");
    expect(statusMark("CANCELLED")).toBe("minus");
    expect(statusMark("IN_PROGRESS")).toBe("half");
    expect(statusMark("TODO")).toBeNull();
    expect(statusMark("ON_HOLD")).toBeNull();
    expect(statusMark("NON_TASK")).toBeNull();
  });
});
