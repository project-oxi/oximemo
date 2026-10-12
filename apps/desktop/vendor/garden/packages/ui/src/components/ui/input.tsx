import * as React from "react"

import { cn } from "../../lib/utils"

/** Garden Input — stable field surface; caret focus, independent invalid state. */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-ink placeholder:text-ink-3 selection:bg-accent-tint selection:text-accent-ink bg-field shadow-inset-field border border-transparent rounded-control flex h-7 w-full min-w-0 px-3 text-ui text-ink transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-caption file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-red aria-invalid:ring-red/30 aria-invalid:ring-[2px]",
        className
      )}
      {...props}
    />
  )
}

export { Input }
