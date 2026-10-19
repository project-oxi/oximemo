import * as React from "react"

import { cn } from "../../lib/utils"

export type TextRevealProps = {
  children: React.ReactNode
  className?: string
}

function TextReveal({ children, className }: TextRevealProps) {
  return <div className={cn("g-text-reveal", className)}>{children}</div>
}

export { TextReveal }
