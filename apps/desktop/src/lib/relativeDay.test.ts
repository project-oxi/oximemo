import { afterEach, describe, expect, jest, test } from "bun:test";

import { dayTone, relativeDayLabel, todayKeyStore } from "./relativeDay";

const TODAY = "2026-08-28";

describe("relativeDayLabel", () => {
  test("±1 day words", () => {
    expect(relativeDayLabel(TODAY, TODAY, "ko")).toBe("오늘");
    expect(relativeDayLabel("2026-08-29", TODAY, "ko")).toBe("내일");
    expect(relativeDayLabel("2026-08-27", TODAY, "ko")).toBe("어제");
    expect(relativeDayLabel(TODAY, TODAY, "en")).toBe("Today");
    expect(relativeDayLabel("2026-08-29", TODAY, "en")).toBe("Tomorrow");
    expect(relativeDayLabel("2026-08-27", TODAY, "en")).toBe("Yesterday");
  });

  test("same-year future date renders locale month-day, never raw ISO", () => {
    expect(relativeDayLabel("2026-08-30", TODAY, "ko")).toBe("8월 30일");
    expect(relativeDayLabel("2026-08-30", TODAY, "en")).toBe("Aug 30");
  });

  test("other-year date includes the year", () => {
    expect(relativeDayLabel("2027-01-02", "2026-12-30", "ko")).toBe("2027년 1월 2일");
    expect(relativeDayLabel("2027-01-02", "2026-12-30", "en")).toBe("Jan 2, 2027");
  });

  test("overdue dates count days past", () => {
    expect(relativeDayLabel("2026-08-25", TODAY, "ko")).toBe("3일 지남");
    expect(relativeDayLabel("2026-08-25", TODAY, "en")).toBe("3d ago");
    expect(relativeDayLabel("2026-08-26", TODAY, "ko")).toBe("2일 지남");
  });
});

describe("dayTone", () => {
  test("past is overdue, today is today, tomorrow and later are future", () => {
    expect(dayTone("2026-08-27", TODAY)).toBe("overdue");
    expect(dayTone(TODAY, TODAY)).toBe("today");
    expect(dayTone("2026-08-29", TODAY)).toBe("future");
    expect(dayTone("2026-12-31", TODAY)).toBe("future");
  });
});

describe("todayKeyStore (shared midnight timer)", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("flips the key and notifies subscribers at local midnight", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 7, 28, 23, 59, 0));
    expect(todayKeyStore.get()).toBe("2026-08-28");

    let fired = 0;
    const unsub = todayKeyStore.subscribe(() => fired++);
    jest.advanceTimersByTime(60_000 + 100);
    expect(fired).toBe(1);

    jest.setSystemTime(new Date(2026, 7, 29, 0, 0, 5));
    expect(todayKeyStore.get()).toBe("2026-08-29");
    unsub();
  });

  test("clears the timer when the last subscriber leaves", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 7, 28, 23, 0, 0));

    let fired = 0;
    const unsub = todayKeyStore.subscribe(() => fired++);
    unsub();
    jest.advanceTimersByTime(3_600_000);
    expect(fired).toBe(0);
  });
});
