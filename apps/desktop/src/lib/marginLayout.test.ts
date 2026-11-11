import { describe, expect, test } from "bun:test";

import { MARGIN_GAP, MARGIN_MAX, NO_MARGINS, marginLayout, sameMarginLayout } from "./marginLayout";

const base = { padLeft: 24, padRight: 24, readingWidth: 760 };

describe("marginLayout", () => {
  test("wide frame shows both margins hugging the body, capped width", () => {
    const l = marginLayout({ ...base, outerWidth: 1600, clientWidth: 1600 });
    const gutter = (1600 - 48 - 760) / 2;
    expect(l.left).toEqual({ inset: 24 + gutter - MARGIN_GAP - MARGIN_MAX, width: MARGIN_MAX });
    expect(l.right).toEqual({ inset: 24 + gutter - MARGIN_GAP - MARGIN_MAX, width: MARGIN_MAX });
  });

  test("narrowing drops the right margin before the left", () => {
    const mid = marginLayout({ ...base, outerWidth: 1180, clientWidth: 1180 });
    expect(mid.left).not.toBeNull();
    expect(mid.right).toBeNull();
    const narrow = marginLayout({ ...base, outerWidth: 1100, clientWidth: 1100 });
    expect(narrow).toEqual({ left: null, right: null });
  });

  test("measures the content box, so a copilot padding shrinks the margins", () => {
    const l = marginLayout({ ...base, padRight: 428, outerWidth: 1500, clientWidth: 1500 });
    expect(l.right).toBeNull();
  });

  test("right inset skips the scrollbar", () => {
    const l = marginLayout({ ...base, outerWidth: 1612, clientWidth: 1600 });
    expect(l.right!.inset - l.left!.inset).toBe(12);
  });

  test("degenerate input yields no margins", () => {
    expect(marginLayout({ ...base, outerWidth: 0, clientWidth: 0 })).toEqual({ left: null, right: null });
    expect(marginLayout({ ...base, readingWidth: 0, outerWidth: 1600, clientWidth: 1600 })).toEqual({ left: null, right: null });
  });
});

describe("sameMarginLayout", () => {
  test("compares by value", () => {
    const a = marginLayout({ ...base, outerWidth: 1600, clientWidth: 1600 });
    const b = marginLayout({ ...base, outerWidth: 1600, clientWidth: 1600 });
    expect(sameMarginLayout(a, b)).toBe(true);
    expect(sameMarginLayout(a, NO_MARGINS)).toBe(false);
    expect(sameMarginLayout(NO_MARGINS, { left: null, right: null })).toBe(true);
  });
});
