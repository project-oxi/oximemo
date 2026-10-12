import { expect, test } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { emphasisClosingPosition } from "./editorTyping";

function state(doc: string, at: number) {
  return EditorState.create({ doc, selection: { anchor: at }, extensions: markdown({ base: markdownLanguage }) });
}

test("typing both auto-inserted bold closers advances without changing source", () => {
  let input = state("A **굵게** word", 6);
  expect(emphasisClosingPosition(input, 6, 6, "*")).toBe(7);
  input = input.update({ selection: { anchor: 7 } }).state;
  expect(emphasisClosingPosition(input, 7, 7, "*")).toBe(8);
  expect(input.doc.toString()).toBe("A **굵게** word");
});

test("italic and nested emphasis consume only their own closing mark", () => {
  expect(emphasisClosingPosition(state("_글_", 2), 2, 2, "_")).toBe(3);
  expect(emphasisClosingPosition(state("**굵게 *기울임***", 9), 9, 9, "*")).toBe(10);
});

test("empty pairs, prose underscores and code retain literal input", () => {
  for (const [doc, at, char] of [
    ["**", 1, "*"], ["snake_case_", 10, "_"],
    ["`**code**`", 7, "*"], ["```md\n**code**\n```", 12, "*"],
  ] as const) expect(emphasisClosingPosition(state(doc, at), at, at, char)).toBeNull();
  expect(emphasisClosingPosition(state("**글**", 3), 3, 3, "_")).toBeNull();
});

test("replacing a selection retains normal input behavior", () => {
  const input = state("**글**", 3).update({ selection: EditorSelection.range(2, 3) }).state;
  expect(emphasisClosingPosition(input, 2, 3, "*")).toBeNull();
});
