import type { ComponentProps, ReactNode } from "react"
import { cn } from "../lib/utils"

export interface GPageProps extends ComponentProps<"div"> {
  /** Width only. GAppShell owns the page gutter and scrolling. */
  width?: "content" | "reading" | "full"
}

export function GPage({ width = "content", className, ...props }: GPageProps) {
  return <div data-slot="page" data-width={width} className={cn("g-page", className)} {...props} />
}

export interface GPageHeaderProps extends Omit<ComponentProps<"header">, "title"> {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}

export function GPageHeader({ title, description, actions, className, children, ...props }: GPageHeaderProps) {
  return <header data-slot="page-header" className={cn("g-page-header", className)} {...props}>
    <div className="g-page-header__copy">
      <h1 className="g-page-header__title">{title}</h1>
      {description && <p className="g-page-header__description">{description}</p>}
      {children}
    </div>
    {actions && <div className="g-page-header__actions">{actions}</div>}
  </header>
}

export type GSplitLayoutProps = ComponentProps<"div"> & {
  aside: ReactNode
  asideLabel: string
}

/** Page-local support content follows the main task in DOM and narrow layouts. */
export function GSplitLayout({ children, aside, asideLabel, className, ...props }: GSplitLayoutProps) {
  return <div data-slot="split-layout" className={cn("g-split-layout", className)} {...props}>
    <div className="g-split-layout__columns">
      <div className="g-split-layout__main">{children}</div>
      <aside className="g-split-layout__aside" aria-label={asideLabel}>{aside}</aside>
    </div>
  </div>
}
