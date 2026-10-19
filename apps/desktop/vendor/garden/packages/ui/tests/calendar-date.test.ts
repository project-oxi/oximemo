import { describe, expect, test } from "bun:test"

import {
  addDays,
  addMonths,
  clampMonthToRange,
  daysInMonth,
  formatISODate,
  monthIntersectsRange,
  monthStart,
  parseISODate,
  toLocalDate,
  weekday,
} from "../src/components/ui/calendar-date"

describe("calendar date helpers", () => {
  test("accept only real canonical dates and format them without timezone conversion", () => {
    expect(parseISODate("2024-02-29")).toEqual({ year: 2024, month: 2, day: 29 })
    expect(parseISODate("2023-02-29")).toBeUndefined()
    expect(parseISODate("2024-2-09")).toBeUndefined()
    expect(parseISODate("0000-01-01")).toBeUndefined()

    const date = parseISODate("2024-01-01")!
    const local = toLocalDate(date)
    expect([local.getFullYear(), local.getMonth() + 1, local.getDate()]).toEqual([2024, 1, 1])
    expect(formatISODate(date)).toBe("2024-01-01")
  })

  test("handles leap days and month-length clamping", () => {
    expect(daysInMonth(2000, 2)).toBe(29)
    expect(daysInMonth(1900, 2)).toBe(28)
    expect(formatISODate(addDays(parseISODate("2024-02-28")!, 1)!)).toBe("2024-02-29")
    expect(formatISODate(addDays(parseISODate("2024-02-29")!, 1)!)).toBe("2024-03-01")
    expect(formatISODate(addMonths(parseISODate("2024-01-31")!, 1)!)).toBe("2024-02-29")
    expect(formatISODate(addMonths(parseISODate("2023-03-31")!, -1)!)).toBe("2023-02-28")
  })

  test("calculates weekdays and rejects arithmetic outside supported ISO years", () => {
    expect(weekday(parseISODate("2024-01-01")!)).toBe(1)
    expect(weekday(parseISODate("2024-02-29")!)).toBe(4)
    expect(weekday(parseISODate("2023-01-01")!)).toBe(0)
    expect(addDays(parseISODate("0001-01-01")!, -1)).toBeUndefined()
    expect(addDays(parseISODate("9999-12-31")!, 1)).toBeUndefined()
    expect(addMonths(parseISODate("0001-01-15")!, -1)).toBeUndefined()
    expect(addMonths(parseISODate("9999-12-15")!, 1)).toBeUndefined()
  })

  test("clamps an initial month to reachable bounds and handles reversed bounds", () => {
    const may = parseISODate("2025-05-12")!
    const august = parseISODate("2025-08-03")!
    expect(formatISODate(clampMonthToRange(parseISODate("2024-01-01")!, may, august))).toBe("2025-05-01")
    expect(formatISODate(clampMonthToRange(parseISODate("2025-12-01")!, may, august))).toBe("2025-08-01")
    expect(clampMonthToRange(parseISODate("2025-06-20")!, may, august)).toEqual(monthStart(parseISODate("2025-06-20")!))
    expect(monthIntersectsRange(parseISODate("2025-06-01")!, may, august)).toBe(true)
    expect(monthIntersectsRange(parseISODate("2025-04-01")!, may, august)).toBe(false)
    expect(monthIntersectsRange(parseISODate("2025-06-01")!, august, may)).toBe(false)
  })
})
