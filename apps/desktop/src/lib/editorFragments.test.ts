import { test, expect } from "bun:test";
import { Text } from "@codemirror/state";
import { fragmentPosition } from "./editorFragments";

test("wiki heading and block fragments select the authored line", () => {
  const doc = Text.of(["# 시작", "", "## 두 번째 제목", "문단 ^abc123"]);
  expect(fragmentPosition(doc, "두-번째-제목")).toBe(doc.line(3).from);
  expect(fragmentPosition(doc, "^abc123")).toBe(doc.line(4).from);
});
