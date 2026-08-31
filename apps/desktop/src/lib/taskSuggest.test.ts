/**
 * Tests for the task field auto-suggest (tasks spec §7.3, Plan C Task 10).
 *
 * Pure tests for `suggestOptionsFor(line, cfg, caret, labels, args)`:
 * absent-field filtering, present-field exclusion, date-option ISO
 * emission in BOTH write formats, code-span silence, non-task lines.
 *
 * Source-level tests drive `taskSuggestSource` / the merged extension
 * through real CM6 `EditorState`s (no DOM needed): the IME
 * composition gate, fenced-code silence, the explicit-vs-typed token
 * gate, doc-offset mapping, and — pinning the integration contract —
 * that the merged `autocompletion({override})` state CREATES without
 * the "Config merge conflict for field override" crash two separate
 * autocompletions produce.
 */
import { describe, test, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { autocompletion, CompletionContext } from "@codemirror/autocomplete";

import { cfgFromJson, type TaskLineCfg, type WireTaskLineCfg } from "./taskLine";
import type { Dict } from "./i18n";
import {
  suggestOptionsFor,
  taskSuggestExtension,
  taskSuggestSource,
  type TaskCompletion,
  wikiLinkCompletionSource,
} from "./taskSuggest";

const BASE_WIRE: WireTaskLineCfg = {
  global_filter: "",
  recurrence_insert: "above",
  statuses: [],
};

const CFG: TaskLineCfg = cfgFromJson(BASE_WIRE);

// Minimal labels stub — only the keys the suggest reads, cast to the
// full Dict shape (tests assert against these strings directly).
const LABELS: Dict = {
  task_field_due: "Due",
  task_field_scheduled: "Scheduled",
  task_field_start: "Start",
  task_field_done: "Done",
  task_field_created: "Created",
  task_field_cancelled: "Cancelled",
  task_field_priority: "Priority",
  task_recurrence: "Recurrence",
  today: "Today",
  tomorrow: "Tomorrow",
  task_pick_date: "Pick",
} as unknown as Dict;

const NO_LABELS = new Proxy({} as Dict, {
  get: (_t, key: string) => `<<${String(key)}>>`,
});

/** Minimal EditorView stand-in capturing dispatch specs. */
function fakeView(docLength: number) {
  const dispatched: {
    changes: { from: number; to: number; insert: string };
    selection?: { anchor: number };
  }[] = [];
  return {
    dispatched,
    view: {
      state: { doc: { length: docLength } },
      dispatch: (spec: (typeof dispatched)[number]) => {
        dispatched.push(spec);
      },
    },
  };
}

function applyOption(
  option: TaskCompletion,
  from: number,
  to: number,
  docLength = 100,
) {
  const { view, dispatched } = fakeView(docLength);
  const apply = option.apply as
    (view: unknown, completion: unknown, from: number, to: number) => void;
  apply(view, option, from, to);
  return dispatched;
}

describe("suggestOptionsFor — recognition gate", () => {
  test("non-task line: returns null (no completions offered)", () => {
    expect(suggestOptionsFor("just words here", CFG, 16, LABELS)).toBeNull();
    expect(suggestOptionsFor("- not a task", CFG, 13, LABELS)).toBeNull();
    expect(suggestOptionsFor("", CFG, 0, LABELS)).toBeNull();
  });

  test("global filter: kernel containment rule (contains, not starts-with)", () => {
    const cfg = cfgFromJson({ ...BASE_WIRE, global_filter: "#task" });
    // Caret at a REAL token boundary (end of line): the filter-less
    // line is rejected by the containment gate itself, not by a
    // boundary check.
    expect(suggestOptionsFor("- [ ] no token", cfg, 14, LABELS)).toBeNull();
    // A line merely CONTAINING the filter (mid-line, not a prefix)
    // suggests.
    const hit = suggestOptionsFor("- [ ] see #task d", cfg, 17, LABELS);
    expect(hit).not.toBeNull();
    expect(hit!.options.length).toBeGreaterThan(0);
    // Empty global filter: any recognized checkbox line suggests.
    expect(suggestOptionsFor("- [ ] no token", CFG, 14, LABELS)).not.toBeNull();
  });

  test("partial token at the cursor: options with a whitespace-bounded from", () => {
    const result = suggestOptionsFor("- [ ] one d", CFG, 11, LABELS);
    expect(result).not.toBeNull();
    expect(result!.options.length).toBeGreaterThan(0);
    // The token "d" starts right after the space at index 9.
    expect(result!.from).toBe(10);
    expect(result!.to).toBe(11);
  });

  test("caret mid-word (not at a boundary): null", () => {
    // Caret inside "o|ne" — prev char is a word char, so replacing
    // from the token start would clobber the task text.
    expect(suggestOptionsFor("- [ ] one", CFG, 7, LABELS)).toBeNull();
    expect(suggestOptionsFor("- [ ] one", CFG, 8, LABELS)).toBeNull();
  });
});

describe("suggestOptionsFor — apply-range structure guards", () => {
  test("caret 0 (before the checkbox): range clamps to a pure insertion at the checkbox end", () => {
    const line = "- [ ] task";
    const result = suggestOptionsFor(line, CFG, 0, LABELS, {
      todayISO: "2026-08-27",
    })!;
    expect(result).not.toBeNull();
    expect(result.from).toBe(6);
    expect(result.to).toBe(6);
    const dueToday = result.options.find((o) => o.label === "Due Today")!;
    const [d] = applyOption(dueToday, result.from, result.to, line.length);
    expect(d!.changes.from).toBe(6);
    expect(d!.changes.to).toBe(6);
    // Reconstructing the line: the checkbox stays a prefix — nothing
    // was inserted before `- [ ] `.
    const applied =
      line.slice(0, d!.changes.from) + d!.changes.insert + line.slice(d!.changes.to);
    expect(applied.startsWith("- [ ] ")).toBe(true);
  });

  test("caret at end of an existing date token: token preserved (pure insertion after it)", () => {
    const line = "- [ ] task 📅 2026-08-27";
    const result = suggestOptionsFor(line, CFG, line.length, LABELS, {
      todayISO: "2026-08-27",
    })!;
    expect(result).not.toBeNull();
    // `due` is present → no Due options; another field's accept must
    // not reach back into the existing token.
    expect(result.options.some((o) => o.label.startsWith("Due"))).toBe(false);
    const schedToday = result.options.find((o) => o.label === "Scheduled Today")!;
    const [d] = applyOption(schedToday, result.from, result.to, line.length);
    expect(d!.changes.from).toBe(line.length);
    expect(d!.changes.to).toBe(line.length);
    const applied =
      line.slice(0, d!.changes.from) + d!.changes.insert + line.slice(d!.changes.to);
    expect(applied).toBe(`${line}${d!.changes.insert}`);
    expect(applied).toContain("📅 2026-08-27");
  });
});
describe("suggestOptionsFor — code-span gate", () => {
  test("caret inside an open inline-code span at end of line: null", () => {
    const line = "- [ ] see `code";
    expect(suggestOptionsFor(line, CFG, line.length, LABELS)).toBeNull();
  });

  test("same line without the backtick: options flow", () => {
    const line = "- [ ] see code";
    expect(suggestOptionsFor(line, CFG, line.length, LABELS)).not.toBeNull();
  });

  test("closed code span earlier on the line does not block", () => {
    const line = "- [ ] see `x` done d";
    const result = suggestOptionsFor(line, CFG, line.length, LABELS);
    expect(result).not.toBeNull();
    expect(result!.from).toBe(line.length - 1);
  });
});

describe("suggestOptionsFor — absent-field filtering", () => {
  test("a bare task line offers every absent field", () => {
    const line = "- [ ] fresh ";
    const result = suggestOptionsFor(line, CFG, line.length, LABELS);
    expect(result).not.toBeNull();
    const labels = result!.options.map((o) => o.label);
    for (const prefix of [
      "Due",
      "Scheduled",
      "Start",
      "Done",
      "Created",
      "Cancelled",
      "Priority",
      "Recurrence",
    ]) {
      expect(labels.some((l) => l.startsWith(prefix))).toBe(true);
    }
  });

  test("present fields are excluded (emoji markers)", () => {
    const line = "- [ ] has due 📅 2026-08-30 🔺";
    const result = suggestOptionsFor(line, CFG, line.length, LABELS);
    expect(result).not.toBeNull();
    const labels = result!.options.map((o) => o.label);
    expect(labels.some((l) => l.startsWith("Due"))).toBe(false);
    expect(labels.some((l) => l.startsWith("Priority"))).toBe(false);
    for (const prefix of ["Scheduled", "Start", "Done", "Created", "Cancelled", "Recurrence"]) {
      expect(labels.some((l) => l.startsWith(prefix))).toBe(true);
    }
  });

  test("present fields are excluded (dataview markers)", () => {
    const line = "- [ ] dataview [due:: 2026-08-30]";
    const result = suggestOptionsFor(line, CFG, line.length, LABELS);
    expect(result).not.toBeNull();
    const labels = result!.options.map((o) => o.label);
    expect(labels.some((l) => l.startsWith("Due"))).toBe(false);
    expect(labels.some((l) => l.startsWith("Scheduled"))).toBe(true);
  });

  test("date fields expand to three options; non-date fields to one", () => {
    const line = "- [ ] fresh ";
    const result = suggestOptionsFor(line, CFG, line.length, LABELS)!;
    const count = (prefix: string) =>
      result.options.filter((o) => o.label.startsWith(prefix)).length;
    for (const prefix of ["Due", "Scheduled", "Start", "Done", "Created", "Cancelled"]) {
      expect(count(prefix)).toBe(3);
    }
    expect(count("Priority")).toBe(1);
    expect(count("Recurrence")).toBe(1);
    // Every option carries a catalog icon for the custom renderer.
    for (const o of result.options) expect(o.icon).toBeTruthy();
  });
});

describe("suggestOptionsFor — date option ISO emission", () => {
  test("today option applies `[due:: ISO]` at the matched range", () => {
    const line = "- [ ] x";
    const result = suggestOptionsFor(line, CFG, line.length, LABELS, {
      todayISO: "2026-08-27",
    })!;
    const dueToday = result.options.find((o) => o.label === "Due Today")!;
    expect(dueToday).toBeDefined();
    const [d] = applyOption(dueToday, result.from, result.to, line.length);
    expect(d!.changes.insert).toBe("[due:: 2026-08-27]");
    expect(d!.changes.from).toBe(result.from);
    expect(d!.changes.to).toBe(result.to);
    expect(d!.selection?.anchor).toBe(result.from + "[due:: 2026-08-27]".length);
  });

  test("tomorrow option: ISO is today + 1 day", () => {
    const line = "- [ ] x";
    const result = suggestOptionsFor(line, CFG, line.length, LABELS, {
      todayISO: "2026-08-27",
    })!;
    const dueTomorrow = result.options.find((o) => o.label === "Due Tomorrow")!;
    const [d] = applyOption(dueTomorrow, result.from, result.to, line.length);
    expect(d!.changes.insert).toBe("[due:: 2026-08-28]");
  });

  test("month/year rollover: tomorrow crosses the month boundary", () => {
    const line = "- [ ] x";
    const result = suggestOptionsFor(line, CFG, line.length, LABELS, {
      todayISO: "2026-08-31",
    })!;
    const dueTomorrow = result.options.find((o) => o.label === "Due Tomorrow")!;
    const [d] = applyOption(dueTomorrow, result.from, result.to, line.length);
    expect(d!.changes.insert).toBe("[due:: 2026-09-01]");
  });

  test("pick option: marker + trailing space, cursor after; never a literal label", () => {
    const line = "- [ ] x";
    const result = suggestOptionsFor(line, CFG, line.length, LABELS, {
      todayISO: "2026-08-27",
    })!;
    const [d] = applyOption(
      result.options.find((o) => o.label === "Due Pick")!,
      result.from,
      result.to,
      line.length,
    );
    expect(d!.changes.insert).toBe("[due:: ");
    expect(d!.changes.insert).not.toMatch(/오늘|내일|today|tomorrow/i);
    expect(d!.selection?.anchor).toBe(result.from + "[due:: ".length);
  });

  test("non-date bare options apply their default tokens", () => {
    const line = "- [ ] x";
    const result = suggestOptionsFor(line, CFG, line.length, LABELS, {
      todayISO: "2026-08-27",
    })!;
    const [dPrio] = applyOption(
      result.options.find((o) => o.label === "Priority")!,
      result.from,
      result.to,
      line.length,
    );
    expect(dPrio!.changes.insert).toBe("[priority:: medium]");
    const [dRec] = applyOption(
      result.options.find((o) => o.label === "Recurrence")!,
      result.from,
      result.to,
      line.length,
    );
    expect(dRec!.changes.insert).toBe("[repeat:: every day]");
  });
});

describe("suggestOptionsFor — labels fallback", () => {
  test("missing label keys fall back to the dict key strings", () => {
    const line = "- [ ] fresh ";
    const result = suggestOptionsFor(line, CFG, line.length, NO_LABELS, {
      todayISO: "2026-08-27",
    });
    expect(result).not.toBeNull();
    for (const o of result!.options) {
      expect(typeof o.label).toBe("string");
      expect(o.label.length).toBeGreaterThan(0);
    }
    expect(result!.options.some((o) => o.label.startsWith("<<task_field_due>>"))).toBe(true);
  });
});

// --- Source-level (real EditorState) ------------------------------------

const SOURCE_OPTS = {
  cfg: CFG,
  labels: LABELS,
  wiki: { suggest: async () => [] },
  todayISO: "2026-08-27",
};

function ctxFor(doc: string, pos: number, explicit = false, composing = false) {
  const state = EditorState.create({ doc });
  const view = composing ? ({ composing: true } as unknown as never) : undefined;
  return new CompletionContext(state, pos, explicit, view);
}

describe("taskSuggestSource", () => {
  test("plain prose line: null", () => {
    const src = taskSuggestSource(SOURCE_OPTS);
    expect(src(ctxFor("just words here d", 17))).toBeNull();
  });

  test("composing view: null (IME gate)", () => {
    const src = taskSuggestSource(SOURCE_OPTS);
    expect(src(ctxFor("- [ ] one d", 11, false, true))).toBeNull();
  });

  test("fenced code block: null; the task line after the fence: options", () => {
    const src = taskSuggestSource(SOURCE_OPTS);
    const doc = "```\n- [ ] fenced d\n```\n- [ ] open d";
    // Line 1 ("- [ ] fenced d") is inside the fence.
    const fencedPos = doc.indexOf("fenced") + 7;
    expect(src(ctxFor(doc, fencedPos))).toBeNull();
    // Line 3 ("- [ ] open d") is real markdown.
    const openPos = doc.length;
    const result = src(ctxFor(doc, openPos))!;
    expect(result).not.toBeNull();
    expect(result.from).toBe(doc.length - 1);
    expect(result.to).toBe(doc.length);
  });

  test("typed token required unless explicit (no popup on bare space)", () => {
    const src = taskSuggestSource(SOURCE_OPTS);
    const doc = "- [ ] buy milk ";
    // Not explicit: the token range is empty → silent.
    expect(src(ctxFor(doc, doc.length))).toBeNull();
    // Explicit (Ctrl-Space): offer every absent field.
    const result = src(ctxFor(doc, doc.length, true))!;
    expect(result).not.toBeNull();
    expect(result.from).toBe(result.to!);
    expect(result.options.length).toBeGreaterThan(0);
  });

  test("null cfg (config query in flight): source silent, wiki alive", () => {
    const src = taskSuggestSource({ ...SOURCE_OPTS, cfg: null });
    expect(src(ctxFor("- [ ] one d", 11))).toBeNull();
  });

  test("doc-offset mapping: from/to are doc positions, not line-local", () => {
    const src = taskSuggestSource(SOURCE_OPTS);
    const doc = "intro\n- [ ] one d";
    const result = src(ctxFor(doc, doc.length))!;
    expect(result.from).toBe(doc.length - 1);
    expect(result.to).toBe(doc.length);
  });
});

describe("wikiLinkCompletionSource (replica)", () => {
  test("completes after `[[` with from after the brackets", async () => {
    const wiki = wikiLinkCompletionSource({
      suggest: async (q) => [
        { target: `Note ${q}`, label: "Lbl" },
        { target: "Dup", label: "First" },
        { target: "Dup", label: "Second" },
      ],
      debounceMs: 0,
    });
    const doc = "see [[qu";
    const result = await wiki(ctxFor(doc, doc.length));
    expect(result).not.toBeNull();
    expect(result!.from).toBe(doc.indexOf("[[") + 2);
    expect(result!.to).toBe(doc.length);
    // Deduped by target (Dup appears once); serialized default shape.
    expect(result!.options.map((o) => o.label)).toEqual(["Lbl", "First"]);
    // The suggestion rides the completion for the apply path.
    const first = result!.options[0] as unknown as { suggestion: { target: string } };
    expect(first.suggestion.target).toBe("Note qu");
  });

  test("no suggest configured: null", async () => {
    const wiki = wikiLinkCompletionSource({});
    expect(await wiki(ctxFor("see [[qu", 8))).toBeNull();
  });

  test("outside a `[[` query: null (task lines never reach the wiki path)", async () => {
    const wiki = wikiLinkCompletionSource({ suggest: async () => [], debounceMs: 0 });
    expect(await wiki(ctxFor("- [ ] one d", 11))).toBeNull();
  });
});

describe("taskSuggestExtension — merged autocompletion", () => {
  test("state creation does not throw the override config-merge conflict", () => {
    // Two autocompletion({override}) extensions with different
    // arrays crash CM6 at state creation. The merged mount must not.
    const state = EditorState.create({
      doc: "- [ ] one d",
      extensions: [
        // Simulates wikiLinks' own decorations-only presence (its
        // internal autocompletion is suppressed by the host passing
        // suggest: undefined — the replica rides OUR override).
        ...taskSuggestExtension(SOURCE_OPTS),
      ],
    });
    expect(state.doc.length).toBe(11);
  });

  test("an actual second override autocompletion conflicts (pinning why we merge)", () => {
    expect(() => {
      EditorState.create({
        doc: "x",
        extensions: [
          autocompletion({ override: [() => null] }),
          autocompletion({ override: [() => null] }),
        ],
      });
    }).toThrow(/override/);
  });
});