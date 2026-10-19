import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"

/** Garden Badge — 20px chip-height badges on the Garden token vocabulary. */
const badgeVariants = cva(
  "inline-flex items-center justify-center gap-1 rounded-chip border px-2 h-5 text-micro font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 [&>svg]:pointer-events-none transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default: "border-transparent bg-inset text-ink",
        success: "border-transparent bg-green-tint text-green",
        warning: "border-transparent bg-orange-tint text-orange",
        danger: "border-transparent bg-red-tint text-red",
        outline: "text-ink-2 border-line-strong",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span"

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
