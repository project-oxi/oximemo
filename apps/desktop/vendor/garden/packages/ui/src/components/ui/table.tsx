import * as React from "react"

import { cn } from "../../lib/utils"

export interface TableProps extends React.ComponentProps<"table"> {
  /** Fixed columns wrap prose within the available width; auto can scroll wide data. */
  layout?: "auto" | "fixed"
}

function Table({ className, layout = "auto", ...props }: TableProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = React.useState(false)
  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = () => setOverflows(container.scrollWidth > container.clientWidth)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    if (container.firstElementChild) observer.observe(container.firstElementChild)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={containerRef} data-slot="table-container" className="g-table-container" tabIndex={overflows ? 0 : undefined}
      role={overflows ? "region" : undefined}
      aria-label={overflows ? props["aria-label"] : undefined}
      aria-labelledby={overflows ? props["aria-labelledby"] : undefined}
    >
      <table data-slot="table" className={cn("g-table", layout === "fixed" && "g-table--fixed", className)} {...props} />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("g-table__header", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("g-table__body", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("g-table__footer", className)}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr data-slot="table-row" className={cn("g-table__row", className)} {...props} />
  )
}

function TableHead({
  className,
  scope = "col",
  ...props
}: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      scope={scope}
      className={cn("g-table__head", className)}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("g-table__cell", className)}
      {...props}
    />
  )
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("g-table__caption", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
}
