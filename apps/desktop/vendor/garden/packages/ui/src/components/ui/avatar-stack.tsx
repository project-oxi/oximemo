import * as React from "react"

import { Avatar, AvatarFallback, AvatarImage } from "./avatar"
import { cn } from "../../lib/utils"

export interface AvatarStackItem {
  id: string
  name: string
  src?: string
  fallback?: React.ReactNode
}

export interface AvatarStackProps {
  label: string
  items: readonly AvatarStackItem[]
  maxVisible?: number
  overflowLabel: (count: number) => string
  className?: string
}

function initialsFor(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
    .toLocaleUpperCase()
}

function AvatarStack({
  label,
  items,
  maxVisible = 4,
  overflowLabel,
  className,
}: AvatarStackProps) {
  const requestedVisible = Number.isFinite(maxVisible)
    ? Math.trunc(maxVisible)
    : 4
  const visibleCount = Math.max(0, Math.min(requestedVisible, items.length))
  const overflowCount = items.length - visibleCount

  return (
    <ul
      className={cn("g-avatar-stack__list", className)}
      aria-label={label}
      data-slot="avatar-stack"
    >
      {items.map((item, index) => {
        if (index >= visibleCount) {
          return (
            <li className="g-avatar-stack__item sr-only" key={item.id}>
              {item.name}
            </li>
          )
        }

        return (
          <li
            className="g-avatar-stack__item"
            key={item.id}
            style={{ zIndex: visibleCount - index }}
          >
            <Avatar
              className="g-avatar-stack__avatar"
              aria-hidden="true"
            >
              {item.src && <AvatarImage src={item.src} alt="" />}
              <AvatarFallback className="g-avatar-stack__fallback">
                {item.fallback ?? initialsFor(item.name)}
              </AvatarFallback>
            </Avatar>
            <span className="sr-only">{item.name}</span>
          </li>
        )
      })}
      {overflowCount > 0 && (
        <li
          className={cn(
            "g-avatar-stack__overflow",
            visibleCount > 0 && "g-avatar-stack__overflow--overlap"
          )}
        >
          <span aria-hidden="true">+{overflowCount}</span>
          <span className="sr-only">{overflowLabel(overflowCount)}</span>
        </li>
      )}
    </ul>
  )
}

export { AvatarStack }
