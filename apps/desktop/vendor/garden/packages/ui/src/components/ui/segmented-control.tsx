import * as React from "react"
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group"

import { cn } from "../../lib/utils"

export interface SegmentedControlOption<T extends string> {
  value: T
  label: React.ReactNode
  disabled?: boolean
  count?: React.ReactNode
}

export interface SegmentedControlProps<T extends string> {
  "aria-label": string
  value: T
  onValueChange: (value: T) => void
  options: readonly SegmentedControlOption<T>[]
  variant?: "segmented" | "filter"
  className?: string
}

/** A compact, accessible single-choice control built on Radix RadioGroup. */
function SegmentedControl<T extends string>({
  "aria-label": ariaLabel,
  value,
  onValueChange,
  options,
  variant = "segmented",
  className,
}: SegmentedControlProps<T>) {
  const optionId = React.useId()

  return (
    <RadioGroupPrimitive.Root
      data-slot="segmented-control"
      data-variant={variant}
      aria-label={ariaLabel}
      value={value}
      onValueChange={(nextValue) => {
        if (options.some((option) => option.value === nextValue)) {
          onValueChange(nextValue as T)
        }
      }}
      className={cn("g-segmented-control", className)}
      orientation="horizontal"
    >
      {options.map((option, index) => {
        const labelId = `${optionId}-${index}`
        const countId = `${labelId}-count`
        return (
          <RadioGroupPrimitive.Item
            key={option.value}
            data-slot="segmented-control-item"
            value={option.value}
            disabled={option.disabled}
            aria-labelledby={option.count === undefined ? labelId : `${labelId} ${countId}`}
            className="g-segmented-control__item"
          >
            <span id={labelId} className="g-segmented-control__label">
              {option.label}
            </span>
            {option.count !== undefined && (
              <span id={countId} className="g-segmented-control__count">
                {option.count}
              </span>
            )}
          </RadioGroupPrimitive.Item>
        )
      })}
    </RadioGroupPrimitive.Root>
  )
}

export { SegmentedControl }
