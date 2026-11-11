import { describe, expect, test } from "bun:test";

import { summarizePdcIssues, type PdcInventoryEntry } from "./pdcInventory";

function entry(path: string, cls: string, extra: Partial<PdcInventoryEntry> = {}): PdcInventoryEntry {
  return { path, class: cls, size_bytes: 1, broken_document_links: [], missing_assets: [], ...extra };
}

describe("summarizePdcIssues", () => {
  test("problem documents leave their class and are counted once", () => {
    const items = [
      entry("a.md", "document"),
      entry("b.md", "document"),
      entry("c.md", "document", { broken_document_links: ["pdc://document/x"] }),
      entry("d.html", "legacy_html"),
      entry("e.md", "invalid", { diagnostic: { code: "bad", message: "bad", line: 3 } }),
      entry("f.md", "legacy_markdown", { missing_assets: ["abc"] }),
    ];
    const s = summarizePdcIssues(items, []);
    expect([...s.problemPaths].sort()).toEqual(["c.md", "e.md", "f.md"]);
    expect(s.segments).toEqual([
      { class: "document", count: 2 },
      { class: "legacy_html", count: 1 },
    ]);
    const total = s.segments.reduce((n, seg) => n + seg.count, 0) + s.problemPaths.size;
    expect(total).toBe(items.length);
  });

  test("duplicate-id paths are problems even without diagnostics", () => {
    const items = [entry("a.md", "document"), entry("b.md", "document"), entry("c.md", "document")];
    const s = summarizePdcIssues(items, [{ document_id: "x", paths: ["a.md", "b.md"] }]);
    expect([...s.problemPaths].sort()).toEqual(["a.md", "b.md"]);
    expect(s.segments).toEqual([{ class: "document", count: 1 }]);
  });

  test("ties sort by class name so the bar order is stable across rescans", () => {
    const s = summarizePdcIssues([entry("q.base", "query"), entry("a.md", "document")], []);
    expect(s.segments.map((seg) => seg.class)).toEqual(["document", "query"]);
  });
});
