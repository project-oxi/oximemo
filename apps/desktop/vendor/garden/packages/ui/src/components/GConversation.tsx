import * as React from "react"
import { ArrowDown, ChevronRight } from "lucide-react"

import { Button } from "./ui/button"
import { cn } from "../lib/utils"

export interface GConversationProps {
  label: string
  transcriptLabel: string
  children: React.ReactNode
  header?: React.ReactNode
  composer: React.ReactNode
  footer?: React.ReactNode
  className?: string
  scrollKey?: string | number
  jumpToLatestLabel: string
}

export interface GConversationMessageProps {
  role: "user" | "assistant"
  label: string
  children: React.ReactNode
  actions?: React.ReactNode
  className?: string
}

export interface GConversationActivityProps {
  summary: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
  className?: string
}

const BOTTOM_THRESHOLD = 48

/** A local scrolling conversation frame with a fixed composer dock. */
export function GConversation({
  label,
  transcriptLabel,
  children,
  header,
  composer,
  footer,
  className,
  scrollKey,
  jumpToLatestLabel,
}: GConversationProps) {
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const hasMountedRef = React.useRef(false)
  const nearBottomRef = React.useRef(true)
  const preserveDisclosurePositionRef = React.useRef(false)
  const [showJumpToLatest, setShowJumpToLatest] = React.useState(false)

  const jumpToLatest = React.useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollTop = viewport.scrollHeight
    nearBottomRef.current = true
    setShowJumpToLatest(false)
  }, [])

  React.useLayoutEffect(() => {
    if (!hasMountedRef.current || nearBottomRef.current) {
      jumpToLatest()
    } else {
      setShowJumpToLatest(true)
    }
    hasMountedRef.current = true
  }, [jumpToLatest, scrollKey])

  React.useEffect(() => {
    const content = contentRef.current
    if (!content) return

    const observer = new ResizeObserver(() => {
      // Opening a tool disclosure is a reading action, even at the latest turn.
      // Preserve its summary instead of following newly revealed content down.
      if (preserveDisclosurePositionRef.current) {
        preserveDisclosurePositionRef.current = false
        const viewport = viewportRef.current
        if (viewport) {
          nearBottomRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_THRESHOLD
          setShowJumpToLatest(!nearBottomRef.current)
        }
        return
      }
      if (nearBottomRef.current) jumpToLatest()
    })
    observer.observe(content)
    if (viewportRef.current) observer.observe(viewportRef.current)
    return () => observer.disconnect()
  }, [jumpToLatest])

  const handleTranscriptScroll = React.useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    const isNearBottom = distanceFromBottom <= BOTTOM_THRESHOLD
    nearBottomRef.current = isNearBottom
    setShowJumpToLatest(!isNearBottom)
  }, [])

  return (
    <section
      data-slot="g-conversation"
      aria-label={label}
      className={cn("g-conversation", className)}
    >
      {header != null && (
        <header className="g-conversation__header">
          <div className="g-conversation__column">{header}</div>
        </header>
      )}

      <div className="g-conversation__transcript-frame">
        <div
          ref={viewportRef}
          className="g-conversation__transcript"
          role="region"
          aria-label={transcriptLabel}
          tabIndex={0}
          onScroll={handleTranscriptScroll}
          onClickCapture={(event) => {
            if (event.target instanceof Element && event.target.closest("summary")) {
              preserveDisclosurePositionRef.current = true
            }
          }}
        >
          <div ref={contentRef} className="g-conversation__column g-conversation__transcript-content">
            <div className="g-conversation__messages">{children}</div>
          </div>
        </div>
        {showJumpToLatest && (
          <Button
            type="button"
            variant="secondary"
            className="g-conversation__jump"
            onClick={() => {
              jumpToLatest()
              viewportRef.current?.focus({ preventScroll: true })
            }}
          >
            <ArrowDown aria-hidden="true" />
            {jumpToLatestLabel}
          </Button>
        )}
      </div>

      <div className="g-conversation__dock">
        <div className="g-conversation__column">
          {composer}
          {footer != null && <div className="g-conversation__footer">{footer}</div>}
        </div>
      </div>
    </section>
  )
}

/** A speaker-labelled article in the conversation transcript. */
export function GConversationMessage({
  role,
  label,
  children,
  actions,
  className,
}: GConversationMessageProps) {
  return (
    <article
      data-slot="g-conversation-message"
      data-role={role}
      aria-label={label}
      className={cn("g-conversation-message", className)}
    >
      <div className="g-conversation-message__content">{children}</div>
      {actions != null && <div className="g-conversation-message__actions">{actions}</div>}
    </article>
  )
}

/** A native disclosure for collapsible activity or supporting details. */
export function GConversationActivity({
  summary,
  children,
  defaultOpen = false,
  className,
}: GConversationActivityProps) {
  return (
    <details
      data-slot="g-conversation-activity"
      className={cn("g-conversation-activity", className)}
      open={defaultOpen}
    >
      <summary className="g-conversation-activity__summary">
        <ChevronRight aria-hidden="true" className="g-conversation-activity__chevron" />
        <span>{summary}</span>
      </summary>
      <div className="g-conversation-activity__content">{children}</div>
    </details>
  )
}
