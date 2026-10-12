import type { ReactNode, KeyboardEvent } from "react"
import { useEffect, useId, useRef, useState } from "react"

export interface GSettingsSection {
  id: string
  label: string
  icon?: ReactNode
}

export interface GSettingsProps {
  sections: GSettingsSection[]
  activeSection: string
  onSectionChange: (id: string) => void
  children: ReactNode
  title?: string
  pageTitle?: ReactNode
  strings: {
    navigationLabel: string
    contentLabel: string
  }
  className?: string
}

export interface GSettingsGroupProps {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  className?: string
}

export interface GSettingsRowProps {
  label: ReactNode
  description?: ReactNode
  htmlFor?: string
  children: ReactNode
  className?: string
}

export function GSettings({
  sections,
  activeSection,
  onSectionChange,
  children,
  title,
  pageTitle,
  strings,
  className,
}: GSettingsProps) {
  const instanceId = useId()
  const panelId = `${instanceId}-panel`
  const settingsRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const [horizontalNavigation, setHorizontalNavigation] = useState(false)

  useEffect(() => {
    const settings = settingsRef.current
    if (!settings || typeof ResizeObserver === "undefined") return

    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHorizontalNavigation(entry.contentRect.width <= 700)
    })
    observer.observe(settings)
    return () => observer.disconnect()
  }, [])

  const tabId = (sectionId: string) => `${instanceId}-tab-${sectionId}`
  const selectedSection = sections.find((section) => section.id === activeSection)

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, sectionId: string) => {
    const previousKey = horizontalNavigation ? "ArrowLeft" : "ArrowUp"
    const nextKey = horizontalNavigation ? "ArrowRight" : "ArrowDown"
    const currentIndex = sections.findIndex((section) => section.id === sectionId)
    let nextSection: GSettingsSection | undefined

    if (event.key === "Home") nextSection = sections[0]
    else if (event.key === "End") nextSection = sections[sections.length - 1]
    else if (event.key === previousKey || event.key === nextKey) {
      const offset = event.key === nextKey ? 1 : -1
      nextSection = sections[(currentIndex + offset + sections.length) % sections.length]
    } else return

    if (!nextSection) return
    const selectedNextSection = nextSection
    event.preventDefault()
    onSectionChange(selectedNextSection.id)
    requestAnimationFrame(() => tabRefs.current.get(selectedNextSection.id)?.focus())
  }

  return (
    <div ref={settingsRef} className={["g-settings", className].filter(Boolean).join(" ")}>
      <div className="g-settings__layout">
        <nav className="g-settings__navigation" aria-label={strings.navigationLabel}>
          {title && <h1 className="g-settings__title">{title}</h1>}
          <div
            className="g-settings__section-list"
            role="tablist"
            aria-label={strings.navigationLabel}
            aria-orientation={horizontalNavigation ? "horizontal" : "vertical"}
          >
            {sections.map((section) => {
              const isSelected = activeSection === section.id
              return (
                <button
                  key={section.id}
                  ref={(node) => {
                    if (node) tabRefs.current.set(section.id, node)
                    else tabRefs.current.delete(section.id)
                  }}
                  id={tabId(section.id)}
                  className="g-settings__section g-navigation-item"
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  aria-controls={panelId}
                  tabIndex={isSelected || (!selectedSection && section === sections[0]) ? 0 : -1}
                  onClick={() => onSectionChange(section.id)}
                  onKeyDown={(event) => onTabKeyDown(event, section.id)}
                >
                  {section.icon && <span className="g-settings__section-icon" aria-hidden="true">{section.icon}</span>}
                  <span>{section.label}</span>
                </button>
              )
            })}
          </div>
        </nav>
        <section
          id={panelId}
          className="g-settings__content"
          role="tabpanel"
          aria-labelledby={selectedSection ? tabId(selectedSection.id) : undefined}
          aria-label={strings.contentLabel}
          tabIndex={0}
        >
          <div className="g-settings__content-inner">
            {pageTitle && <h1 className="g-settings__page-title">{pageTitle}</h1>}
            {children}
          </div>
        </section>
      </div>
    </div>
  )
}

export function GSettingsGroup({ title, description, children, className }: GSettingsGroupProps) {
  const headingId = useId()
  const descriptionId = useId()

  return (
    <section
      className={["g-settings-group", className].filter(Boolean).join(" ")}
      aria-labelledby={headingId}
      aria-describedby={description ? descriptionId : undefined}
    >
      <header className="g-settings-group__header">
        <h2 id={headingId} className="g-settings-group__title">{title}</h2>
        {description && <p id={descriptionId} className="g-settings-group__description">{description}</p>}
      </header>
      <div className="g-settings-group__rows">{children}</div>
    </section>
  )
}

export function GSettingsRow({ label, description, htmlFor, children, className }: GSettingsRowProps) {
  return (
    <div className={["g-settings-row", className].filter(Boolean).join(" ")}>
      <div className="g-settings-row__copy">
        {htmlFor
          ? <label className="g-settings-row__label" htmlFor={htmlFor}>{label}</label>
          : <div className="g-settings-row__label">{label}</div>}
        {description && <p className="g-settings-row__description">{description}</p>}
      </div>
      <div className="g-settings-row__control">{children}</div>
    </div>
  )
}
