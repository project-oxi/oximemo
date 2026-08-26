import { describe, expect, test } from "bun:test";

import { normalizeSummaries, withFolder } from "./summaryFolder";
import type { MemoSummary } from "./types";

/**
 * Minimal wire-shaped MemoSummary: Rust sends `path` and never `folder` —
 * typed as the UI contract so post-normalization reads typecheck while the
 * runtime value still simulates the production lie.
 */
const wire = (path: string): MemoSummary =>
  ({
    id: "n1",
    created_at: "2026-08-24T00:00:00Z",
    updated_at: "2026-08-24T00:00:00Z",
    hash: "h",
    favorite: false,
    path,
    tags: [],
    props: {},
    preview: "",
    deleted: false,
  }) as unknown as MemoSummary;

describe("withFolder", () => {
  test("root-level note derives the root folder (\"\")", () => {
    expect(withFolder(wire("2026-07-29-110922.md")).folder).toBe("");
  });

  test("nested note derives its parent folder", () => {
    expect(withFolder(wire("knowledge/2026-08-24-021130-2.md")).folder).toBe("knowledge");
  });

  test("deeply nested note derives the full folder path", () => {
    expect(withFolder(wire("a/b/c.md")).folder).toBe("a/b");
  });

  test("an already-present folder is preserved, not recomputed", () => {
    const m = { ...wire("knowledge/x.md"), folder: "keepme" };
    expect(withFolder(m).folder).toBe("keepme");
  });
});

describe("normalizeSummaries (wire-boundary repair)", () => {
  test("list_memos: page items gain folder", () => {
    const page = { items: [wire("knowledge/a.md"), wire("b.md")], next_cursor: null };
    const out = normalizeSummaries("list_memos", page) as typeof page;
    expect(out.items[0].folder).toBe("knowledge");
    expect(out.items[1].folder).toBe("");
  });

  test("search_memos: every hit gains folder", () => {
    const hits = [wire("todo/a.md"), wire("inbox/b.md")];
    const out = normalizeSummaries("search_memos", hits) as typeof hits;
    expect(out.map((m) => m.folder)).toEqual(["todo", "inbox"]);
  });

  test("query_notes: query page items gain folder", () => {
    const page = { items: [wire("knowledge/a.md")], total: 1 };
    const out = normalizeSummaries("query_notes", page) as typeof page;
    expect(out.items[0].folder).toBe("knowledge");
  });

  test("run_base: row summaries gain folder", () => {
    const res = { rows: [{ summary: wire("knowledge/a.md"), folder: "knowledge", cells: [] }], total: 1 };
    const out = normalizeSummaries("run_base", res) as typeof res;
    expect(out.rows[0].summary.folder).toBe("knowledge");
  });

  test("other commands pass through untouched (same value)", () => {
    const res = { memo_stats: true };
    expect(normalizeSummaries("memo_stats", res)).toBe(res);
  });

  test("null/undefined responses pass through", () => {
    expect(normalizeSummaries("list_memos", null)).toBeNull();
  });
});
