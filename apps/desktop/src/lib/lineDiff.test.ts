import { describe, expect, test } from "bun:test";

import { diffHunks, diffLines, splitLines } from "./lineDiff";

const ops = (before: string | null, after: string | null) =>
  diffLines(before, after).map((l) => `${l.op === "same" ? " " : l.op === "add" ? "+" : "-"}${l.text}`);

describe("splitLines", () => {
  test("null and empty are no lines; trailing newline is not a line", () => {
    expect(splitLines(null)).toEqual([]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
  });
});

describe("diffLines", () => {
  test("identical text has no changes", () => {
    expect(diffLines("a\nb", "a\nb").every((l) => l.op === "same")).toBe(true);
  });

  test("created file is all additions, deleted file all removals", () => {
    expect(ops(null, "a\nb")).toEqual(["+a", "+b"]);
    expect(ops("a\nb", null)).toEqual(["-a", "-b"]);
  });

  test("replacement puts the removed line before the added one", () => {
    expect(ops("a\nb\nc", "a\nB\nc")).toEqual([" a", "-b", "+B", " c"]);
  });

  test("insert and delete in the middle keep the common lines", () => {
    expect(ops("a\nb\nc\nd", "a\nc\nx\nd")).toEqual([" a", "-b", " c", "+x", " d"]);
  });

  test("line numbers follow each side", () => {
    const lines = diffLines("a\nb\nc", "a\nx\nb\nc");
    const added = lines.find((l) => l.op === "add");
    expect(added).toEqual({ op: "add", text: "x", b: 2 });
    const last = lines[lines.length - 1];
    expect(last).toEqual({ op: "same", text: "c", a: 3, b: 4 });
  });

  test("CRLF and LF compare equal", () => {
    expect(diffLines("a\r\nb\r\n", "a\nb\n").every((l) => l.op === "same")).toBe(true);
  });
});

describe("diffHunks", () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");

  test("no change → no hunks", () => {
    expect(diffHunks(before, before)).toEqual([]);
  });

  test("one change shows two context lines on each side", () => {
    const after = before.replace("l10", "L10");
    const hunks = diffHunks(before, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines.map((l) => l.text)).toEqual(["l8", "l9", "l10", "L10", "l11", "l12"]);
  });

  test("far-apart changes are separate hunks, close ones merge", () => {
    const far = before.replace("l3", "X").replace("l15", "Y");
    expect(diffHunks(before, far)).toHaveLength(2);
    // 사이 같은 줄이 4개(context × 2) — 한 덩어리로 잇는다.
    const near = before.replace("l3", "X").replace("l8", "Y");
    expect(diffHunks(before, near)).toHaveLength(1);
  });

  test("context is clipped at file edges", () => {
    const after = before.replace("l1\n", "L1\n");
    const hunk = diffHunks(before, after)[0];
    expect(hunk.lines[0]).toEqual({ op: "del", text: "l1", a: 1 });
  });
});
