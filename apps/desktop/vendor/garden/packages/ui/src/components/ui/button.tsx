import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"

/**
 * Garden Button — shadcn/ui button re-tokened for Garden UI.
 * Garden deltas: primary is inverse monochrome (never blue); hover surfaces use
 * the `hover` token instead of shadcn's `accent` (name reserved for focus blue);
 * default height follows Garden control density (28px, not 36px).
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control text-ui font-medium transition-[color,background-color,box-shadow,transform] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none active:scale-[0.96] cursor-pointer",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-btn hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-btn hover:bg-destructive/90",
        outline:
          "border border-line-strong bg-surface shadow-btn hover:bg-hover hover:text-ink",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-hover-2",
        ghost: "hover:bg-hover hover:text-ink",
        link: "text-accent-ink underline-offset-4 hover:underline",
      },
      size: {
        default: "h-7 px-3 has-[>svg]:px-3",
        sm: "h-5 gap-1 px-2 rounded-chip text-caption has-[>svg]:px-2",
        lg: "h-9 px-4 rounded-control text-body has-[>svg]:px-4",
        icon: "size-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
