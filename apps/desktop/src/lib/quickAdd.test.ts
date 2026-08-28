/**
 * Pure tests for the ⌘⇧T / `/할일` quick-add routing (Plan E Task 3,
 * spec §9): which target a quick add lands in, when the daily+recurring
 * anti-pattern warning fires, and how the typed single line splits into
 * task text + structured fields via the taskLine mirror.
 */
import { cfgFromJson, type WireTaskLineCfg } from "./taskLine";
import type { TaskFields } from "./types";
import { describe, expect, test } from "bun:test";

import {
  buildQuickAddTarget,
  overlaySlashRoute,
  parseQuickAddInput,
  quickAddTarget,
  shouldWarnDailyRecurrence,
} from "./quickAdd";

const BASE_WIRE: WireTaskLineCfg = {
  write_format: "emoji",
  global_filter: "",
  recurrence_insert: "above",
  statuses: [],
};
const CFG = cfgFromJson(BASE_WIRE);
const DATAVIEW_CFG = cfgFromJson({ ...BASE_WIRE, write_format: "dataview" });

const NO_FIELDS: TaskFields = {
  created: null,
  start: null,
  scheduled: null,
  due: null,
  priority: "None",
  recurrence: null,
  tags: [],
};

describe("quickAddTarget", () => {
  test("defaults to daily when the config is absent", () => {
    expect(quickAddTarget(null)).toBe("daily");
    expect(quickAddTarget(undefined)).toBe("daily");
    expect(quickAddTarget({})).toBe("daily");
  });

  test("follows the configured capture_target", () => {
    expect(quickAddTarget({ capture_target: "inbox" })).toBe("inbox");
    expect(quickAddTarget({ capture_target: "daily" })).toBe("daily");
  });

  test("an explicit override wins over the config", () => {
    expect(quickAddTarget({ capture_target: "inbox" }, "daily")).toBe("daily");
    expect(quickAddTarget({ capture_target: "daily" }, "inbox")).toBe("inbox");
    // null/undefined override falls through to the config.
    expect(quickAddTarget({ capture_target: "inbox" }, null)).toBe("inbox");
    expect(quickAddTarget({ capture_target: "inbox" }, undefined)).toBe("inbox");
  });
});

describe("buildQuickAddTarget", () => {
  test("daily mode targets the daily note for the given today", () => {
    expect(buildQuickAddTarget("daily", "2026-08-29")).toEqual({ Daily: "2026-08-29" });
  });

  test("inbox mode targets the fixed inbox note", () => {
    expect(buildQuickAddTarget("inbox", "2026-08-29")).toBe("Inbox");
  });
});

describe("shouldWarnDailyRecurrence", () => {
  const recurring: TaskFields = { ...NO_FIELDS, recurrence: "every week" };

  test("true only for a Daily target carrying a recurrence rule", () => {
    expect(shouldWarnDailyRecurrence({ Daily: "2026-08-29" }, recurring)).toBe(true);
  });

  test("false for a Daily target without a rule (null or blank)", () => {
    expect(shouldWarnDailyRecurrence({ Daily: "2026-08-29" }, NO_FIELDS)).toBe(false);
    expect(
      shouldWarnDailyRecurrence({ Daily: "2026-08-29" }, { ...NO_FIELDS, recurrence: "" }),
    ).toBe(false);
    expect(
      shouldWarnDailyRecurrence({ Daily: "2026-08-29" }, { ...NO_FIELDS, recurrence: "   " }),
    ).toBe(false);
  });

  test("false for non-Daily targets even with a rule", () => {
    expect(shouldWarnDailyRecurrence("Inbox", recurring)).toBe(false);
    expect(shouldWarnDailyRecurrence({ Note: "b3:abc" }, recurring)).toBe(false);
  });
});

describe("overlaySlashRoute", () => {
  test("strips a leading /할일 command and its following whitespace", () => {
    expect(overlaySlashRoute("/할일 물 마시기")).toEqual({ rest: "물 마시기" });
    expect(overlaySlashRoute("  /할일   물 마시기")).toEqual({ rest: "물 마시기" });
  });

  test("bare command routes with an empty rest (submit no-ops)", () => {
    expect(overlaySlashRoute("/할일")).toEqual({ rest: "" });
    expect(overlaySlashRoute("/할일   ")).toEqual({ rest: "" });
  });

  test("collapses newlines in the remainder into single spaces", () => {
    expect(overlaySlashRoute("/할일 첫 줄\n둘째 줄")).toEqual({ rest: "첫 줄 둘째 줄" });
  });

  test("a longer word starting with the command text does not route", () => {
    expect(overlaySlashRoute("/할일아님")).toBeNull();
  });

  test("bodies without the leading command do not route", () => {
    expect(overlaySlashRoute("할일 물 마시기")).toBeNull();
    expect(overlaySlashRoute("메모 /할일")).toBeNull();
    expect(overlaySlashRoute("")).toBeNull();
  });
});

describe("parseQuickAddInput", () => {
  test("plain text becomes the description with default fields", () => {
    const out = parseQuickAddInput("물 마시기", CFG);
    expect(out.text).toBe("물 마시기");
    expect(out.fields).toEqual(NO_FIELDS);
  });

  test("an emoji recurrence token splits into fields.recurrence", () => {
    const out = parseQuickAddInput("물 마시기 🔁 every day", CFG);
    expect(out.text).toBe("물 마시기");
    expect(out.fields.recurrence).toBe("every day");
    // The warning gate composes with the parsed fields.
    expect(shouldWarnDailyRecurrence({ Daily: "2026-08-29" }, out.fields)).toBe(true);
  });

  test("dataview [repeat:: …] tokens split too", () => {
    const out = parseQuickAddInput("회의 [repeat:: every week]", DATAVIEW_CFG);
    expect(out.text).toBe("회의");
    expect(out.fields.recurrence).toBe("every week");
  });

  test("dates, priority, and tags are carried into their fields", () => {
    const out = parseQuickAddInput("보고서 📅 2026-09-01 ⏫ #업무", CFG);
    expect(out.text).toBe("보고서");
    expect(out.fields.due).toBe("2026-09-01");
    expect(out.fields.priority).toBe("High");
    expect(out.fields.tags).toEqual(["업무"]);
    // created stays null: core auto-stamps today on add.
    expect(out.fields.created).toBeNull();
  });

  test("a full task line typed verbatim parses without the probe prefix", () => {
    const out = parseQuickAddInput("- [ ] 운동 🔁 every week", CFG);
    expect(out.text).toBe("운동");
    expect(out.fields.recurrence).toBe("every week");
  });

  test("multi-line input collapses to one line (task lines cannot hold \\n)", () => {
    const out = parseQuickAddInput("첫 줄\n둘째 줄", CFG);
    expect(out.text).toBe("첫 줄 둘째 줄");
  });

  test("empty input yields empty text with default fields", () => {
    expect(parseQuickAddInput("", CFG)).toEqual({ text: "", fields: NO_FIELDS });
    expect(parseQuickAddInput("   ", CFG)).toEqual({ text: "", fields: NO_FIELDS });
  });
});
