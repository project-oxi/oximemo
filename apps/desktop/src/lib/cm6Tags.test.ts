import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { inlineTagDecorations } from "./cm6Tags";

function state(doc: string) {
  return EditorState.create({ doc, extensions: markdown({ base: markdownLanguage }) });
}
function tags(input: EditorState, from = 0, to = input.doc.length) {
  const found: string[] = [];
  inlineTagDecorations(input, from, to).between(from, to, (start, end) => {
    found.push(input.sliceDoc(start, end));
  });
  return found;
}

test("inline tags retain Unicode offsets, spelling, hierarchy and punctuation boundaries", () => {
  const input = state("# 서울은 어지러워서\n\n😀 #writing #Novel, #프로젝트/ui-test!\nC#m7 #---");
  expect(tags(input)).toEqual(["#writing", "#Novel", "#프로젝트/ui-test"]);
});

test("code, escaped hashes, links and raw HTML remain literal", () => {
  const input = state([
    "`#inline` \\#escaped [#label](https://example.org/#fragment)",
    "<span title=\"#attribute\">#visible</span>",
    "", "```md", "#fenced", "```", "", "    #indented", "", "#actual",
  ].join("\n"));
  expect(tags(input)).toEqual(["#visible", "#actual"]);
});

test("editing a tag or undoing it updates the decoration without rewriting source", () => {
  const original = state("#writing #novel");
  const edited = original.update({ changes: { from: 9, to: 10, insert: "" } }).state;
  expect(tags(edited)).toEqual(["#writing"]);
  expect(edited.doc.toString()).toBe("#writing novel");
  const restored = edited.update({ changes: { from: 9, insert: "#" } }).state;
  expect(tags(restored)).toEqual(["#writing", "#novel"]);
  expect(restored.doc.toString()).toBe(original.doc.toString());
});

test("a viewport starting inside a line keeps full tag and preceding-character context", () => {
  const input = state("前😀 #프로젝트/ui-test, C#m7 #later\n#next");
  expect(tags(input, 7, 22)).toEqual(["#프로젝트/ui-test"]);
});
