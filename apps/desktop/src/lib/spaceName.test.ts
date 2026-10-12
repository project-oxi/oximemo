import { describe, expect, test } from "bun:test";
import { validSpaceName } from "./spaceName";

describe("space name validation", () => {
  test("trims identifiers and accepts letters, numbers, hyphens and underscores", () => {
    for (const name of [" personal ", "업무-2026_기록", "café", "①", "\u0345"])
      expect(validSpaceName(name)).toBe(true);
  });

  test("rejects empty names, whitespace within names and path punctuation", () => {
    for (const name of ["", " \n ", "two words", "a/b", "a\\b", "a.b", "😊"])
      expect(validSpaceName(name)).toBe(false);
  });

  test("counts Unicode scalars at the backend's 64-character boundary", () => {
    for (const character of ["a", "가", "\u{10400}"]) {
      expect(validSpaceName(character.repeat(64))).toBe(true);
      expect(validSpaceName(character.repeat(65))).toBe(false);
    }
  });
});
