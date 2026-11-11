import { describe, expect, test } from "bun:test";

import { localDayKey, recencyBand, splitByRecency } from "./recencyBands";

/** 로컬 시각으로 ISO 문자열을 만든다 — 테스트가 어느 시간대에서 돌든 같은 로컬 날짜를 가리키게. */
function local(y: number, m: number, d: number, h = 12): string {
  return new Date(y, m - 1, d, h).toISOString();
}

// 2026-11-11 은 수요일 → 이번 주 = 11/08(일) ~ 11/11.
const TODAY = "2026-11-11";

describe("recencyBand", () => {
  test("오늘 · 로컬 자정 직후도 오늘", () => {
    expect(recencyBand(local(2026, 11, 11, 0), TODAY)).toBe("today");
    expect(recencyBand(local(2026, 11, 11, 23), TODAY)).toBe("today");
  });
  test("이번 주는 일요일부터", () => {
    expect(recencyBand(local(2026, 11, 10), TODAY)).toBe("week");
    expect(recencyBand(local(2026, 11, 8, 0), TODAY)).toBe("week");
    expect(recencyBand(local(2026, 11, 7, 23), TODAY)).toBe("older");
  });
  test("일요일이 오늘이면 이번 주 띠는 비어 있다", () => {
    expect(recencyBand(local(2026, 11, 7), "2026-11-08")).toBe("older");
  });
  test("미래 시각은 오늘 · 읽을 수 없는 시각은 그 이전", () => {
    expect(recencyBand(local(2026, 11, 20), TODAY)).toBe("today");
    expect(recencyBand("not a date", TODAY)).toBe("older");
    expect(localDayKey("")).toBeNull();
  });
});

describe("splitByRecency", () => {
  test("빈 목록", () => {
    expect(splitByRecency([], TODAY)).toEqual({ today: [], week: [], older: [] });
  });
  test("입력 순서를 띠 안에서 지킨다", () => {
    const notes = [
      { id: "a", updated_at: local(2026, 11, 11, 15) },
      { id: "b", updated_at: local(2026, 11, 11, 9) },
      { id: "c", updated_at: local(2026, 11, 9) },
      { id: "d", updated_at: local(2026, 10, 2) },
      { id: "e", updated_at: local(2025, 8, 30) },
    ];
    const s = splitByRecency(notes, TODAY);
    expect(s.today.map((n) => n.id)).toEqual(["a", "b"]);
    expect(s.week.map((n) => n.id)).toEqual(["c"]);
    expect(s.older.map((n) => n.id)).toEqual(["d", "e"]);
  });
});
