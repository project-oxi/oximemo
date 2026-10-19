import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { cn } from "../../lib/utils"

export interface RevisionTimelineItem {
  id: string
  title: string
  dateLabel: string
  author?: string
  content: React.ReactNode
}

export interface RevisionTimelineProps {
  label: string
  revisions: readonly RevisionTimelineItem[]
  activeId?: string
  defaultActiveId?: string
  onActiveIdChange?: (id: string) => void
  previousLabel: string
  nextLabel: string
  emptyLabel: string
  className?: string
}

function RevisionTimeline({
  label,
  revisions,
  activeId,
  defaultActiveId,
  onActiveIdChange,
  previousLabel,
  nextLabel,
  emptyLabel,
  className,
}: RevisionTimelineProps) {
  const instanceId = React.useId()
  const contentId = `${instanceId}-content`
  const selectorRefs = React.useRef(new Map<string, HTMLButtonElement>())
  const isControlled = activeId !== undefined
  const [uncontrolledActiveId, setUncontrolledActiveId] = React.useState(
    () => defaultActiveId ?? revisions[0]?.id ?? ""
  )
  const requestedActiveId = isControlled ? activeId : uncontrolledActiveId
  const selectedRevision = revisions.find(
    (revision) => revision.id === requestedActiveId
  )
  const currentRevision = selectedRevision ?? revisions[0]
  const currentIndex = currentRevision
    ? revisions.findIndex((revision) => revision.id === currentRevision.id)
    : -1

  React.useEffect(() => {
    if (!isControlled && uncontrolledActiveId !== (currentRevision?.id ?? "")) {
      setUncontrolledActiveId(currentRevision?.id ?? "")
    }
  }, [currentRevision?.id, isControlled, uncontrolledActiveId])

  const selectRevision = React.useCallback((id: string) => {
    if (!isControlled) setUncontrolledActiveId(id)
    onActiveIdChange?.(id)
  }, [isControlled, onActiveIdChange])

  const moveFocusTo = React.useCallback((index: number) => {
    const revision = revisions[index]
    if (!revision) return
    selectRevision(revision.id)
    requestAnimationFrame(() => selectorRefs.current.get(revision.id)?.focus())
  }, [revisions, selectRevision])

  const handleSelectorKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    let destination = index
    if (event.key === "ArrowLeft") destination = Math.max(0, index - 1)
    else if (event.key === "ArrowRight") destination = Math.min(revisions.length - 1, index + 1)
    else if (event.key === "Home") destination = 0
    else if (event.key === "End") destination = revisions.length - 1
    else return

    if (destination === index) return
    event.preventDefault()
    moveFocusTo(destination)
  }

  if (revisions.length === 0) {
    return (
      <section
        className={cn("g-revision-timeline", className)}
        aria-label={label}
        data-slot="revision-timeline"
      >
        <p className="g-revision-timeline__empty" role="status">
          {emptyLabel}
        </p>
      </section>
    )
  }

  return (
    <section
      className={cn("g-revision-timeline", className)}
      aria-label={label}
      data-slot="revision-timeline"
    >
      {currentRevision && (
        <article
          className="g-revision-timeline__content"
          id={contentId}
          aria-live="polite"
          aria-atomic="true"
        >
          <h2 className="g-revision-timeline__title">{currentRevision.title}</h2>
          <div className="g-revision-timeline__meta">
            <time>{currentRevision.dateLabel}</time>
            {currentRevision.author && <span>{currentRevision.author}</span>}
          </div>
          <div className="g-revision-timeline__body">{currentRevision.content}</div>
        </article>
      )}

      <div className="g-revision-timeline__navigation">
        <button
          className="g-revision-timeline__step"
          type="button"
          aria-label={previousLabel}
          disabled={currentIndex <= 0}
          onClick={() => currentIndex > 0 && selectRevision(revisions[currentIndex - 1]!.id)}
        >
          <ChevronLeft aria-hidden="true" focusable="false" />
        </button>
        <div className="g-revision-timeline__selector" role="group" aria-label={label}>
          {revisions.map((revision, index) => {
            const isCurrent = index === currentIndex
            const selectorLabel = [revision.title, revision.dateLabel]
              .filter(Boolean)
              .join(" · ")

            return (
              <button
                className="g-revision-timeline__tick"
                key={revision.id}
                ref={(node) => {
                  if (node) selectorRefs.current.set(revision.id, node)
                  else selectorRefs.current.delete(revision.id)
                }}
                type="button"
                aria-label={selectorLabel}
                aria-current={isCurrent ? "step" : undefined}
                aria-controls={contentId}
                tabIndex={isCurrent ? 0 : -1}
                onClick={() => selectRevision(revision.id)}
                onKeyDown={(event) => handleSelectorKeyDown(event, index)}
              >
                <span className="g-revision-timeline__mark" aria-hidden="true" />
                <span className="g-revision-timeline__date" aria-hidden="true">
                  {revision.dateLabel}
                </span>
              </button>
            )
          })}
        </div>
        <button
          className="g-revision-timeline__step"
          type="button"
          aria-label={nextLabel}
          disabled={currentIndex >= revisions.length - 1}
          onClick={() => currentIndex < revisions.length - 1 && selectRevision(revisions[currentIndex + 1]!.id)}
        >
          <ChevronRight aria-hidden="true" focusable="false" />
        </button>
      </div>
    </section>
  )
}

export { RevisionTimeline }
