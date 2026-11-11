import { expect, test } from "bun:test";
import { bodyTags, extractTags, highlightTags, mergeTags } from "./tags";

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

test("mergeTags keeps stored spelling and order, appends unseen derived tags", () => {
  expect(mergeTags(["UI-Audit", "프로젝트/Note"], ["ui-audit", "프로젝트/note", "extra"]))
    .toEqual(["UI-Audit", "프로젝트/Note", "ui-audit", "프로젝트/note", "extra"]);
  expect(mergeTags(["keep"], [])).toEqual(["keep"]);
  expect(mergeTags([], ["b", "a", "b"])).toEqual(["b", "a"]);
});

test("mergeTags dedupes on the NFC form, case-sensitively", () => {
  expect(mergeTags(["café"], ["cafe\u0301"])).toEqual(["café"]);
  expect(mergeTags(["Food"], ["food"])).toEqual(["Food", "food"]);
  expect(mergeTags(["café", "cafe\u0301"], ["café"])).toEqual(["café", "cafe\u0301"]);
});

test("bodyTags markdown path delegates to extractTags", () => {
  const body = "회의록 #work\nC#m7 무관 #other.";
  expect(bodyTags(body)).toEqual(extractTags(body));
  expect(bodyTags(body, "markdown")).toEqual(["work", "other"]);
});

// bun's test runtime has no DOM; same skip convention as
// chatMarkdown.test.ts — the HTML template path is browser-only.
(test.skipIf(typeof document === "undefined"))("bodyTags html strips tags before scanning", () => {
  expect(bodyTags('<p>see <a href="#section">link</a></p><p>#real 태그</p>', "html"))
    .toEqual(["real"]);
  expect(bodyTags("<style>#css { color: #fff }</style><b>#bold</b> 나머지", "html"))
    .toEqual(["bold"]);
  expect(bodyTags("<!-- +++ tags: [not-a-tag] +++ -->\n<p>#본문</p>", "html"))
    .toEqual(["본문"]);
  expect(bodyTags("<p>#first<br>#second</p><p>&#35;third</p>", "html"))
    .toEqual(["first", "second", "third"]);
});
