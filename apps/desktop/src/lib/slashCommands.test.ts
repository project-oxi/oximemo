/**
 * Tests for the §8 slash-command catalog (tasks spec §8, Plan D
 * Task 3): catalog completeness (24 v1 commands, six groups, both
 * locales), the 할 일 group's on-task-line vs off-line apply routing,
 * sub-option expansion, and palette-ranking order with the recency
 * boost.
 *
 * The apply path is exercised through the pure `patch(doc, from, to,
 * deps, choice)` — the exact mutation `slashExtension.ts` replays —
 * so no EditorView is needed.
 */
import { describe, test, expect } from "bun:test";

import { dict as enDict } from "./locales/en";
import { dict as koDict } from "./locales/ko";
import { RecencyLog } from "./paletteCommands";
import {
  buildSlashCatalog,
  rankSlashCommands,
  slashOptionsFor,
  type SlashCatalogEntry,
  type SlashChoice,
  type SlashDeps,
} from "./slashCommands";
import type { StatusDef, TaskLineCfg } from "./taskLine";

const STATUSES: StatusDef[] = [
  { symbol: " ", type: "TODO", next: "x" },
  { symbol: "/", type: "IN_PROGRESS", next: "x" },
  { symbol: "x", type: "DONE", next: " " },
  { symbol: "-", type: "CANCELLED", next: " " },
];
const emojiCfg: TaskLineCfg = {
  writeFormat: "emoji",
  globalFilter: "#task",
  recurrenceInsert: "below",
  statuses: STATUSES,
};
const dvCfg: TaskLineCfg = { ...emojiCfg, writeFormat: "dataview" };

const deps = (over: Partial<SlashDeps> = {}): SlashDeps => ({
  cfg: emojiCfg,
  locale: "ko",
  recency: new RecencyLog(),
  todayISO: "2026-08-29",
  templateBody: () => "## 회의록\n\n- 안건:",
  ...over,
});

const TEMPLATE_DEPS = deps;

/** The spec §8 v1 catalog in curated order (id per group). */
const EXPECTED_IDS = [
  "slash.task", "slash.progress", "slash.due", "slash.scheduled", "slash.start",
  "slash.priority", "slash.recurrence",
  "slash.today", "slash.tomorrow", "slash.yesterday", "slash.time",
  "slash.h1", "slash.h2", "slash.h3", "slash.table", "slash.code",
  "slash.quote", "slash.rule",
  "slash.wlink", "slash.wembed", "slash.image",
  "slash.query", "slash.daily",
  "slash.template",
];

const catalog = (): SlashCatalogEntry[] => buildSlashCatalog(TEMPLATE_DEPS());
const byId = (id: string): SlashCatalogEntry =>
  catalog().find((c) => c.id === id)!;

/** Replay a patch's change specs against the doc string (CM6
 *  transaction semantics: sorted, non-overlapping). */
function applied(doc: string, changes: { from: number; to: number; insert: string }[]): string {
  let out = "";
  let pos = 0;
  for (const ch of changes) {
    expect(ch.from).toBeGreaterThanOrEqual(pos);
    out += doc.slice(pos, ch.from) + ch.insert;
    pos = ch.to;
  }
  return out + doc.slice(pos);
}

/** Pick `command` at the "/query" span ending the doc, return the
 *  resulting text + caret. */
function pick(command: SlashCatalogEntry, doc: string, choice?: SlashChoice) {
  const from = doc.lastIndexOf("/");
  const to = doc.length;
  const patch = command.patch(doc, from, to, TEMPLATE_DEPS(), choice ?? command.choices[0]!);
  return { text: applied(doc, patch.changes), caret: patch.caret };
}

// --- Catalog completeness -------------------------------------------------

describe("catalog completeness (spec §8 v1)", () => {
  test("24 commands across the six groups, in curated order", () => {
    const cs = catalog();
    expect(cs.map((c) => c.id)).toEqual(EXPECTED_IDS);
    expect(cs).toHaveLength(24);
    const counts: Record<string, number> = {};
    for (const c of cs) counts[c.group] = (counts[c.group] ?? 0) + 1;
    expect(counts).toEqual({ task: 7, date: 4, format: 7, link: 3, query: 2, template: 1 });
  });

  test("ids are unique and orders are the array index", () => {
    const cs = catalog();
    expect(new Set(cs.map((c) => c.id)).size).toBe(24);
    cs.forEach((c, i) => expect(c.order).toBe(i));
  });

  test("every label/group/choice key exists with a string in BOTH locales", () => {
    for (const c of catalog()) {
      for (const key of [c.labelKey, c.groupKey]) {
        expect(typeof koDict[key]).toBe("string");
        expect(typeof enDict[key]).toBe("string");
      }
      for (const ch of c.choices) {
        if (!ch.labelKey) continue;
        expect(typeof koDict[ch.labelKey]).toBe("string");
        expect(typeof enDict[ch.labelKey]).toBe("string");
      }
    }
  });

  test("titles resolve per locale; the other locale rides as alias", () => {
    expect(byId("slash.due").title).toBe("마감일");
    expect(byId("slash.due").alias).toBe("Due date");
    const en = buildSlashCatalog({ ...TEMPLATE_DEPS(), locale: "en" });
    expect(en.find((c) => c.id === "slash.due")!.title).toBe("Due date");
  });

  test("template command hides when the body is null or blank (never a silent no-op)", () => {
    for (const body of [null, "", "  \n \n"]) {
      const cs = buildSlashCatalog({ ...TEMPLATE_DEPS(), templateBody: () => body });
      expect(cs.map((c) => c.id)).not.toContain("slash.template");
      expect(cs).toHaveLength(23);
    }
  });

  test("while cfg is unresolved only the 17 cfg-free commands mint", () => {
    const cs = buildSlashCatalog({ ...TEMPLATE_DEPS(), cfg: null });
    expect(cs).toHaveLength(17);
    expect(cs.every((c) => c.group !== "task")).toBe(true);
  });
});

// --- Option expansion -----------------------------------------------------

describe("option expansion", () => {
  test("date commands offer 오늘/내일 rows with token-preview details", () => {
    const rows = slashOptionsFor(byId("slash.due"), TEMPLATE_DEPS());
    expect(rows.map((r) => r.label)).toEqual(["마감일 · 오늘", "마감일 · 내일"]);
    expect(rows.map((r) => r.detail)).toEqual(["📅 2026-08-29", "📅 2026-08-30"]);
  });

  test("dataview cfg previews the dataview token", () => {
    const rows = slashOptionsFor(byId("slash.due"), deps({ cfg: dvCfg }));
    expect(rows.map((r) => r.detail)).toEqual(["[due:: 2026-08-29]", "[due:: 2026-08-30]"]);
  });

  test("우선순위 offers the five levels with per-level glyphs", () => {
    const rows = slashOptionsFor(byId("slash.priority"), TEMPLATE_DEPS());
    expect(rows).toHaveLength(5);
    expect(rows[0]!.label).toBe("우선순위 · 최우선");
    expect(rows.map((r) => r.detail)).toEqual(["🔺", "⏫", "🔼", "🔽", "⏬"]);
    expect(rows[4]!.choice.icon).toBe("priority-lowest");
  });

  test("bare commands expand to a single row without a suffix", () => {
    const rows = slashOptionsFor(byId("slash.table"), TEMPLATE_DEPS());
    expect(rows.map((r) => r.label)).toEqual(["표"]);
  });
});

// --- 할 일 group: on-task-line vs off-line --------------------------------

describe("할 일 group apply routing", () => {
  test("ON a task line: 마감일 appends the cfg-format token, caret at line end", () => {
    const { text, caret } = pick(byId("slash.due"), "- [ ] Fix bug /마감");
    expect(text).toBe("- [ ] Fix bug 📅 2026-08-29");
    expect(caret).toBe(text.length);
  });

  test("ON a task line with an existing token: the token is replaced in place", () => {
    const { text } = pick(byId("slash.due"), "- [ ] Fix 📅 2026-08-01 /마감");
    expect(text).toBe("- [ ] Fix 📅 2026-08-29");
    expect(text.match(/📅/g)).toHaveLength(1);
  });

  test("dataview cfg writes the dataview token on a task line", () => {
    const dvDeps = deps({ cfg: dvCfg });
    const cmd = buildSlashCatalog(dvDeps).find((c) => c.id === "slash.due")!;
    const doc = "- [ ] Fix /마감";
    const patch = cmd.patch(doc, doc.lastIndexOf("/"), doc.length, dvDeps, cmd.choices[0]!);
    expect(applied(doc, patch.changes)).toBe("- [ ] Fix [due:: 2026-08-29]");
  });

  test("예정일/시작일 route the same way with their own emojis", () => {
    expect(pick(byId("slash.scheduled"), "- [ ] A /예정").text).toBe("- [ ] A ⏳ 2026-08-29");
    expect(pick(byId("slash.start"), "- [ ] A /시작").text).toBe("- [ ] A 🛫 2026-08-29");
  });

  test("내일 sub-option shifts a day", () => {
    const cmd = byId("slash.due");
    const tomorrow = cmd.choices[1]!;
    expect(pick(cmd, "- [ ] A /마감", tomorrow).text).toBe("- [ ] A 📅 2026-08-30");
  });

  test("우선순위 appends the level token on a task line", () => {
    const cmd = byId("slash.priority");
    expect(pick(cmd, "- [ ] A /우선", cmd.choices[1]!).text).toBe("- [ ] A ⏫");
  });

  test("반복 appends the weekly default token (popover edits the rule)", () => {
    expect(pick(byId("slash.recurrence"), "- [ ] A /반복").text).toBe("- [ ] A 🔁 every week");
  });

  test("할 일 ON a done task line resets it to the vault's TODO symbol", () => {
    expect(pick(byId("slash.task"), "- [x] Fix bug /할").text).toBe("- [ ] Fix bug");
  });

  test("OFF a task line: 할 일 promotes the line with checkbox + global_filter", () => {
    const { text, caret } = pick(byId("slash.task"), "물 마시기 /할");
    expect(text).toBe("- [ ] 물 마시기 #task");
    expect(caret).toBe(text.length);
  });

  test("OFF a task line: 진행 중 promotes with the IN_PROGRESS symbol", () => {
    expect(pick(byId("slash.progress"), "물 마시기 /진행").text).toBe("- [/] 물 마시기 #task");
  });

  test("promotion keeps the indent, absorbs a list marker, skips a filter already present", () => {
    expect(pick(byId("slash.task"), "  - 항목 /할").text).toBe("  - [ ] 항목 #task");
    expect(pick(byId("slash.task"), "이미 #task 있음 /할").text).toBe("- [ ] 이미 #task 있음");
  });

  test("date commands off a task line promote AND stamp the field", () => {
    expect(pick(byId("slash.due"), "보고서 /마감").text).toBe("- [ ] 보고서 #task 📅 2026-08-29");
  });

  test("a line below the trigger line is untouched (whole-line replacement only)", () => {
    const { text } = pick(byId("slash.due"), "- [ ] A /마감\n- [ ] B");
    expect(text).toBe("- [ ] A 📅 2026-08-29\n- [ ] B");
  });
});

// --- Non-task groups ------------------------------------------------------

describe("non-task groups apply the insertion builders", () => {
  test("표 replaces the /query span with the indented skeleton", () => {
    const { text, caret } = pick(byId("slash.table"), "  /표");
    expect(text).toBe("  |  |  |\n  | --- | --- |\n  |  |  |");
    expect(caret).toBe(4);
  });

  test("메모 링크 leaves the caret inside the braces", () => {
    const { text, caret } = pick(byId("slash.wlink"), "노트 /링크");
    expect(text).toBe("노트 [[]]");
    expect(caret).toBe("노트 [[".length);
  });

  test("오늘 inserts today's ISO", () => {
    expect(pick(byId("slash.today"), "/오늘").text).toBe("2026-08-29");
    expect(pick(byId("slash.yesterday"), "/어제").text).toBe("2026-08-28");
  });

  test("템플릿 inserts the folder body verbatim", () => {
    const { text, caret } = pick(byId("slash.template"), "/템플릿");
    expect(text).toBe("## 회의록\n\n- 안건:");
    expect(caret).toBe(text.length);
  });
});

// --- Ranking ---------------------------------------------------------------

describe("ranking (palette ladder + recency)", () => {
  test("마감 lands the due command first", () => {
    const ranked = rankSlashCommands(catalog(), "마감", new RecencyLog());
    expect(ranked[0]!.id).toBe("slash.due");
    expect(ranked.map((c) => c.id)).not.toContain("slash.table");
  });

  test("the other-locale alias matches (ko locale, English query)", () => {
    const ranked = rankSlashCommands(catalog(), "due", new RecencyLog());
    expect(ranked[0]!.id).toBe("slash.due");
  });

  test("empty query ranks the whole catalog in curated order (bare '/' opens)", () => {
    expect(rankSlashCommands(catalog(), "", new RecencyLog()).map((c) => c.id))
      .toEqual(EXPECTED_IDS);
  });

  test("empty query ignores recency — curated order stays stable", () => {
    const recency = new RecencyLog();
    recency.record("slash.rule");
    expect(rankSlashCommands(catalog(), "", recency).map((c) => c.id))
      .toEqual(EXPECTED_IDS);
  });

  test("whitespace-only query behaves like empty", () => {
    expect(rankSlashCommands(catalog(), "  ", new RecencyLog()).map((c) => c.id))
      .toEqual(EXPECTED_IDS);
  });

  test("a recent pick outranks a curated-order tiebreak", () => {
    const recency = new RecencyLog();
    // Both 오늘 and 오늘의 할 일 블록 prefix-match "오" — curated
    // order puts 오늘 first…
    let ranked = rankSlashCommands(catalog(), "오", recency);
    expect(ranked[0]!.id).toBe("slash.today");
    // …but recording the daily-block pick flips them (boost 25).
    recency.record("slash.daily");
    ranked = rankSlashCommands(catalog(), "오", recency);
    expect(ranked[0]!.id).toBe("slash.daily");
  });
});
