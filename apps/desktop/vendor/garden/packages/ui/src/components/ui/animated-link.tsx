import * as React from "react"

import { cn } from "../../lib/utils"

export type AnimatedLinkProps = React.ComponentPropsWithRef<"a"> & {
  icon?: React.ReactNode
}

function AnimatedLink({ className, children, icon, ...props }: AnimatedLinkProps) {
  return (
    <a
      data-slot="animated-link"
      className={cn("g-animated-link", className)}
      {...props}
    >
      {icon ? (
        <span className="g-animated-link__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </a>
  )
}

export { AnimatedLink }
