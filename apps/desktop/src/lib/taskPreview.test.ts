import { describe, test, expect } from "bun:test";

import fixtureData from "./taskFixtures.json";
import {
  cfgFromJson,
  parseTaskLine,
  type ParsedLine,
  type Priority,
  type StatusType,
  type WireTaskLineCfg,
} from "./taskLine";
import { Marked } from "marked";
import {
  previewTaskLine,
  preprocessTaskMarkdown,
  stripTaskMetadata,
  type Chip,
  type FieldChip,
  type StatusChip,
  type TagChip,
  type TextChip,
  type SpacerChip,
} from "./taskPreview";
import { previewText } from "./markdownPreview";

const DEFAULT_CFG = cfgFromJson({
  write_format: "emoji",
  global_filter: "",
  recurrence_insert: "above",
  statuses: [],
});

/** Strip the trailing newline a fixture body always carries so the input
 * to `previewTaskLine` is exactly the line bytes. */
function lineOf(body: string): string {
  return body.endsWith("\r\n") ? body.slice(0, -2) : body.endsWith("\n") ? body.slice(0, -1) : body;
}

function isStatus(c: Chip): c is StatusChip { return c.kind === "status"; }
function isText(c: Chip): c is TextChip { return c.kind === "text"; }
function isField(c: Chip): c is FieldChip { return c.kind === "field"; }
function isTag(c: Chip): c is TagChip { return c.kind === "tag"; }
function isSpacer(c: Chip): c is SpacerChip { return c.kind === "spacer"; }

describe("previewTaskLine — status", () => {
  test("todo empty body", () => {
    const chips = previewTaskLine("- [ ]", DEFAULT_CFG);
    expect(chips).toEqual([
      { kind: "status", text: "[ ]", statusType: "TODO" },
      { kind: "text", text: "" },
    ]);
  });

  test("done task", () => {
    const chips = previewTaskLine("- [x] ship it", DEFAULT_CFG);
    expect(chips[0]).toEqual({ kind: "status", text: "[x]", statusType: "DONE" });
    expect(chips[1]).toEqual({ kind: "text", text: "ship it" });
    expect(chips.length).toBe(2);
  });

  test("cancelled task", () => {
    const chips = previewTaskLine("- [-] dropped", DEFAULT_CFG);
    expect(chips[0]).toEqual({ kind: "status", text: "[-]", statusType: "CANCELLED" });
    expect(chips[1]).toEqual({ kind: "text", text: "dropped" });
  });

  test("X (uppercase) collapses to DONE", () => {
    const chips = previewTaskLine("- [X] uppercase", DEFAULT_CFG);
    expect(chips[0]).toEqual({ kind: "status", text: "[X]", statusType: "DONE" });
  });
});

describe("previewTaskLine — fields", () => {
  test("due date (emoji form)", () => {
    const chips = previewTaskLine("- [/] wip 📅 2026-08-30", DEFAULT_CFG);
    const status = chips.find(isStatus);
    const due = chips.find((c) => isField(c) && c.field === "due");
    expect(status).toEqual({ kind: "status", text: "[/]", statusType: "IN_PROGRESS" });
    expect(due).toEqual({ kind: "field", field: "due", text: "📅 2026-08-30" });
  });

  test("priority emoji (icon-only)", () => {
    const chips = previewTaskLine("- [ ] task ⏫", DEFAULT_CFG);
    const pri = chips.find((c) => isField(c) && c.field === "priority");
    expect(pri).toEqual({ kind: "field", field: "priority", text: "⏫", priority: "high" });
  });

  test("recurrence (every week)", () => {
    const chips = previewTaskLine("- [ ] task 🔁 every week", DEFAULT_CFG);
    const rec = chips.find((c) => isField(c) && c.field === "recurrence");
    expect(rec).toEqual({ kind: "field", field: "recurrence", text: "🔁 every week" });
  });

  test("multiple fields preserve scan order", () => {
    const chips = previewTaskLine("- [ ] task 📅 2026-08-30 ⏫", DEFAULT_CFG);
    const fields = chips.filter(isField);
    expect(fields.map((f) => f.field)).toEqual(["due", "priority"]);
  });

  test("dataview form [due:: 2026-08-30]", () => {
    const chips = previewTaskLine("- [ ] task [due:: 2026-08-30]", DEFAULT_CFG);
    const due = chips.find((c) => isField(c) && c.field === "due");
    expect(due).toEqual({ kind: "field", field: "due", text: "[due:: 2026-08-30]" });
  });

  test("scheduled + done + cancelled all on one line", () => {
    const chips = previewTaskLine(
      "- [-] task ❌ 2026-08-20 ✅ 2026-08-21 ⏳ 2026-08-22",
      DEFAULT_CFG,
    );
    const fields = chips.filter(isField);
    expect(fields.map((f) => f.field)).toEqual(["cancelled", "done", "scheduled"]);
  });
});

describe("previewTaskLine — tags", () => {
  test("one tag", () => {
    const chips = previewTaskLine("- [ ] wip #foo", DEFAULT_CFG);
    expect(chips.find(isTag)).toEqual({ kind: "tag", text: "#foo" });
  });

  test("multiple tags preserve order", () => {
    const chips = previewTaskLine("- [ ] wip #alpha #beta #gamma", DEFAULT_CFG);
    const tags = chips.filter(isTag);
    expect(tags.map((t) => t.text)).toEqual(["#alpha", "#beta", "#gamma"]);
  });

  test("Korean tag (Unicode word chars)", () => {
    const chips = previewTaskLine("- [ ] 작업 #태그", DEFAULT_CFG);
    const tags = chips.filter(isTag);
    expect(tags).toEqual([{ kind: "tag", text: "#태그" }]);
  });

  test("digit-led #42 after a space IS a tag (digits are word chars)", () => {
    // The kernel's tag scanner treats digits as word chars, so "#42"
    // preceded by a space is a tag exactly like "#foo". It is stripped
    // from the body text and emitted as its own chip.
    const chips = previewTaskLine("- [ ] bug #42 fixed", DEFAULT_CFG);
    expect(chips.filter(isTag)).toEqual([{ kind: "tag", text: "#42" }]);
    expect(chips.find(isText)?.text).toBe("bug fixed");
  });

  test("'#' glued to a word char is NOT a tag and stays in body", () => {
    // A '#' preceded by a word char (here 'g') fails the kernel's tag
    // boundary rule, so the bytes stay part of the body text.
    const chips = previewTaskLine("- [ ] bug#42 fixed", DEFAULT_CFG);
    expect(chips.filter(isTag)).toEqual([]);
    expect(chips.find(isText)?.text).toBe("bug#42 fixed");
  });
});

describe("previewTaskLine — Korean body", () => {
  test("Korean body with due date and tag", () => {
    const chips = previewTaskLine("- [ ] 한국어 작업 📅 2026-08-30 #태그", DEFAULT_CFG);
    expect(chips.find(isStatus)?.statusType).toBe("TODO");
    expect(chips.find(isText)?.text).toBe("한국어 작업");
    expect(chips.find((c) => isField(c) && c.field === "due")).toBeDefined();
    expect(chips.find(isTag)?.text).toBe("#태그");
  });
});

describe("previewTaskLine — non-task lines (spacer)", () => {
  test("empty line", () => {
    expect(previewTaskLine("", DEFAULT_CFG)).toEqual([{ kind: "spacer", text: "" }]);
  });

  test("whitespace-only line", () => {
    expect(previewTaskLine("   ", DEFAULT_CFG)).toEqual([{ kind: "spacer", text: "   " }]);
  });

  test("plain prose line (no checkbox)", () => {
    expect(previewTaskLine("Just prose", DEFAULT_CFG)).toEqual([
      { kind: "spacer", text: "Just prose" },
    ]);
  });

  test("heading line is not a task", () => {
    expect(previewTaskLine("# heading", DEFAULT_CFG)).toEqual([
      { kind: "spacer", text: "# heading" },
    ]);
  });

  test("unknown checkbox marker falls back to a TODO task (kernel semantics)", () => {
    // `parseTaskLine` accepts any single byte between the brackets and
    // falls back to `{ next: "x", type: TODO }` for symbols missing
    // from the status table. The chip sequence keeps the original
    // "[?]" bytes in the status chip.
    const chips = previewTaskLine("- [?] mystery", DEFAULT_CFG);
    expect(chips).toEqual([
      { kind: "status", text: "[?]", statusType: "TODO" },
      { kind: "text", text: "mystery" },
    ]);
  });
});

describe("previewTaskLine — ParsedLine overload", () => {
  test("accepts a pre-parsed ParsedLine + raw", () => {
    const raw = "- [ ] wip 📅 2026-08-30 #foo";
    const parsed: ParsedLine | null = parseTaskLine(raw, DEFAULT_CFG);
    expect(parsed).not.toBeNull();
    const chips = previewTaskLine(parsed!, raw, DEFAULT_CFG);
    expect(chips.find(isStatus)?.statusType).toBe("TODO");
    expect(chips.find((c) => isField(c) && c.field === "due")).toBeDefined();
    expect(chips.find(isTag)?.text).toBe("#foo");
  });
});

describe("previewTaskLine — chip ordering", () => {
  test("status always first, text always after status", () => {
    const chips = previewTaskLine("- [x] done #t", DEFAULT_CFG);
    expect(chips[0]?.kind).toBe("status");
    expect(chips[1]?.kind).toBe("text");
  });

  test("indented child task", () => {
    const chips = previewTaskLine("  - [/] child wip", DEFAULT_CFG);
    expect(chips.find(isStatus)?.statusType).toBe("IN_PROGRESS");
    expect(chips.find(isText)?.text).toBe("child wip");
  });
});

describe("previewTaskLine — corpus invariants (taskFixtures.json)", () => {
  interface FixtureCase {
    name: string;
    cfg: WireTaskLineCfg;
    body: string;
  }
  const cases = (fixtureData.cases as FixtureCase[]).filter((c) => {
    // Recurrence-spawn cases have a body with two lines; preview operates
    // on a single line — take the first line only.
    return typeof c.body === "string";
  });

  for (const c of cases) {
    test(`invariants — ${c.name}`, () => {
      const cfg = cfgFromJson(c.cfg);
      const line = lineOf(c.body.split("\n")[0] ?? "");
      const parsed = parseTaskLine(line, cfg);
      const chips = previewTaskLine(line, cfg);

      if (parsed === null) {
        // Non-task lines collapse to a single spacer chip carrying the raw.
        expect(chips.length).toBe(1);
        const sp = chips[0];
        if (isSpacer(sp)) {
          expect(sp.text).toBe(line);
        } else {
          expect.unreachable("non-task line must emit exactly one spacer chip");
        }
        return;
      }

      // Valid task: first chip is status with the right StatusType.
      expect(chips.length).toBeGreaterThan(0);
      const status = chips[0];
      expect(status?.kind).toBe("status");
      expect((status as StatusChip).statusType).toBe(parsed.statusType);
      expect((status as StatusChip).text).toBe(line.slice(line.indexOf("[", parsed.spans.checkbox.start), line.indexOf("[", parsed.spans.checkbox.start) + 3));

      // Text chip is the parsed body.
      const textChip = chips.find(isText);
      expect(textChip).toBeDefined();
      expect(textChip?.text).toBe(parsed.text);

      // Every parsed field becomes exactly one field chip with matching kind
      // and text matching the byte range in the original line.
      const fieldChips = chips.filter(isField);
      expect(fieldChips.length).toBe(parsed.spans.fields.length);
      for (let i = 0; i < fieldChips.length; i++) {
        const cf = fieldChips[i]!;
        const pf = parsed.spans.fields[i]!;
        expect(cf.field).toBe(pf.field);
        expect(cf.text).toBe(line.slice(pf.start, pf.end));
      }

      // Priority chip carries a recognised Priority value (the corpus
      // lines only contain valid priority tokens).
      const RECOGNISED = ["highest", "high", "medium", "low", "lowest"];
      for (const f of fieldChips) {
        if (f.field === "priority") {
          const p = f.priority ?? null;
          expect(p === null || RECOGNISED.includes(p)).toBe(true);
        } else {
          expect(f.priority).toBeUndefined();
        }
      }

      // Tag chips match the in-line `#tag` runs, excluding any that fall
      // inside field ranges (the parser already strips them before
      // counting tags, so the body has zero `#` outside fields).
      const fieldRanges = parsed.spans.fields;
      const tagChips = chips.filter(isTag);
      // Build expected tag spans from the raw body of the parsed text.
      // We re-derive by scanning the raw line for `#` runs that don't
      // overlap field ranges — that's exactly how tagSpansOf works.
      const expectedTags: string[] = [];
      const wordChar = (c: string) => c === "_" || /[\p{L}\p{N}]/u.test(c);
      for (let i = 0; i < line.length; i++) {
        if (line[i] !== "#") continue;
        const prev = i > 0 ? line[i - 1] ?? "" : "";
        if (wordChar(prev)) continue;
        let j = i + 1;
        while (j < line.length && wordChar(line[j] ?? "")) j++;
        if (j <= i + 1) continue;
        // Skip if inside any field range.
        const inside = fieldRanges.some((r) => i >= r.start && j <= r.end);
        if (inside) continue;
        expectedTags.push(line.slice(i, j));
      }
      expect(tagChips.map((t) => t.text)).toEqual(expectedTags);
    });
  }
});

describe("previewTaskLine — type guards", () => {
  test("field priority type is non-null when field is priority", () => {
    const chips = previewTaskLine("- [ ] t ⏫", DEFAULT_CFG);
    const f = chips.find((c): c is FieldChip => isField(c));
    expect(f).toBeDefined();
    expect(f!.field).toBe("priority");
    // Type narrowing via the field property.
    if (f && f.field === "priority") {
      const p: Priority = f.priority ?? null;
      expect(p).toBe("high");
    }
  });

  test("status chip narrows to StatusType", () => {
    const chips = previewTaskLine("- [/] t", DEFAULT_CFG);
    const s = chips.find(isStatus);
    expect(s).toBeDefined();
    const st: StatusType = s!.statusType;
    expect(st).toBe("IN_PROGRESS");
  });
});

describe("preprocessTaskMarkdown — checkbox boxes", () => {
  test("[/] becomes an in-progress box span", () => {
    const out = preprocessTaskMarkdown("- [/] wip");
    expect(out).toContain('<span class="ox-task-box ox-task-in-progress" aria-hidden="true"></span>');
    expect(out).toContain("wip");
    expect(out).not.toContain("[/]");
  });

  test("all four canonical markers map to their state", () => {
    expect(preprocessTaskMarkdown("- [ ] t")).toContain('class="ox-task-box ox-task-todo"');
    expect(preprocessTaskMarkdown("- [x] t")).toContain('class="ox-task-box ox-task-done"');
    expect(preprocessTaskMarkdown("- [X] t")).toContain('class="ox-task-box ox-task-done"');
    expect(preprocessTaskMarkdown("- [-] t")).toContain('class="ox-task-box ox-task-cancelled"');
  });

  test("unknown markers stay verbatim (previews have no cfg)", () => {
    const out = preprocessTaskMarkdown("- [?] mystery");
    expect(out).toBe("- [?] mystery");
  });

  test("indented child tasks keep their box", () => {
    const out = preprocessTaskMarkdown("  - [/] child");
    expect(out).toContain('class="ox-task-box ox-task-in-progress"');
    expect(out).toContain("child");
  });
});

describe("preprocessTaskMarkdown — field chips", () => {
  test("due date emoji becomes an icon+value chip", () => {
    const out = preprocessTaskMarkdown("- [ ] task 📅 2026-08-30");
    expect(out).toContain('<span class="ox-task-field ox-task-due"><span class="ox-task-ic-due" aria-hidden="true"></span>2026-08-30</span>');
    expect(out).not.toContain("📅");
  });

  test("priority emoji becomes an icon-only chip (value hidden)", () => {
    const out = preprocessTaskMarkdown("- [ ] task ⏫");
    expect(out).toContain('<span class="ox-task-field ox-task-priority"><span class="ox-task-ic-priority-high" aria-hidden="true"></span></span>');
    expect(out).not.toContain("⏫");
  });

  test("[due:: 2026-08-30] dataview form is chipped like the emoji form", () => {
    const out = preprocessTaskMarkdown("- [ ] task [due:: 2026-08-30]");
    expect(out).toContain('<span class="ox-task-field ox-task-due"><span class="ox-task-ic-due" aria-hidden="true"></span>2026-08-30</span>');
    expect(out).not.toContain("[due::");
  });

  test("[priority:: high] dataview form resolves the icon level", () => {
    const out = preprocessTaskMarkdown("- [ ] task [priority:: high]");
    expect(out).toContain('<span class="ox-task-ic-priority-high" aria-hidden="true"></span>');
    expect(out).not.toContain("[priority::");
  });

  test("recurrence rule is chipped", () => {
    const out = preprocessTaskMarkdown("- [ ] task 🔁 every week");
    expect(out).toContain('<span class="ox-task-field ox-task-recurrence"><span class="ox-task-ic-recurrence" aria-hidden="true"></span>every week</span>');
    expect(out).not.toContain("🔁");
  });

  test("user-authored emoji survives untouched", () => {
    const out = preprocessTaskMarkdown("- [/] wip 📅 2026-08-30 ⏫ 🚀");
    expect(out).toContain("🚀");
    expect(out).toContain('class="ox-task-box ox-task-in-progress"');
    expect(out).toContain('class="ox-task-field ox-task-due"');
    expect(out).toContain('class="ox-task-field ox-task-priority"');
  });

  test("invalid date value chips as icon-only, never a fake date", () => {
    const out = preprocessTaskMarkdown("- [ ] task 📅 oops");
    expect(out).toContain('<span class="ox-task-field ox-task-due"><span class="ox-task-ic-due" aria-hidden="true"></span></span>');
    expect(out).not.toContain("oops");
    expect(out).not.toContain("📅");
  });
});

describe("preprocessTaskMarkdown — code protection", () => {
  test("fenced code blocks containing task syntax are untouched", () => {
    const md = "```\n- [/] wip 📅 2026-08-30\n```";
    expect(preprocessTaskMarkdown(md)).toBe(md);
  });

  test("task line after a closed fence is still chipped", () => {
    const out = preprocessTaskMarkdown("```\ncode\n```\n- [/] wip");
    expect(out).toContain('class="ox-task-box ox-task-in-progress"');
    expect(out).toContain("code");
  });

  test("inline code spans are not chipped (scanner skips backticks)", () => {
    const out = preprocessTaskMarkdown("- [ ] see `📅 2026-08-30` docs");
    expect(out).toContain("📅 2026-08-30");
    expect(out).not.toContain("ox-task-field");
  });

  test("inline code containing a checkbox literal is not re-boxed", () => {
    const out = preprocessTaskMarkdown("- [ ] look at `- [ ] task` literal");
    expect(out).toContain('class="ox-task-box ox-task-todo"');
    expect(out).toContain("`- [ ] task`");
  });

  test("non-task prose passes through unchanged", () => {
    const md = "Just prose 📅 2026-08-30\n\n# heading";
    expect(preprocessTaskMarkdown(md)).toBe(md);
  });
});

describe("preprocessTaskMarkdown — marked passthrough", () => {
  test("marked keeps the chip markup inside list items", () => {
    const marked = new Marked({ gfm: true, breaks: true });
    const html = marked.parse(preprocessTaskMarkdown("- [/] wip 📅 2026-08-30 ⏫"), { async: false }) as string;
    expect(html).toContain('class="ox-task-box ox-task-in-progress"');
    expect(html).toContain('class="ox-task-field ox-task-due"');
    expect(html).toContain('class="ox-task-field ox-task-priority"');
    expect(html).toContain("<li>");
    expect(html).not.toContain("📅");
    expect(html).not.toContain("[/]");
  });
});

describe("stripTaskMetadata — plain-text rows", () => {
  test("emoji metadata tokens vanish, body and tags stay", () => {
    const out = stripTaskMetadata("- [/] wip 📅 2026-08-30 ⏫ 🚀 #proj");
    expect(out).toBe("- wip 🚀 #proj");
  });

  test("dataview tokens vanish including values", () => {
    const out = stripTaskMetadata("- [ ] buy milk [due:: 2026-08-30] #groceries");
    expect(out).toBe("- buy milk #groceries");
  });

  test("canonical checkbox bytes are stripped uniformly", () => {
    expect(stripTaskMetadata("- [x] done")).toBe("- done");
    expect(stripTaskMetadata("- [ ] todo")).toBe("- todo");
    expect(stripTaskMetadata("- [-] dropped")).toBe("- dropped");
  });

  test("unknown markers stay verbatim", () => {
    expect(stripTaskMetadata("- [?] mystery 📅 2026-08-30")).toBe("- [?] mystery");
  });

  test("leading indent (list nesting) is preserved", () => {
    expect(stripTaskMetadata("    - [ ] child 📅 2026-08-30")).toBe("    - child");
  });

  test("fenced code is untouched, prose after it is stripped", () => {
    const md = "```\n- [/] wip 📅 2026-08-30\n```\n- [x] done ⏫";
    expect(stripTaskMetadata(md)).toBe("```\n- [/] wip 📅 2026-08-30\n```\n- done");
  });

  test("non-task prose is untouched", () => {
    const md = "prose 📅 2026-08-30 stays";
    expect(stripTaskMetadata(md)).toBe(md);
  });
});

// previewText / renderPreviewMarkdown integration needs a real DOM
// (DOMParser + DOMPurify); bun's test runtime has none — same guard as
// chatMarkdown.test.ts. The stripping logic itself is covered above via
// stripTaskMetadata; these pin the wiring when a DOM is present.
const canDom = typeof DOMParser !== "undefined";

(test.skipIf(!canDom))("previewText strips recognized metadata end-to-end", () => {
  const text = previewText("- [/] wip 📅 2026-08-30 ⏫ 🚀");
  expect(text).toContain("wip");
  expect(text).toContain("🚀");
  expect(text).not.toContain("📅");
  expect(text).not.toContain("⏫");
  expect(text).not.toContain("2026-08-30");
  expect(text).not.toContain("[");
});

(test.skipIf(!canDom))("previewText keeps task text and tags", () => {
  const text = previewText("- [ ] buy milk [due:: 2026-08-30] #groceries");
  expect(text).toContain("buy milk");
  expect(text).toContain("#groceries");
  expect(text).not.toContain("[due::");
  expect(text).not.toContain("2026-08-30");
});
