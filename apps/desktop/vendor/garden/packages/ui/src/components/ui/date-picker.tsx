import * as React from "react"
import { CalendarDays, X } from "lucide-react"

import { cn } from "../../lib/utils"
import { Calendar, type CalendarProps } from "./calendar"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"
import { formatLocalDate, parseISODate } from "./calendar-date"

export interface DatePickerProps extends Omit<CalendarProps, "className"> {
  placeholder: string
  clearLabel: string
  className?: string
}

function DatePicker({
  label,
  value,
  onValueChange,
  locale,
  previousLabel,
  nextLabel,
  min,
  max,
  defaultMonth,
  placeholder,
  clearLabel,
  className,
  disabled = false,
}: DatePickerProps) {
  const instanceId = React.useId()
  const [open, setOpen] = React.useState(false)
  const [uncontrolledValue, setUncontrolledValue] = React.useState<string | undefined>()
  const isControlled = value !== undefined
  const selectedValue = isControlled ? value : uncontrolledValue
  const selectedDate = parseISODate(selectedValue)
  const displayText = selectedDate
    ? formatLocalDate(selectedDate, locale, { year: "numeric", month: "short", day: "numeric" })
    : placeholder
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const calendarHostRef = React.useRef<HTMLDivElement>(null)
  const labelId = `${instanceId}-label`
  const valueId = `${instanceId}-value`
  const contentId = `${instanceId}-content`

  const handleValueChange = (nextValue: string) => {
    if (disabled) return
    if (!isControlled) setUncontrolledValue(nextValue)
    onValueChange(nextValue)
    setOpen(false)
  }

  const clearValue = () => {
    if (disabled) return
    if (!isControlled) setUncontrolledValue(undefined)
    onValueChange("")
    setOpen(false)
  }

  React.useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  return (
    <div className={cn("g-date-picker", className)} data-slot="date-picker">
      <span className="g-date-picker__label" id={labelId}>{label}</span>
      <div className="g-date-picker__field">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              className="g-date-picker__trigger"
              type="button"
              ref={triggerRef}
              aria-labelledby={`${labelId} ${valueId}`}
              aria-expanded={open}
              aria-controls={open ? contentId : undefined}
              aria-haspopup="dialog"
              disabled={disabled}
            >
              <span
                className="g-date-picker__value"
                id={valueId}
                data-placeholder={!selectedDate || undefined}
              >
                {displayText}
              </span>
              <CalendarDays aria-hidden="true" focusable="false" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            id={contentId}
            className="g-date-picker__popover"
            align="start"
            aria-labelledby={labelId}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              requestAnimationFrame(() => {
                const firstDay = calendarHostRef.current?.querySelector<HTMLButtonElement>(
                  ".g-calendar__day[tabindex='0']:not(:disabled)"
                )
                const firstStep = calendarHostRef.current?.querySelector<HTMLButtonElement>(
                  ".g-calendar__month-step:not(:disabled)"
                )
                ;(firstDay ?? firstStep ?? calendarHostRef.current)?.focus()
              })
            }}
          >
            <div className="g-date-picker__calendar-host" ref={calendarHostRef} tabIndex={-1}>
              <Calendar
                label={label}
                value={selectedValue}
                onValueChange={handleValueChange}
                locale={locale}
                previousLabel={previousLabel}
                nextLabel={nextLabel}
                min={min}
                max={max}
                defaultMonth={defaultMonth}
                disabled={disabled}
              />
            </div>
          </PopoverContent>
        </Popover>
        <button
          className="g-date-picker__clear"
          type="button"
          aria-label={clearLabel}
          disabled={disabled || !selectedValue}
          onClick={clearValue}
        >
          <X aria-hidden="true" focusable="false" />
          <span>{clearLabel}</span>
        </button>
      </div>
    </div>
  )
}

export { DatePicker }
