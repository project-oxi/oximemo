import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "../../lib/utils"

const TooltipProviderContext = React.createContext(false)

/** Garden Tooltip — dark plate in both themes (beautifului tooltip tokens). */
function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipProviderContext.Provider value={true}>
      <TooltipPrimitive.Provider
        data-slot="tooltip-provider"
        delayDuration={delayDuration}
        {...props}
      />
    </TooltipProviderContext.Provider>
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const hasProvider = React.useContext(TooltipProviderContext)
  const tooltip = <TooltipPrimitive.Root data-slot="tooltip" {...props} />
  return hasProvider ? tooltip : <TooltipProvider>{tooltip}</TooltipProvider>
}

const TooltipTrigger = TooltipPrimitive.Trigger

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "bg-tooltip-bg text-tooltip-fg animate-[pop-in_150ms_var(--ease-enter)] data-[state=closed]:animate-[fade-in_100ms_ease-in_reverse] z-50 w-fit origin-(--radix-tooltip-content-transform-origin) overflow-hidden rounded-control px-2.5 py-1.5 text-caption shadow-overlay border border-tooltip-border",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
