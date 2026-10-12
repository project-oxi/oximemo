import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"

/**
 * Garden Alert — neutral surface and readable copy; status belongs to the icon.
 */
const alertVariants = cva(
  "grid w-full min-w-0 grid-cols-[0_minmax(0,1fr)] items-start gap-y-1 rounded-card border border-line bg-surface p-4 text-ui text-ink [overflow-wrap:anywhere] has-[>svg]:grid-cols-[var(--g-space-4)_minmax(0,1fr)] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5",
  {
    variants: {
      variant: {
        default: "[&>svg]:text-ink-2",
        success: "[&>svg]:text-green",
        warning: "[&>svg]:text-orange",
        destructive: "[&>svg]:text-red",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "col-start-2 min-w-0 font-medium",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 grid min-w-0 justify-items-start gap-2 text-ui text-ink-2",
        className
      )}
      {...props}
    />
  )
}

export { Alert, AlertDescription, AlertTitle, alertVariants }
