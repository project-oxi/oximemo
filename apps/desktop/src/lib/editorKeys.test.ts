import { expect, test } from "bun:test";
import { isComposingKey, isSaveAndCloseChord, isSaveAndCloseKey } from "./editorKeys";

const key = {
  key: "Enter", keyCode: 13, isComposing: false, defaultPrevented: false,
  metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false,
};

test("only an unhandled save shortcut finishes the note", () => {
  expect(isSaveAndCloseKey(key)).toBe(true);
  expect(isSaveAndCloseKey({ ...key, metaKey: false, ctrlKey: true })).toBe(true);
  for (const patch of [
    { metaKey: false }, { shiftKey: true }, { altKey: true }, { repeat: true },
    { key: "ArrowDown" }, { defaultPrevented: true },
  ]) expect(isSaveAndCloseKey({ ...key, ...patch })).toBe(false);
});

test("IME confirmation never saves, closes, or opens a global shortcut", () => {
  expect(isComposingKey(key)).toBe(false);
  for (const patch of [{ isComposing: true }, { keyCode: 229 }]) {
    expect(isComposingKey({ ...key, ...patch })).toBe(true);
    expect(isSaveAndCloseKey({ ...key, ...patch })).toBe(false);
  }
});

test("holding save consumes the chord without repeatedly finishing", () => {
  expect(isSaveAndCloseChord({ ...key, repeat: true })).toBe(true);
  expect(isSaveAndCloseKey({ ...key, repeat: true })).toBe(false);
  expect(isSaveAndCloseChord({ ...key, shiftKey: true })).toBe(false);
  expect(isSaveAndCloseChord({ ...key, metaKey: false })).toBe(false);
});
