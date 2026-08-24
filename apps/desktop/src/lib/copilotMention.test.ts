import { expect, test } from "bun:test";

import { activeMentionToken, stripMentionToken } from "./copilotMention";

test("word-start @ opens a token that spans spaces up to caret", () => {
  expect(activeMentionToken("이거 @러닝 기록", 10)).toEqual({ start: 3, query: "러닝 기록" });
  expect(activeMentionToken("@rust", 5)).toEqual({ start: 0, query: "rust" });
});

test("mid-word @, newline in token, or empty query yields null", () => {
  expect(activeMentionToken("a@b", 3)).toBeNull(); // 단어 중간 @
  expect(activeMentionToken("메일 a@b.com", 10)).toBeNull();
  expect(activeMentionToken("이거 @러닝\n기록", 11)).toBeNull(); // 토큰 내 개행
  expect(activeMentionToken("@러닝", 1)).toBeNull(); // 캐럿이 @ 바로 뒤(쿼리 없음)
});

test("caret before the last @ falls back to an earlier word-start @", () => {
  // "@a @b" with caret right after "a " (pos 3): the active token is @a.
  expect(activeMentionToken("@a @b", 3)).toEqual({ start: 0, query: "a " });
});

test("strip removes the @token including the @", () => {
  expect(stripMentionToken("이거 @러닝 기록 나", { start: 3, query: "러닝 기록" })).toBe("이거  나");
  expect(stripMentionToken("@rust ", { start: 0, query: "rust" })).toBe(" ");
});
