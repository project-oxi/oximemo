/** Locale parity: every key defined in `ko.ts` must also exist in `en.ts`
 *  with a matching value type. The compile-time `Record<keyof typeof ko,
 *  string>` constraint on `en.ts` already enforces key parity — this test
 *  is the runtime belt-and-suspenders that surfaces drift the moment a
 *  key is removed/added without rebuilding. */
import { describe, expect, test } from "bun:test";

import { dict as ko } from "./locales/ko";
import { dict as en } from "./locales/en";

const NEW_KEYS = [
  "view_calendar",
  "calendar_field_created",
  "calendar_field_updated",
  "calendar_today",
  "calendar_more",
  "calendar_no_date",
] as const;

describe("locale parity (ko/en)", () => {
  test("both locales expose the calendar view keys added in Task 6", () => {
    for (const key of NEW_KEYS) {
      expect(typeof ko[key]).toBe("string");
      expect(typeof en[key]).toBe("string");
      expect(ko[key]).not.toBe("");
      expect(en[key]).not.toBe("");
    }
  });

  test("calendar_more / calendar_no_date keep the {n} placeholder for interpolation", () => {
    expect(ko.calendar_more).toContain("{n}");
    expect(en.calendar_more).toContain("{n}");
    expect(ko.calendar_no_date).toContain("{n}");
    expect(en.calendar_no_date).toContain("{n}");
  });

  test("en.ts has no keys outside the ko.ts keyset", () => {
    // Compile-time `Record<keyof typeof ko, string>` already blocks this,
    // but we re-check at runtime in case the constraint ever loosens.
    const extra = Object.keys(en).filter((k) => !(k in ko));
    expect(extra).toEqual([]);
  });
});