import { describe, expect, test } from "bun:test";
import { caretScrollDelta } from "./cm6OuterScroll";

describe("document-flow caret scrolling", () => {
  const viewport = { top: 65, bottom: 679 };

  test("a visible clicked line and horizontal movement need no scroll", () => {
    expect(caretScrollDelta({ top: 94, bottom: 113 }, viewport)).toBe(0);
    expect(caretScrollDelta({ top: 300, bottom: 319 }, viewport)).toBe(0);
  });

  test("keyboard movement exposes only the missing edge", () => {
    expect(caretScrollDelta({ top: 55, bottom: 74 }, viewport)).toBe(-34);
    expect(caretScrollDelta({ top: 670, bottom: 689 }, viewport)).toBe(34);
  });

  test("short windows retain space for the actual caret", () => {
    const short = { top: 100, bottom: 140 };
    expect(caretScrollDelta({ top: 106, bottom: 126 }, short)).toBe(0);
    expect(caretScrollDelta({ top: 90, bottom: 110 }, short)).toBe(-15);
    expect(caretScrollDelta({ top: 130, bottom: 150 }, short)).toBe(15);
    expect(caretScrollDelta({ top: 100, bottom: 120 }, { top: 100, bottom: 100 })).toBe(0);
  });
});
