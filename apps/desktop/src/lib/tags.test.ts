import { expect, test } from "bun:test";
import { extractTags, highlightTags } from "./tags";

test("hyphenated and nested tags stay intact and share normalized identity", () => {
  expect(extractTags("#ui-audit #UI-AUDIT #프로젝트/ui-test, #other."))
    .toEqual(["ui-audit", "프로젝트/ui-test", "other"]);
});

test("highlight spans include the whole tag without consuming punctuation", () => {
  const body = "문장 #UI-Audit, #프로젝트/ui-test!";
  const spans = highlightTags(body);
  expect(spans.filter((s) => s.tag).map((s) => s.text))
    .toEqual(["#UI-Audit", "#프로젝트/ui-test"]);
  expect(spans.map((s) => s.text).join("")).toBe(body);
});

test("headings, chord symbols and punctuation alone do not become tags", () => {
  expect(extractTags("# Heading\nC#m7 F#m7 #--- #/")).toEqual([]);
  expect(extractTags("- #todo-list #a-b#c")).toEqual(["todo-list", "a-b"]);
});
