import { expect, test } from "bun:test";

import { appendLink, appendTag } from "./suggestApply";

test("appendTag appends #tag on its own final line", () => {
  expect(appendTag("본문", "태그")).toBe("본문\n#태그");
  // Trailing newlines collapse to exactly one separator (LF convention).
  expect(appendTag("본문\n\n\n", "태그")).toBe("본문\n#태그");
});

test("appendTag returns null for a tag the body already has", () => {
  expect(appendTag("메모\n#foo", "foo")).toBeNull();
  // extractTags normalizes NFC + lowercase, so the check matches both.
  expect(appendTag("메모\n#Foo", "foo")).toBeNull();
  expect(appendTag("메모\n#foo", "FOO")).toBeNull();
  expect(appendTag("#foobar", "foo")).toBe("#foobar\n#foo");
});

test("appendTag sanitizes surrounding whitespace", () => {
  expect(appendTag("본문", "  태그  ")).toBe("본문\n#태그");
  expect(appendTag("본문", "   ")).toBeNull();
  expect(appendTag("본문", "")).toBeNull();
});

test("appendLink appends [[title]] on its own final line", () => {
  expect(appendLink("메모", "두 번째 노트")).toBe("메모\n[[두 번째 노트]]");
  expect(appendLink("메모\n", "두 번째 노트")).toBe("메모\n[[두 번째 노트]]");
});

test("appendLink returns null when the link already exists", () => {
  expect(appendLink("메모\n[[두 번째 노트]]", "두 번째 노트")).toBeNull();
  // Exact match only — [[두 번째]] must not block [[두 번째 노트]].
  expect(appendLink("메모\n[[두 번째]]", "두 번째 노트")).toBe("메모\n[[두 번째]]\n[[두 번째 노트]]");
  expect(appendLink("메모", "  ")).toBeNull();
});
