import { expect, test } from "bun:test";
import { reconcileEditorSource } from "./editorSource";

const original = { id: "note", body: "date: old", source_sha256: "sha256:original" };
const changed = { id: "note", body: "date: new", source_sha256: "sha256:changed" };

test("an idle editor adopts an external body together with its new save token", () => {
  const loaded = reconcileEditorSource(null, original, "note", false, false);
  expect(reconcileEditorSource(loaded, changed, "note", false, false)).toBe(changed);
});

test("a dirty draft retains its original token when the query cache refreshes", () => {
  const retained = reconcileEditorSource(original, changed, "note", true, false);
  expect(retained?.body).toBe("date: old");
  expect(retained?.source_sha256).toBe("sha256:original");
});

test("an in-flight save cannot adopt an unrelated external token", () => {
  expect(reconcileEditorSource(original, changed, "note", false, true)).toBe(original);
  expect(reconcileEditorSource(original, changed, "note", true, true)).toBe(original);
});

test("switching notes rejects a late read from the previous selection", () => {
  expect(reconcileEditorSource(original, changed, "other", false, false)).toBe(original);
  const other = { ...changed, id: "other" };
  expect(reconcileEditorSource(original, other, "other", true, true)).toBe(other);
});

test("closing clears the snapshot and a pending read keeps the current source", () => {
  expect(reconcileEditorSource(original, changed, null, false, false)).toBeNull();
  expect(reconcileEditorSource(original, undefined, "note", false, false)).toBe(original);
});
