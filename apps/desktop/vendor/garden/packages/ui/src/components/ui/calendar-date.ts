export interface CalendarDate {
  year: number
  month: number
  day: number
}

export function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

export function daysInMonth(year: number, month: number) {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

export function parseISODate(value?: string): CalendarDate | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const [year, month, day] = value.split("-").map(Number)
  if (
    year === undefined || month === undefined || day === undefined ||
    year < 1 || month < 1 || month > 12 || day < 1 ||
    day > daysInMonth(year, month)
  ) return undefined
  return { year, month, day }
}

export function formatISODate(date: CalendarDate) {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`
}

export function compareDates(left: CalendarDate, right: CalendarDate) {
  return left.year - right.year || left.month - right.month || left.day - right.day
}

export function sameDate(left: CalendarDate, right: CalendarDate) {
  return compareDates(left, right) === 0
}

export function monthStart(date: CalendarDate): CalendarDate {
  return { year: date.year, month: date.month, day: 1 }
}

export function clampMonthToRange(
  month: CalendarDate,
  min?: CalendarDate,
  max?: CalendarDate
) {
  const candidate = monthStart(month)
  if (min && max && compareDates(min, max) > 0) return candidate

  const last = {
    year: candidate.year,
    month: candidate.month,
    day: daysInMonth(candidate.year, candidate.month),
  }
  if (min && compareDates(last, min) < 0) return monthStart(min)
  if (max && compareDates(candidate, max) > 0) return monthStart(max)
  return candidate
}

export function monthIntersectsRange(
  month: CalendarDate | undefined,
  min?: CalendarDate,
  max?: CalendarDate
) {
  if (!month || (min && max && compareDates(min, max) > 0)) return false
  const first = monthStart(month)
  const last = { year: first.year, month: first.month, day: daysInMonth(first.year, first.month) }
  return (!min || compareDates(last, min) >= 0) &&
    (!max || compareDates(first, max) <= 0)
}

export function addDays(date: CalendarDate, amount: number): CalendarDate | undefined {
  if (!Number.isInteger(amount)) return undefined
  let { year, month, day } = date
  let remaining = amount

  while (remaining > 0) {
    const daysRemaining = daysInMonth(year, month) - day
    if (remaining <= daysRemaining) {
      day += remaining
      remaining = 0
    } else {
      remaining -= daysRemaining + 1
      day = 1
      if (month === 12) {
        if (year === 9999) return undefined
        year += 1
        month = 1
      } else month += 1
    }
  }

  while (remaining < 0) {
    if (day + remaining >= 1) {
      day += remaining
      remaining = 0
    } else {
      remaining += day
      if (month === 1) {
        if (year === 1) return undefined
        year -= 1
        month = 12
      } else month -= 1
      day = daysInMonth(year, month)
    }
  }

  return { year, month, day }
}

export function addMonths(date: CalendarDate, amount: number): CalendarDate | undefined {
  if (!Number.isInteger(amount)) return undefined
  const absoluteMonth = (date.year - 1) * 12 + date.month - 1 + amount
  const year = Math.floor(absoluteMonth / 12) + 1
  const month = ((absoluteMonth % 12) + 12) % 12 + 1
  if (year < 1 || year > 9999) return undefined
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) }
}

/** Sunday = 0, matching Date#getDay, calculated without parsing or UTC conversion. */
export function weekday(date: CalendarDate) {
  const previousYear = date.year - 1
  let dayNumber = previousYear * 365 + Math.floor(previousYear / 4) - Math.floor(previousYear / 100) + Math.floor(previousYear / 400)
  for (let month = 1; month < date.month; month += 1) {
    dayNumber += daysInMonth(date.year, month)
  }
  dayNumber += date.day - 1
  return (dayNumber + 1) % 7
}

export function todayLocal(): CalendarDate {
  const today = new Date()
  return { year: today.getFullYear(), month: today.getMonth() + 1, day: today.getDate() }
}

/** Creates a local-noon Date for Intl formatting without interpreting an ISO string as UTC. */
export function toLocalDate(date: CalendarDate) {
  const localDate = new Date(2000, 0, 1, 12)
  localDate.setFullYear(date.year, date.month - 1, date.day)
  return localDate
}

export function formatLocalDate(
  date: CalendarDate,
  locale: "en" | "ko",
  options: Intl.DateTimeFormatOptions
) {
  return new Intl.DateTimeFormat(locale, options).format(toLocalDate(date))
}
