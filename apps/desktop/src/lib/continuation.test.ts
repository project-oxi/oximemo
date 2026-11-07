import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { continuationCheck, continuationPrefix, continuationSource, type ContinuationSource } from "./continuation";

function state(doc: string, cursor?: number) {
  return EditorState.create({
    doc,
    selection: { anchor: cursor ?? doc.length },
  });
}

/** A fake view is fine: the helpers judge staleness by object identity
 *  alone, exactly like the component does with the real EditorView. */
function view(s: EditorState) {
  return { state: s };
}

const sample = "첫 문장.\n\n둘째 줄 😀";

test("prefix is the exact bytes from the start up to the cursor", () => {
  const v = view(state(sample, 5));
  const src = continuationSource(v);
  expect(continuationPrefix(src)).toBe(sample.slice(0, 5));
});

test("prefix at the doc start is explicitly empty (sent as \"\", not absent)", () => {
  const src = continuationSource(view(state(sample, 0)));
  expect(continuationPrefix(src)).toBe("");
});

test("prefix includes an unsaved continuation inserted before the next request", () => {
  const first = state(sample, sample.length);
  // The continuation landed at the cursor (unsaved); the next request
  // must see it instead of re-reading stale disk.
  const second = first.update({
    changes: { from: sample.length, insert: " 이어지는 문장." },
    selection: { anchor: sample.length + " 이어지는 문장.".length },
  }).state;
  const src = continuationSource(view(second));
  expect(continuationPrefix(src)).toBe(`${sample} 이어지는 문장.`);
});

test("multi-byte offsets: prefix counts UTF-16 units, emoji-safe", () => {
  const v = view(state("😀😀 tail", 4));
  expect(continuationPrefix(continuationSource(v))).toBe("😀😀");
});

test("applies when the same view and doc come back after the await", () => {
  const s = state(sample, 4);
  const current = view(s);
  const src = continuationSource(current);
  expect(continuationCheck(src, current)).toBe("apply");
});

test("a selection move without an edit still applies at the request source", () => {
  const s = state(sample, 4);
  const current = view(s);
  const src = continuationSource(current);
  const moved = s.update({ selection: { anchor: sample.length } }).state;
  current.state = moved;
  expect(moved.doc).toBe(src.doc);
  expect(continuationCheck(src, current)).toBe("apply");
});

test("an edit after the request swaps the doc instance — stale", () => {
  const s = state(sample, 4);
  const current = view(s);
  const src: ContinuationSource = continuationSource(current);
  const edited = s.update({ changes: { from: 2, to: 3, insert: "" } }).state;
  current.state = edited;
  expect(edited.doc).not.toBe(src.doc);
  expect(continuationCheck(src, current)).toBe("stale");
});

test("a note switch remounts the view — stale even with identical text", () => {
  const src = continuationSource(view(state(sample, 4)));
  const twin = view(state(sample, 4));
  expect(continuationCheck(src, twin)).toBe("stale");
});
