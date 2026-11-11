import { describe, expect, test } from "bun:test";

import type { ChangeEntry } from "./api";
import { groupChanges } from "./changeGroups";

let seq = 100;
function entry(at: string, over: Partial<ChangeEntry> = {}): ChangeEntry {
  return {
    seq: seq--,
    at,
    path: `n${seq}.md`,
    memo_id: null,
    title: null,
    kind: "modified",
    source: "external",
    turn: null,
    before_commit: null,
    seen: false,
    ...over,
  };
}

describe("groupChanges", () => {
  test("external saves within 2 minutes form one group", () => {
    const g = groupChanges([
      entry("2026-11-11T10:05:00Z"),
      entry("2026-11-11T10:04:00Z"),
      entry("2026-11-11T10:00:00Z"),
    ]);
    expect(g.map((x) => x.entries.length)).toEqual([2, 1]);
  });

  test("a copilot turn is one group and splits external runs", () => {
    const turn = { id: "t1", prompt: "정리해 줘" };
    const g = groupChanges([
      entry("2026-11-11T10:03:00Z"),
      entry("2026-11-11T10:02:30Z", { source: "copilot", turn }),
      entry("2026-11-11T10:02:00Z", { source: "copilot", turn }),
      entry("2026-11-11T10:01:30Z"),
    ]);
    expect(g.map((x) => [x.kind, x.entries.length])).toEqual([["external", 1], ["turn", 2], ["external", 1]]);
    expect(g[1].turn?.id).toBe("t1");
  });

  test("app edits group apart from external ones", () => {
    const g = groupChanges([
      entry("2026-11-11T10:01:00Z", { source: "app" }),
      entry("2026-11-11T10:00:30Z"),
    ]);
    expect(g.map((x) => x.kind)).toEqual(["app", "external"]);
  });
});
