/**
 * Tests for the slash-command trigger predicate (tasks spec §8,
 * Plan D Task 1).
 *
 * Pure tests for `slashTriggerAt(doc, pos)`: the '/' must sit at line
 * start or after whitespace (never mid-word), the query between '/' and
 * the caret must be same-line and whitespace-free, and the caret must
 * not sit in fenced code, on an indented-code line (≥4 columns), or
 * inside an inline-code span. Plus the rankSlashCommands adapter
 * contract (palette ladder + recency, SlashCommand in/out).
 */
import { describe, test, expect } from "bun:test";

import { slashTriggerAt } from "./slashTrigger";
import { rankSlashCommands, type SlashCommand } from "./slashCommands";
import { RecencyLog } from "./paletteCommands";

describe("slashTriggerAt", () => {
  // --- Active positions --------------------------------------------------

  test("line-start '/할' with caret after the query", () => {
    expect(slashTriggerAt("/할", 2)).toEqual({ from: 0, query: "할" });
  });

  test("caret immediately after '/' — empty query opens the menu", () => {
    expect(slashTriggerAt("/할", 1)).toEqual({ from: 0, query: "" });
  });

  test("after-space '할 일 /마감' — from is the doc offset of the '/'", () => {
    expect(slashTriggerAt("할 일 /마감", 7)).toEqual({ from: 4, query: "마감" });
  });

  test("caret parked on the newline is still end-of-line", () => {
    // pos 2 sits on the '\n' — the line is "/할", the query ends there.
    expect(slashTriggerAt("/할\n일", 2)).toEqual({ from: 0, query: "할" });
  });

  test("a fresh '/' after whitespace beats an older mid-word one", () => {
    // 'a /b /c' — the second '/' opens a new trigger; query is "c".
    expect(slashTriggerAt("a /b /c", 7)).toEqual({ from: 5, query: "c" });
  });

  test("three-space indent is not indented code", () => {
    expect(slashTriggerAt("   /x", 5)).toEqual({ from: 3, query: "x" });
  });

  test("inline code closed earlier on the line does not suppress", () => {
    expect(slashTriggerAt("a `x` /cmd", 10)).toEqual({ from: 6, query: "cmd" });
  });

  // --- Null positions ----------------------------------------------------

  test("mid-word 'abc/def' → null", () => {
    expect(slashTriggerAt("abc/def", 7)).toBeNull();
  });

  test("mid-word Korean '글/자' → null", () => {
    expect(slashTriggerAt("글/자", 3)).toBeNull();
  });

  test("a later '/' attached to a word → null ('a /b/c')", () => {
    expect(slashTriggerAt("a /b/c", 6)).toBeNull();
  });

  test("inside a ``` fence → null (opener and body lines)", () => {
    expect(slashTriggerAt("```\n/cmd\n```", 8)).toBeNull();
    expect(slashTriggerAt("```\n/cmd\n```", 5)).toBeNull();
    // Caret at the start of the line after the opener is still code.
    expect(slashTriggerAt("```\n/cmd\n```", 4)).toBeNull();
  });

  test("inside a ~~~ fence → null", () => {
    expect(slashTriggerAt("~~~\n/x\n~~~", 6)).toBeNull();
  });

  test("indented code line (4 spaces) → null", () => {
    expect(slashTriggerAt("    /cmd", 8)).toBeNull();
  });

  test("indented code line (one tab = 4 columns) → null", () => {
    expect(slashTriggerAt("\t/x", 3)).toBeNull();
  });

  test("inline code '`/code' → null (unclosed span)", () => {
    expect(slashTriggerAt("`/code", 6)).toBeNull();
    expect(slashTriggerAt("`/code`", 7)).toBeNull();
  });

  test("'/' followed by space then text → null (dismissed)", () => {
    expect(slashTriggerAt("/ 마감", 4)).toBeNull();
  });

  test("query spanning a newline → null", () => {
    // The '/' is on the previous line; this line has no trigger.
    expect(slashTriggerAt("/할 일\n마감", 7)).toBeNull();
  });

  test("whitespace anywhere between '/' and caret → null", () => {
    expect(slashTriggerAt("a /마 감", 6)).toBeNull();
  });

  // --- CRLF --------------------------------------------------------------

  test("CRLF: line-2 trigger resolves with doc-true offsets", () => {
    expect(slashTriggerAt("할 일\r\n/마감", 8)).toEqual({ from: 5, query: "마감" });
  });

  test("CRLF: fenced block still suppresses", () => {
    expect(slashTriggerAt("```\r\n/x\r\n```", 6)).toBeNull();
  });

  test("CRLF: query ending right before the '\\r' stays active", () => {
    // "/마감\r\nx" — pos 3 sits before the '\r'; the query is "마감".
    expect(slashTriggerAt("/마감\r\nx", 3)).toEqual({ from: 0, query: "마감" });
  });

  test("CRLF: caret on the '\\r' disarms (whitespace after the '/')", () => {
    expect(slashTriggerAt("/마감\r\nx", 4)).toBeNull();
  });

  // --- Position validation -----------------------------------------------

  test("out-of-range / non-integer / empty-doc positions → null", () => {
    expect(slashTriggerAt("/x", -1)).toBeNull();
    expect(slashTriggerAt("/x", 3)).toBeNull();
    expect(slashTriggerAt("/x", 1.5)).toBeNull();
    expect(slashTriggerAt("", 0)).toBeNull();
  });
});

describe("rankSlashCommands", () => {
  // Full-catalog construction is Task 2's; these pin the adapter
  // contract: palette ladder + recency, SlashCommand in and out.
  const cmd = (id: string, title: string, order: number, alias?: string): SlashCommand => ({
    id,
    icon: "task",
    title,
    alias,
    order,
  });
  const cmds = [
    cmd("slash.task", "할 일 추가", 0),
    cmd("slash.add", "추가", 1),
    cmd("slash.en", "Task", 2, "할 일"),
  ];

  test("empty query → the full list in curated order (bare '/' opens)", () => {
    expect(rankSlashCommands(cmds, "", new RecencyLog()).map((c) => c.id))
      .toEqual(["slash.task", "slash.add", "slash.en"]);
    expect(rankSlashCommands(cmds, "   ", new RecencyLog()).map((c) => c.id))
      .toEqual(["slash.task", "slash.add", "slash.en"]);
  });

  test("exact outranks substring", () => {
    const ranked = rankSlashCommands(cmds, "추가", new RecencyLog());
    expect(ranked.map((c) => c.id)).toEqual(["slash.add", "slash.task"]);
  });

  test("non-matching commands are filtered out", () => {
    expect(rankSlashCommands(cmds, "없음", new RecencyLog())).toEqual([]);
  });

  test("alias (other-locale title) is matched, never displayed", () => {
    const ranked = rankSlashCommands(cmds, "할 일", new RecencyLog());
    expect(ranked.map((c) => c.id)).toContain("slash.en");
    expect(ranked.find((c) => c.id === "slash.en")?.title).toBe("Task");
  });

  test("recency boost reorders equal-scored matches", () => {
    const a = cmd("a", "alpha task", 0);
    const b = cmd("b", "beta task", 1);
    const cold = new RecencyLog();
    expect(rankSlashCommands([a, b], "task", cold).map((c) => c.id)).toEqual(["a", "b"]);
    const warm = new RecencyLog();
    warm.record("b");
    expect(rankSlashCommands([a, b], "task", warm).map((c) => c.id)).toEqual(["b", "a"]);
  });

  test("returns the input command objects (no group leakage)", () => {
    const ranked = rankSlashCommands(cmds, "추가", new RecencyLog());
    expect(ranked[0]).toBe(cmds[1]);
    expect("group" in ranked[0]).toBe(false);
  });
});
