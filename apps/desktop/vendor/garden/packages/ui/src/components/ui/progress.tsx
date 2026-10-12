import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"

import { cn } from "../../lib/utils"

/** Garden Progress — hover2 track, accent fill (PARITY: 트랙 hover / 채움 accent). */
function Progress({
  className,
  value: valueProp = null,
  max: maxProp = 100,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  // Match Radix's progress semantics: invalid maxima fall back to 100, and
  // values outside the valid range become indeterminate.
  const max = Number.isFinite(maxProp) && maxProp > 0 ? maxProp : 100
  const value = Number.isFinite(valueProp) && valueProp! >= 0 && valueProp! <= max ? valueProp : null
  const percentage = value === null ? null : (value / max) * 100

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "bg-hover-2 relative h-1.5 w-full overflow-hidden rounded-full",
        className
      )}
      {...props}
      max={max}
      value={value}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="g-progress-indicator bg-accent h-full w-full flex-1 transition-all"
        style={percentage === null ? undefined : { transform: `translateX(-${100 - percentage}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
