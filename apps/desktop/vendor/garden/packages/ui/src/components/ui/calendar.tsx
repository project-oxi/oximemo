import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { cn } from "../../lib/utils"
import {
  addDays,
  addMonths,
  clampMonthToRange,
  compareDates,
  daysInMonth,
  formatISODate,
  formatLocalDate,
  monthIntersectsRange,
  monthStart,
  parseISODate,
  sameDate,
  todayLocal,
  weekday,
  type CalendarDate,
} from "./calendar-date"

export interface CalendarProps {
  label: string
  value?: string
  onValueChange: (value: string) => void
  locale: "en" | "ko"
  previousLabel: string
  nextLabel: string
  min?: string
  max?: string
  defaultMonth?: string
  className?: string
  disabled?: boolean
}

function parseMonth(value?: string) {
  return parseISODate(value) ?? parseISODate(value ? `${value}-01` : undefined)
}

function dayId(instanceId: string, date: CalendarDate) {
  return `${instanceId}-day-${formatISODate(date)}`
}

function Calendar({
  label,
  value,
  onValueChange,
  locale,
  previousLabel,
  nextLabel,
  min,
  max,
  defaultMonth,
  className,
  disabled = false,
}: CalendarProps) {
  const instanceId = React.useId()
  const [uncontrolledValue, setUncontrolledValue] = React.useState<string | undefined>(undefined)
  const isControlled = value !== undefined
  const selectedDate = parseISODate(isControlled ? value : uncontrolledValue)
  const minDate = parseISODate(min)
  const maxDate = parseISODate(max)
  const initialDate = selectedDate ?? parseMonth(defaultMonth) ?? todayLocal()
  const [viewMonth, setViewMonth] = React.useState(() => clampMonthToRange(initialDate, minDate, maxDate))
  const [focusedDate, setFocusedDate] = React.useState(() =>
    formatISODate(selectedDate ?? monthStart(initialDate))
  )
  const dayRefs = React.useRef(new Map<string, HTMLButtonElement>())
  const lastControlledValue = React.useRef(value)

  React.useEffect(() => {
    if (!isControlled || value === undefined || lastControlledValue.current === value) return
    lastControlledValue.current = value
    const nextDate = parseISODate(value)
    if (!nextDate) return
    setViewMonth(clampMonthToRange(nextDate, minDate, maxDate))
    setFocusedDate(formatISODate(nextDate))
  }, [isControlled, max, min, value])

  React.useEffect(() => {
    const boundedMonth = clampMonthToRange(viewMonth, minDate, maxDate)
    if (!sameDate(boundedMonth, viewMonth)) setViewMonth(boundedMonth)
  }, [max, min, viewMonth.month, viewMonth.year])

  const weekStartsOn = 0
  const selectable = (date: CalendarDate) =>
    !disabled &&
    (!minDate || compareDates(date, minDate) >= 0) &&
    (!maxDate || compareDates(date, maxDate) <= 0)

  const firstOfMonth = monthStart(viewMonth)
  const leadingDays = (weekday(firstOfMonth) - weekStartsOn + 7) % 7
  const gridDates = Array.from({ length: 42 }, (_, index) =>
    addDays(firstOfMonth, index - leadingDays)
  )
  const visibleFocusDate = (() => {
    const parsedFocus = parseISODate(focusedDate)
    if (parsedFocus && selectable(parsedFocus) && gridDates.some((date) => date && sameDate(date, parsedFocus))) {
      return parsedFocus
    }
    return gridDates.find((date) => date && date.month === viewMonth.month && date.year === viewMonth.year && selectable(date)) ??
      gridDates.find((date) => date && selectable(date))
  })()

  React.useEffect(() => {
    const nextFocus = visibleFocusDate ? formatISODate(visibleFocusDate) : ""
    if (focusedDate !== nextFocus) setFocusedDate(nextFocus)
  }, [focusedDate, visibleFocusDate?.year, visibleFocusDate?.month, visibleFocusDate?.day])

  const monthLabel = formatLocalDate(viewMonth, locale, { month: "long", year: "numeric" })
  const today = todayLocal()
  const weekDays = Array.from({ length: 7 }, (_, index) => {
    const sundayFirst = { year: 2024, month: 1, day: 7 + index }
    return {
      short: formatLocalDate(sundayFirst, locale, { weekday: "short" }),
      full: formatLocalDate(sundayFirst, locale, { weekday: "long" }),
    }
  })
  const orderedWeekDays = [
    ...weekDays.slice(weekStartsOn),
    ...weekDays.slice(0, weekStartsOn),
  ]

  const monthHasSelectableDate = (month: CalendarDate | undefined) => {
    return !disabled && monthIntersectsRange(month, minDate, maxDate)
  }
  const previousMonth = addMonths(viewMonth, -1)
  const nextMonth = addMonths(viewMonth, 1)
  const previousDisabled = !monthHasSelectableDate(previousMonth)
  const nextDisabled = !monthHasSelectableDate(nextMonth)

  const changeMonth = (month: CalendarDate | undefined) => {
    if (!month) return
    const start = clampMonthToRange(month, minDate, maxDate)
    setViewMonth(start)
    const focusInMonth = selectedDate && selectedDate.year === start.year && selectedDate.month === start.month && selectable(selectedDate)
      ? selectedDate
      : Array.from({ length: daysInMonth(start.year, start.month) }, (_, index) => ({
          year: start.year,
          month: start.month,
          day: index + 1,
        })).find(selectable)
    setFocusedDate(focusInMonth ? formatISODate(focusInMonth) : "")
  }

  const focusDay = (date: CalendarDate) => {
    const formatted = formatISODate(date)
    setFocusedDate(formatted)
    setViewMonth(monthStart(date))
    requestAnimationFrame(() => dayRefs.current.get(formatted)?.focus())
  }

  const selectDay = (date: CalendarDate) => {
    if (!selectable(date)) return
    const formatted = formatISODate(date)
    if (!isControlled) setUncontrolledValue(formatted)
    onValueChange(formatted)
    setFocusedDate(formatted)
    setViewMonth(monthStart(date))
    requestAnimationFrame(() => dayRefs.current.get(formatted)?.focus())
  }

  const handleDayKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, date: CalendarDate) => {
    let destination: CalendarDate | undefined
    let scanDirection = 0
    if (event.key === "ArrowLeft") destination = addDays(date, -1)
    else if (event.key === "ArrowRight") destination = addDays(date, 1)
    else if (event.key === "ArrowUp") destination = addDays(date, -7)
    else if (event.key === "ArrowDown") destination = addDays(date, 7)
    else if (event.key === "Home") {
      destination = addDays(date, -((weekday(date) - weekStartsOn + 7) % 7))
      scanDirection = 1
    } else if (event.key === "End") {
      const offset = (weekday(date) - weekStartsOn + 7) % 7
      destination = addDays(date, 6 - offset)
      scanDirection = -1
    } else if (event.key === "PageUp") destination = addMonths(date, event.shiftKey ? -12 : -1)
    else if (event.key === "PageDown") destination = addMonths(date, event.shiftKey ? 12 : 1)
    else return

    event.preventDefault()
    while (destination && scanDirection !== 0 && !selectable(destination) && !sameDate(destination, date)) {
      destination = addDays(destination, scanDirection)
    }
    if (!destination || !selectable(destination)) return
    focusDay(destination)
  }

  return (
    <section
      className={cn("g-calendar", className)}
      aria-label={label}
      data-slot="calendar"
      data-disabled={disabled || undefined}
    >
      <header className="g-calendar__header">
        <button
          className="g-calendar__month-step"
          type="button"
          aria-label={previousLabel}
          disabled={previousDisabled}
          onClick={() => changeMonth(previousMonth)}
        >
          <ChevronLeft aria-hidden="true" focusable="false" />
        </button>
        <h2 className="g-calendar__month" aria-live="polite">
          {monthLabel}
        </h2>
        <button
          className="g-calendar__month-step"
          type="button"
          aria-label={nextLabel}
          disabled={nextDisabled}
          onClick={() => changeMonth(nextMonth)}
        >
          <ChevronRight aria-hidden="true" focusable="false" />
        </button>
      </header>
      <table className="g-calendar__grid" role="grid" aria-label={monthLabel}>
        <thead>
          <tr role="row">
            {orderedWeekDays.map((day, index) => (
              <th
                className="g-calendar__weekday"
                scope="col"
                role="columnheader"
                aria-label={day.full}
                key={`${weekStartsOn}-${index}`}
              >
                {day.short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }, (_, row) => (
            <tr role="row" key={row}>
              {gridDates.slice(row * 7, row * 7 + 7).map((date, column) => {
                if (!date) return <td className="g-calendar__cell" role="gridcell" key={column} />
                const formatted = formatISODate(date)
                const isDisabled = !selectable(date)
                const isSelected = selectedDate ? sameDate(date, selectedDate) : false
                const isToday = sameDate(date, today)
                const isOutsideMonth = date.month !== viewMonth.month || date.year !== viewMonth.year
                const dateLabel = formatLocalDate(date, locale, { year: "numeric", month: "long", day: "numeric" })

                return (
                  <td
                    className="g-calendar__cell"
                    role="gridcell"
                    aria-selected={isSelected}
                    data-outside-month={isOutsideMonth || undefined}
                    key={formatted}
                  >
                    <button
                      ref={(node) => {
                        if (node) dayRefs.current.set(formatted, node)
                        else dayRefs.current.delete(formatted)
                      }}
                      className="g-calendar__day"
                      id={dayId(instanceId, date)}
                      type="button"
                      aria-label={dateLabel}
                      aria-pressed={isSelected}
                      aria-current={isToday ? "date" : undefined}
                      disabled={isDisabled}
                      tabIndex={!isDisabled && visibleFocusDate && sameDate(date, visibleFocusDate) ? 0 : -1}
                      data-selected={isSelected || undefined}
                      data-today={isToday || undefined}
                      data-outside-month={isOutsideMonth || undefined}
                      onClick={() => selectDay(date)}
                      onKeyDown={(event) => handleDayKeyDown(event, date)}
                    >
                      {date.day}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

export { Calendar }
