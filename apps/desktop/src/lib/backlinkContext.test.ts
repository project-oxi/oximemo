import { describe, expect, test } from "bun:test";

import { aliasList, backlinkContextLine } from "./backlinkContext";

describe("backlinkContextLine", () => {
  test("picks the line that links here, rewriting links to text", () => {
    const preview = "# 데일리\n\n오늘 한 일\n창 테두리는 [[Tauri 창]] 에서 [[다른|별칭]] 참고";
    expect(backlinkContextLine(preview, ["Tauri 창"])).toBe("창 테두리는 Tauri 창 에서 별칭 참고");
  });

  test("matches case-insensitively and through heading / block refs and labels", () => {
    expect(backlinkContextLine("see [[tauri 창#버튼|버튼 절]]", ["Tauri 창"])).toBe("see 버튼 절");
    expect(backlinkContextLine("embed ![[Tauri 창^b1]]", ["Tauri 창"])).toBe("embed Tauri 창^b1");
  });

  test("accepts aliases as extra targets", () => {
    expect(backlinkContextLine("a [[TW]] b", ["Tauri 창", "TW"])).toBe("a TW b");
  });

  test("null when no line links here", () => {
    expect(backlinkContextLine("[[Other]] only", ["Tauri 창"])).toBeNull();
    expect(backlinkContextLine("plain", [])).toBeNull();
    expect(backlinkContextLine("", ["x"])).toBeNull();
  });
});

describe("aliasList", () => {
  test("list, single string, or nothing", () => {
    expect(aliasList(["TW", " ", 3, "창"])).toEqual(["TW", "창"]);
    expect(aliasList(" TW ")).toEqual(["TW"]);
    expect(aliasList(undefined)).toEqual([]);
    expect(aliasList({})).toEqual([]);
  });
});
