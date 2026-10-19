import * as React from "react"

import { Progress } from "./progress"
import { cn } from "../../lib/utils"

export interface ChecklistItem {
  id: string
  label: string
  description?: string
  checked: boolean
  disabled?: boolean
}

export interface ChecklistProps {
  label: string
  items: readonly ChecklistItem[]
  onCheckedChange?: (id: string, checked: boolean) => void
  progressLabel: (completed: number, total: number) => string
  className?: string
}

function Checklist({
  label,
  items,
  onCheckedChange,
  progressLabel,
  className,
}: ChecklistProps) {
  const instanceId = React.useId()
  const completed = items.reduce((count, item) => count + Number(item.checked), 0)
  const total = items.length
  const percentComplete = total === 0 ? 0 : (completed / total) * 100
  const progressText = progressLabel(completed, total)

  return (
    <fieldset
      className={cn("g-checklist", className)}
      data-slot="checklist"
      data-readonly={!onCheckedChange || undefined}
    >
      <legend className="g-checklist__legend">{label}</legend>
      <ul className="g-checklist__items">
        {items.map((item, index) => {
          const inputId = `${instanceId}-item-${index}`
          const descriptionId = `${inputId}-description`
          const readOnly = !onCheckedChange

          return (
            <li
              className="g-checklist__item"
              data-disabled={item.disabled || undefined}
              data-readonly={readOnly || undefined}
              key={item.id}
            >
              <div className="g-checklist__row">
                <input
                  className="g-checklist__checkbox"
                  id={inputId}
                  type="checkbox"
                  data-slot="native-checkbox"
                  checked={item.checked}
                  disabled={item.disabled}
                  readOnly={readOnly}
                  aria-readonly={readOnly || undefined}
                  aria-describedby={item.description ? descriptionId : undefined}
                  onChange={onCheckedChange
                    ? (event) => onCheckedChange(item.id, event.currentTarget.checked)
                    : undefined}
                  onClick={readOnly ? (event) => event.preventDefault() : undefined}
                />
                <div className="g-checklist__copy">
                  <label className="g-checklist__label" htmlFor={inputId}>
                    {item.label}
                  </label>
                  {item.description && (
                    <p className="g-checklist__description" id={descriptionId}>
                      {item.description}
                    </p>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
      <div className="g-checklist__progress-row">
        <p className="g-checklist__progress-label">{progressText}</p>
        <Progress
          className="g-checklist__progress"
          value={percentComplete}
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={total || undefined}
          aria-valuenow={total > 0 ? completed : undefined}
          aria-valuetext={progressText}
        />
      </div>
    </fieldset>
  )
}

export { Checklist }
