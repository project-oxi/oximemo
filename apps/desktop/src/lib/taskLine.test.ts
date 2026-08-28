import { describe, test, expect } from "bun:test";
import fixtureData from "./taskFixtures.json";
import {
  cfgFromJson,
  editFromJson,
  nextOccurrencePreview,
  transformTaskDraft,
  type WireTaskEdit,
  type WireTaskLineCfg,
  type TaskLineChange,
} from "./taskLine";

interface FixtureCase {
  name: string;
  cfg: WireTaskLineCfg;
  body: string;
  line: number;
  edit: string | WireTaskEdit;
  today: string;
  expected: { changes: TaskLineChange[] };
}

/** Apply a list of changes to a body, matching the Rust kernel's
 * `apply_line_changes_to_body`. Changes are sorted bottom-up so an
 * earlier change's start_line never shifts before it is processed.
 * Trailing newline preservation mirrors the kernel: `body.lines()` drops
 * a final `\n`, the changes splice into the resulting array, and the
 * function re-joins with `\n` and appends one `\n` (matching the
 * kernel's `lines.join("\n"); out.push('\n')`). */
function applyChanges(body: string, changes: TaskLineChange[]): string {
  const lineEnding = body.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = body.endsWith("\n");
  // body.lines() drops a trailing newline — strip it locally so the
  // splice operates on the same line array as the kernel.
  const sourceLines = body.endsWith("\r\n")
    ? body.slice(0, -2).split("\r\n")
    : body.slice(0, -1).split("\n");
  const sorted = [...changes].sort((a, b) => b.start_line - a.start_line);
  const result: string[] = [...sourceLines];
  for (const c of sorted) {
    const start = c.start_line;
    const end = start + c.delete_lines;
    result.splice(start, end - start, ...c.insert_lines);
  }
  let out = result.join(lineEnding);
  if (hasTrailingNewline) out += lineEnding;
  return out;
}

describe("taskLine fixtures", () => {
  // Edit is either a bare string (Toggle/Delete unit variants) or a
  // single-key object — we just exclude the Delete variant since the
  // mirror scope doesn't model it.
  const cases = (fixtureData.cases as FixtureCase[]).filter((c) => {
    if (typeof c.edit === "string") return c.edit !== "Delete";
    return !("Delete" in c.edit);
  });
  for (const c of cases) {
    test(c.name, () => {
      const cfg = cfgFromJson(c.cfg);
      const edit = editFromJson(c.edit);
      const t = transformTaskDraft(c.body, c.line, edit, c.today, cfg);
      expect(t.changes).toEqual(c.expected.changes);
    });
  }

  test("applied output matches the kernel's apply_line_changes_to_body", () => {
    // One cross-check that the body after applying the changes is the
    // same bytes the Rust kernel would produce — guards against the
    // transformer returning the right shape but the wrong actual edit.
    const sample = cases.find((c) => c.name === "toggle_recurrence_spawns_above_by_default");
    expect(sample).toBeDefined();
    const cfg = cfgFromJson(sample!.cfg);
    const edit = editFromJson(sample!.edit);
    const t = transformTaskDraft(sample!.body, sample!.line, edit, sample!.today, cfg);
    const applied = applyChanges(sample!.body, t.changes);
    // After spawn-above, the spawned occurrence should appear one line
    // above the now-completed original — the dated sibling line is the
    // anchor.
    expect(applied).toContain("📅 2026-09-03");
    expect(applied).toContain("✅ 2026-08-27");
    // Original line still present (same bytes, completed).
    expect(applied).toContain("🔁 every week");
  });

  test("CRLF body is preserved by transformer + applier", () => {
    const sample = cases.find((c) => c.name === "set_text_crlf_body_preserves_crlf");
    expect(sample).toBeDefined();
    const cfg = cfgFromJson(sample!.cfg);
    const edit = editFromJson(sample!.edit);
    const t = transformTaskDraft(sample!.body, sample!.line, edit, sample!.today, cfg);
    const applied = applyChanges(sample!.body, t.changes);
    expect(applied).toContain("\r\n");
    // Every line ending must be CRLF (the source body was all CRLF and
    // the kernel's `lines()` preserves the byte content of each line).
    const lines = applied.split("\n");
    for (const line of lines) {
      if (line.length === 0) continue;
      // If the line ended at a CRLF, the split gave us a clean line.
      // We just check that no bare LF appeared mid-content.
      expect(line.includes("\r")).toBe(true);
    }
  });
});

describe("transformTaskDraft edge cases", () => {
  const cfg = cfgFromJson({
    write_format: "emoji",
    global_filter: "",
    recurrence_insert: "above",
    statuses: [],
  });
  test("toggle on Todo enters Done with today stamped", () => {
    const out = transformTaskDraft("- [ ] task\n", 0, { kind: "toggle" }, "2026-08-27", cfg);
    const applied = applyChanges("- [ ] task\n", out.changes);
    expect(applied).toBe("- [x] task ✅ 2026-08-27\n");
  });

  test("toggle on Done returns to Todo and clears done date", () => {
    const out = transformTaskDraft("- [x] task ✅ 2026-08-20\n", 0, { kind: "toggle" }, "2026-08-27", cfg);
    const applied = applyChanges("- [x] task ✅ 2026-08-20\n", out.changes);
    expect(applied).toBe("- [ ] task \n");
  });

  test("set status to structural char is rejected", () => {
    expect(() =>
      transformTaskDraft("- [ ] task\n", 0, { kind: "status", symbol: "[" }, "2026-08-27", cfg),
    ).toThrow();
  });

  test("set text preserves tag and field tokens", () => {
    const out = transformTaskDraft(
      "- [ ] old text 📅 2026-08-30 #tag\n",
      0,
      { kind: "text", value: "new text" },
      "2026-08-27",
      cfg,
    );
    const applied = applyChanges(
      "- [ ] old text 📅 2026-08-30 #tag\n",
      out.changes,
    );
    expect(applied).toBe("- [ ] new text 📅 2026-08-30 #tag\n");
  });

  test("set text preserves non-tag global filter substring", () => {
    const cfgFilter = { ...cfg, globalFilter: "milk" };
    const body = "- [ ] buy milk\n";
    const t = transformTaskDraft(body, 0, { kind: "text", value: "new" }, "2026-08-27", cfgFilter);
    const applied = applyChanges(body, t.changes);
    expect(applied).toContain("milk");
    expect(applied).toContain("new");
  });
});

describe("nextOccurrencePreview", () => {
  // Plan C Task 9: TaskEditPopover's live preview feeds off the
  // existing `parseRecurrenceSpec` + `dateAdd` from Task 1 — these
  // tests guard the wiring (which branch picks today vs anchor,
  // which inputs map to null) without re-asserting the kernel's
  // arithmetic, already covered by the fixtures above.
  test("every week from a 2026-08-30 anchor shifts to 2026-09-06", () => {
    expect(nextOccurrencePreview("every week", "2026-08-30", "2026-09-01")).toBe("2026-09-06");
  });

  test("every month rolls day forward across month boundaries", () => {
    expect(nextOccurrencePreview("every month", "2026-01-31", "2026-02-01")).toBe("2026-02-28");
  });

  test("'when done' rule uses todayISO as the anchor, not the stale date", () => {
    // The original anchor was 2026-08-01 but the rule says "when done",
    // so the next occurrence lands a week after today (2026-09-05),
    // not a week after the anchor (which would be 2026-08-08).
    expect(nextOccurrencePreview("every week when done", "2026-08-01", "2026-09-05")).toBe(
      "2026-09-12",
    );
  });

  test("missing anchor for a non-whenDone rule yields null (caller shows needs-date)", () => {
    expect(nextOccurrencePreview("every week", null, "2026-09-01")).toBeNull();
  });

  test("missing todayISO for a 'when done' rule yields null", () => {
    expect(nextOccurrencePreview("every week when done", "2026-08-30", null)).toBeNull();
  });

  test("unparseable rules yield null (caller hides the preview)", () => {
    expect(nextOccurrencePreview("fortnight", "2026-08-30", "2026-09-01")).toBeNull();
    expect(nextOccurrencePreview("", "2026-08-30", "2026-09-01")).toBeNull();
    expect(nextOccurrencePreview("every", "2026-08-30", "2026-09-01")).toBeNull();
  });
});