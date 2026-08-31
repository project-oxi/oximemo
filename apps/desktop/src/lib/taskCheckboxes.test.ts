import { describe, test, expect } from "bun:test";

import { cfgFromJson, type WireTaskLineCfg } from "./taskLine";
import { lineIsTask, TaskLineWidget, widgetRangesFor } from "./taskCheckboxes";

const BASE_WIRE: WireTaskLineCfg = {
  global_filter: "",
  recurrence_insert: "above",
  statuses: [],
};
const CFG = cfgFromJson(BASE_WIRE);

describe("lineIsTask", () => {
  test("recognizes bullet, numbered, indented, and marked prefixes", () => {
    expect(lineIsTask("- [ ] alpha", CFG)).toBe(true);
    expect(lineIsTask("* [x] alpha", CFG)).toBe(true);
    expect(lineIsTask("  - [/] indented", CFG)).toBe(true);
    expect(lineIsTask("1. [-] numbered", CFG)).toBe(true);
    expect(lineIsTask("- [X] uppercase X", CFG)).toBe(true);
  });

  test("rejects plain prose, bare lists, and broken brackets", () => {
    expect(lineIsTask("just words", CFG)).toBe(false);
    expect(lineIsTask("- not a task", CFG)).toBe(false);
    expect(lineIsTask("- [] no symbol", CFG)).toBe(false);
    expect(lineIsTask("- [ ]", CFG)).toBe(true); // bare checkbox, empty body
    expect(lineIsTask("", CFG)).toBe(false);
  });

  test("global filter gates recognition exactly like the kernel's parse_tasks", () => {
    const filtered = cfgFromJson({ ...BASE_WIRE, global_filter: "#task" });
    expect(lineIsTask("- [ ] real #task", filtered)).toBe(true);
    expect(lineIsTask("- [ ] no token", filtered)).toBe(false);
    // No filter configured: every checkbox line qualifies.
    expect(lineIsTask("- [ ] no token", CFG)).toBe(true);
  });

  test("configured symbol extends the builtin table", () => {
    const cfg = cfgFromJson({
      ...BASE_WIRE,
      statuses: [{ symbol: "D", type: "DONE", next: " " }],
    });
    expect(lineIsTask("- [D] configured", cfg)).toBe(true);
    expect(lineIsTask("- [D] configured", CFG)).toBe(true); // unknown → TODO fallback
  });
});

describe("widgetRangesFor", () => {
  test("decorates task lines with whole-line offsets and parsed spans", () => {
    const raw2 = "- [x] beta 📅 2026-08-30 #tag";
    const doc = `- [ ] alpha\nplain line\n${raw2}\n`;
    const ranges = widgetRangesFor(doc, doc.length, CFG);
    expect(ranges.map((r) => r.line)).toEqual([0, 2]);
    // Line 0 ("- [ ] alpha", 11 chars) starts at 0; line 1 ("plain
    // line", 10 chars) starts at 12; line 2 starts at 23.
    expect(ranges[0]).toMatchObject({ from: 0, to: 11, revealed: false });
    expect(ranges[1]).toMatchObject({ from: 23, to: 23 + raw2.length, revealed: false });
    expect(ranges[0]!.parsed.symbol).toBe(" ");
    expect(ranges[0]!.parsed.statusType).toBe("TODO");
    expect(ranges[1]!.parsed.symbol).toBe("x");
    expect(ranges[1]!.parsed.statusType).toBe("DONE");
    // Token spans for the widget's chips: the due emoji token with
    // exact UTF-16 offsets (📅 is a surrogate pair — 2 units).
    const dueStart = raw2.indexOf("📅");
    expect(ranges[1]!.parsed.spans.fields).toEqual([
      { field: "due", start: dueStart, end: dueStart + "📅 2026-08-30".length },
    ]);
    const [span] = ranges[1]!.parsed.spans.fields;
    expect(raw2.slice(span!.start, span!.end)).toBe("📅 2026-08-30");
  });

  test("caret inside a decorated line reveals it; neighbours stay decorated", () => {
    const doc = "- [ ] one\n- [x] two\n";
    // Caret at offset 7 (inside line 0, "- [ ] one" = 9 chars) →
    // line 0 revealed, line 1 not.
    expect(widgetRangesFor(doc, 7, CFG).map((r) => [r.line, r.revealed])).toEqual([
      [0, true],
      [1, false],
    ]);
    // Caret exactly at end-of-line 0 (offset 9, the "\n" position)
    // still counts as on-line; start of line 1 (offset 10) reveals
    // only line 1.
    expect(widgetRangesFor(doc, 9, CFG).map((r) => [r.line, r.revealed])).toEqual([
      [0, true],
      [1, false],
    ]);
    expect(widgetRangesFor(doc, 10, CFG).map((r) => [r.line, r.revealed])).toEqual([
      [0, false],
      [1, true],
    ]);
    // A selection head past the doc end (defensive) reveals nothing.
    expect(widgetRangesFor(doc, 999, CFG).every((r) => !r.revealed)).toBe(true);
  });

  test("task syntax inside fenced code is code, not a task", () => {
    const doc = "```\n- [ ] inside fence\n- [x] also inside\n```\n- [ ] outside\n";
    const ranges = widgetRangesFor(doc, 0, CFG);
    expect(ranges.map((r) => r.line)).toEqual([4]);
    // Caret at doc start sits on the fence opener — the decorated
    // outside line (from 45) is not under the caret.
    expect(ranges[0]).toMatchObject({ from: 45, revealed: false });

    const tilde = "~~~\n- [ ] tilded\n~~~\n- [ ] after\n";
    expect(widgetRangesFor(tilde, tilde.length, CFG).map((r) => r.line)).toEqual([3]);
  });

  test("CRLF documents: lines keep their trailing \\r and offsets stay exact", () => {
    const doc = "- [ ] a\r\n- [x] b\r\n";
    const ranges = widgetRangesFor(doc, 999, CFG);
    expect(ranges.map((r) => r.line)).toEqual([0, 1]);
    // Line 0 is "- [ ] a\r" (8 chars) — the \r is line content, and line 1
    // starts one past the "\n" separator.
    expect(ranges[0]).toMatchObject({ from: 0, to: 8 });
    expect(ranges[1]).toMatchObject({ from: 9, to: 17 });
    expect(ranges[0]!.parsed.statusType).toBe("TODO");
    expect(ranges[1]!.parsed.statusType).toBe("DONE");
    // Caret between "\r" and "\n" (offset 8) is still on line 0.
    expect(widgetRangesFor(doc, 8, CFG)[0]!.revealed).toBe(true);
    expect(widgetRangesFor(doc, 8, CFG)[1]!.revealed).toBe(false);
  });

  test("configured symbols and global filter flow through recognition", () => {
    const cfg = cfgFromJson({
      ...BASE_WIRE,
      global_filter: "#task",
      statuses: [{ symbol: "D", type: "DONE", next: " " }],
    });
    const doc = "- [D] done #task\n- [ ] filtered out\n";
    const ranges = widgetRangesFor(doc, doc.length, cfg);
    expect(ranges.map((r) => r.line)).toEqual([0]);
    expect(ranges[0]!.parsed.statusType).toBe("DONE");
  });
});
describe("TaskLineWidget.eq", () => {
  // Widget identity drives CM6's DOM reuse: while eq holds, the old
  // DOM (and its captured listeners) survives. The line index must be
  // part of the contract or identical task lines swap stale closures.
  const widgetAt = (line: number, lineText: string, symbol = "[ ]") =>
    new TaskLineWidget(line, lineText, symbol, "TODO", [], 0, { status: {} }, () => {}, undefined);

  test("identical widgets are equal", () => {
    expect(widgetAt(3, "- [ ] alpha").eq(widgetAt(3, "- [ ] alpha"))).toBe(true);
  });

  test("same text and symbol on a different line is NOT equal (stale-closure guard)", () => {
    expect(widgetAt(6, "- [ ] alpha").eq(widgetAt(3, "- [ ] alpha"))).toBe(false);
    expect(widgetAt(3, "- [ ] alpha").eq(widgetAt(6, "- [ ] alpha"))).toBe(false);
  });

  test("changed text or symbol is not equal", () => {
    expect(widgetAt(3, "- [ ] alpha").eq(widgetAt(3, "- [ ] beta"))).toBe(false);
    expect(widgetAt(3, "- [ ] alpha", "[ ]").eq(widgetAt(3, "- [ ] alpha", "[x]"))).toBe(false);
  });
});
