/**
 * Pure-seam tests for `effectiveStatuses` (Plan C Task 9 review):
 * the popover's status selector must render the EFFECTIVE table —
 * builtin statuses ∪ the vault's raw `[tasks] statuses` — because the
 * raw cfg alone is EMPTY on default vaults. Pins the merge semantics
 * that mirror taskLine.ts's private `buildStatusTable` (X-normalizing,
 * same-symbol override keeps builtin position, new symbols append).
 */
import { describe, expect, test } from "bun:test";

import { effectiveStatuses } from "./taskToggle";
import type { StatusDef, TaskLineCfg } from "./taskLine";

const cfg = (statuses: StatusDef[]): TaskLineCfg => ({
  writeFormat: "emoji",
  globalFilter: "",
  recurrenceInsert: "above",
  statuses,
});

describe("effectiveStatuses", () => {
  test("default vault (no custom statuses) yields exactly the builtin table", () => {
    expect(effectiveStatuses(cfg([]))).toEqual([
      { symbol: " ", type: "TODO", next: "x" },
      { symbol: "/", type: "IN_PROGRESS", next: "x" },
      { symbol: "x", type: "DONE", next: " " },
      { symbol: "-", type: "CANCELLED", next: " " },
    ]);
  });

  test("custom statuses append after the builtins", () => {
    const out = effectiveStatuses(cfg([{ symbol: "n", type: "NON_TASK", next: " " }]));
    expect(out).toHaveLength(5);
    expect(out.slice(0, 4)).toEqual(effectiveStatuses(cfg([])));
    expect(out[4]).toEqual({ symbol: "n", type: "NON_TASK", next: " " });
  });

  test("a custom symbol keeps its table position when it overrides a builtin meaning", () => {
    // Vault remaps `x` to a NON_TASK meaning: still 4 entries, `x` sits
    // in the DONE slot but carries the override.
    const out = effectiveStatuses(cfg([{ symbol: "x", type: "NON_TASK", next: " " }]));
    expect(out.map((s) => s.symbol)).toEqual([" ", "/", "x", "-"]);
    expect(out.find((s) => s.symbol === "x")!.type).toBe("NON_TASK");
  });

  test("uppercase X normalizes to lowercase x (kernel done-symbol case rule)", () => {
    const out = effectiveStatuses(cfg([{ symbol: "X", type: "DONE", next: " " }]));
    // Normalized `x` lands in the builtin `x` position — no separate
    // `X` entry.
    expect(out.map((s) => s.symbol)).toEqual([" ", "/", "x", "-"]);
    expect(out.find((s) => s.symbol === "x")!.next).toBe(" ");
  });

  test("duplicate symbols within the vault config resolve last-wins", () => {
    const out = effectiveStatuses(
      cfg([
        { symbol: "!", type: "TODO", next: "x" },
        { symbol: "!", type: "ON_HOLD", next: "/" },
      ]),
    );
    expect(out.filter((s) => s.symbol === "!")).toHaveLength(1);
    expect(out.find((s) => s.symbol === "!")!.type).toBe("ON_HOLD");
  });
});
