import * as React from "react"

import { cn } from "../../lib/utils"

export type BreadcrumbItem = {
  id: string
  label: string
  href?: string
}

export type BreadcrumbProps = {
  label: string
  items: readonly BreadcrumbItem[]
  className?: string
}

function Breadcrumb({ label, items, className }: BreadcrumbProps) {
  if (items.length === 0) return null

  return (
    <nav
      aria-label={label}
      className={cn("g-breadcrumb", className)}
      data-slot="breadcrumb"
    >
      <ol className="g-breadcrumb__list">
        {items.map((item, index) => {
          const isCurrent = index === items.length - 1

          return (
            <li className="g-breadcrumb__item" key={item.id}>
              {isCurrent ? (
                <span className="g-breadcrumb__current" aria-current="page">
                  {item.label}
                </span>
              ) : item.href ? (
                <a className="g-breadcrumb__link" href={item.href}>
                  {item.label}
                </a>
              ) : (
                <span className="g-breadcrumb__text">{item.label}</span>
              )}
              {!isCurrent ? (
                <span className="g-breadcrumb__separator" aria-hidden="true">
                  ›
                </span>
              ) : null}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

export { Breadcrumb }
