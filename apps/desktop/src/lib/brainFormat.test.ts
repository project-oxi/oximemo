import { describe, expect, test } from "bun:test";

import { formatContradiction } from "./brainFormat";
import type { BrainContradictionItem } from "./api";

/**
 * Hostile wire shapes: the envelope crosses a brain version boundary, so
 * runtime values can violate the declared contract — typed as the UI
 * contract while the runtime value simulates the lie (mirrors
 * summaryFolder.test.ts's wire helper).
 */
const raw = (value: unknown): BrainContradictionItem => value as BrainContradictionItem;

describe("formatContradiction", () => {
  test("renders a full triple with string endpoints", () => {
    expect(
      formatContradiction({ statement: { subject: "커피", predicate: "수명을 늘린다", object: "수명" } }),
    ).toBe("커피 · 수명을 늘린다 · 수명");
  });

  test("reads {surface} object form", () => {
    expect(
      formatContradiction({ statement: { subject: "서울", predicate: "수도", object: { surface: "대한민국" } } }),
    ).toBe("서울 · 수도 · 대한민국");
  });

  test("reads {surface} subject form", () => {
    expect(
      formatContradiction({ statement: { subject: { surface: "A" }, predicate: "동일", object: "B" } }),
    ).toBe("A · 동일 · B");
  });

  test("omits missing endpoints and non-string predicates", () => {
    expect(formatContradiction({ statement: { subject: "A", object: "B" } })).toBe("A · B");
    expect(formatContradiction(raw({ statement: { subject: "A", predicate: 42, object: "B" } }))).toBe("A · B");
  });

  test("returns empty for unusable shapes", () => {
    expect(formatContradiction(raw({}))).toBe("");
    expect(formatContradiction(raw({ statement: null }))).toBe("");
    expect(formatContradiction(raw({ statement: "not-an-object" }))).toBe("");
    expect(
      formatContradiction(raw({ statement: { subject: null, predicate: null, object: { surface: 3 } } })),
    ).toBe("");
  });
});
