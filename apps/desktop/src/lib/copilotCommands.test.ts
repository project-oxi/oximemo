import { expect, test } from "bun:test";

import { commandList, expandCommand, filterCommands } from "./copilotCommands";
import { dict as ko } from "./locales/ko";
import type { Dict } from "./i18n";

const t = ko as unknown as Dict;

test("command list has 5 commands with non-empty label and desc", () => {
  const list = commandList(t);
  expect(list.map((c) => c.id)).toEqual(["summary", "tags", "tidy", "find", "new"]);
  for (const c of list) {
    expect(c.label.length).toBeGreaterThan(0);
    expect(c.desc.length).toBeGreaterThan(0);
  }
});

test("summary/tags templates switch on active memo; find/new end at the cursor", () => {
  const withMemo = expandCommand("summary", { hasActiveMemo: true, t });
  const without = expandCommand("summary", { hasActiveMemo: false, t });
  expect(withMemo).toContain("열린 노트");
  expect(without).not.toContain("열린 노트");
  expect(expandCommand("tags", { hasActiveMemo: true, t })).toContain("태그");
  expect(expandCommand("find", { hasActiveMemo: false, t }).endsWith(": ")).toBe(true);
  expect(expandCommand("new", { hasActiveMemo: true, t }).endsWith(": ")).toBe(true);
});

test("filterCommands matches label substring, case-insensitive, empty = all", () => {
  const list = commandList(t);
  expect(filterCommands("태그", list).map((c) => c.id)).toEqual(["tags"]);
  expect(filterCommands("", list)).toHaveLength(5);
});
