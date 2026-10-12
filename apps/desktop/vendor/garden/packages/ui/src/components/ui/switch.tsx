import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"

import { cn } from "../../lib/utils"

/** Garden Switch — inverse-monochrome thumb like the primary action. */
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-hover-2 focus-visible:border-ring focus-visible:ring-ring/40 inline-flex shrink-0 items-center rounded-full border border-transparent outline-none focus-visible:ring-[2px] disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "bg-surface pointer-events-none block rounded-full shadow-btn ring-0 transition-transform"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
