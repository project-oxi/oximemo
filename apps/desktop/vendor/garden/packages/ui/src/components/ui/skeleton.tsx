import type * as React from "react"

import { cn } from "../../lib/utils"

/**
 * Garden Skeleton — stripe shimmer sweep (PARITY counterpart: GShimmerText;
 * same shimmer-text keyframes the beautifului atoms use).
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-[shimmer-text_1.4s_linear_infinite] rounded-control bg-[linear-gradient(90deg,var(--stripe-bg),var(--stripe),var(--stripe-bg))] bg-[length:200%_100%]",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
