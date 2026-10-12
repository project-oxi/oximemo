import type { ComponentProps, ReactNode } from "react"
import { Slot } from "@radix-ui/react-slot"
import { cn } from "../lib/utils"

export interface GNavigationProps extends ComponentProps<"nav"> {
  label: string
}

export function GNavigation({ label, className, ...props }: GNavigationProps) {
  return <nav aria-label={label} className={cn("g-navigation", className)} {...props} />
}

export interface GNavigationGroupProps extends ComponentProps<"div"> {
  label: string
}

export function GNavigationGroup({ label, children, className, ...props }: GNavigationGroupProps) {
  return <div className={cn("g-navigation-group", className)} {...props}>
    <p className="g-navigation-group__label">{label}</p>
    <div className="g-navigation-group__items">{children}</div>
  </div>
}

export interface GNavigationItemProps extends ComponentProps<"button"> {
  /** Use an anchor or router link child to preserve native link behavior. */
  asChild?: boolean
  current?: boolean
}

export function GNavigationItem({ asChild = false, current = false, className, ...props }: GNavigationItemProps) {
  const Component = asChild ? Slot : "button"
  return <Component {...(!asChild ? { type: "button" as const } : {})} aria-current={current ? "page" : undefined} className={cn("g-navigation-item", className)} {...props} />
}

export interface GActivityRailProps extends ComponentProps<"nav"> {
  label: string
  footer?: ReactNode
}

export function GActivityRail({ label, footer, children, className, ...props }: GActivityRailProps) {
  return <nav aria-label={label} className={cn("g-activity-rail", className)} {...props}>
    <div className="g-activity-rail__items">{children}</div>
    {footer && <div className="g-activity-rail__footer">{footer}</div>}
  </nav>
}

export interface GActivityRailItemProps extends ComponentProps<"button"> {
  label: string
  current?: boolean
  asChild?: boolean
}

export function GActivityRailItem({ label, current = false, asChild = false, className, children, ...props }: GActivityRailItemProps) {
  const Component = asChild ? Slot : "button"
  return <Component {...(!asChild ? { type: "button" as const } : {})} aria-label={label} title={label} aria-current={current ? "page" : undefined} className={cn("g-activity-rail__item", className)} {...props}>
    {asChild ? children : <span aria-hidden="true">{children}</span>}
  </Component>
}
