import * as React from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "../../lib/utils"

export type CollapsibleProps = {
  title: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
  onToggle?: React.ComponentProps<"details">["onToggle"]
  className?: string
}

function Collapsible({
  title,
  children,
  defaultOpen = false,
  onToggle,
  className,
}: CollapsibleProps) {
  return (
    <details
      data-slot="collapsible"
      className={cn("g-collapsible", className)}
      open={defaultOpen}
      onToggle={onToggle}
    >
      <summary className="g-collapsible__summary">
        <span className="g-collapsible__title">{title}</span>
        <ChevronDown
          className="g-collapsible__icon"
          aria-hidden="true"
          focusable="false"
        />
      </summary>
      <div className="g-collapsible__content">{children}</div>
    </details>
  )
}

export { Collapsible }
