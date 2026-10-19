import * as React from "react"
import { ArrowUp, Send } from "lucide-react"

import { Button } from "./ui/button"
import { Textarea } from "./ui/textarea"
import { cn } from "../lib/utils"

export interface GComposerProps {
  value: string
  onValueChange: (value: string) => void
  onSubmit: (value: string) => void
  label: React.ReactNode
  placeholder: string
  submitLabel: string
  inputId?: string
  disabled?: boolean
  pending?: boolean
  footer?: React.ReactNode
  trailing?: React.ReactNode
  rows?: number
  variant?: "default" | "conversation"
  inputRef?: React.Ref<HTMLTextAreaElement>
  className?: string
}

/** Controlled message composer. The owner clears the draft after submission. */
export function GComposer({
  value,
  onValueChange,
  onSubmit,
  label,
  placeholder,
  submitLabel,
  inputId,
  disabled = false,
  pending = false,
  footer,
  trailing,
  rows = 2,
  variant = "default",
  inputRef,
  className,
}: GComposerProps) {
  const generatedId = React.useId()
  const resolvedInputId = inputId ?? generatedId
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const previousVariantRef = React.useRef(variant)
  const canSubmit = value.trim().length > 0 && !disabled && !pending

  const setInputRef = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node
      if (typeof inputRef === "function") inputRef(node)
      else if (inputRef) inputRef.current = node
    },
    [inputRef],
  )

  const resizeConversationTextarea = React.useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea || variant !== "conversation") return

    textarea.style.height = "auto"
    const maxHeight = 200
    const contentHeight = textarea.scrollHeight
    textarea.style.height = `${Math.min(contentHeight, maxHeight)}px`
    textarea.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden"
  }, [variant])

  React.useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    if (variant !== "conversation") {
      if (previousVariantRef.current === "conversation") {
        textarea.style.removeProperty("height")
        textarea.style.removeProperty("overflow-y")
      }
      previousVariantRef.current = variant
      return
    }
    previousVariantRef.current = variant
    resizeConversationTextarea()
  }, [resizeConversationTextarea, value, variant])

  React.useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea || variant !== "conversation") return

    let previousWidth = textarea.getBoundingClientRect().width
    const observer = new ResizeObserver(() => {
      const nextWidth = textarea.getBoundingClientRect().width
      if (nextWidth === previousWidth) return
      previousWidth = nextWidth
      resizeConversationTextarea()
    })
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [resizeConversationTextarea, variant])

  const submit = () => {
    const trimmedValue = value.trim()
    if (!trimmedValue || disabled || pending) return
    onSubmit(trimmedValue)
  }

  return (
    <div
      data-slot="g-composer"
      data-variant={variant}
      aria-busy={pending || undefined}
      className={cn("g-composer", className)}
    >
      <label
        className={cn(
          "g-composer__label",
          variant === "conversation" && "g-composer__label--visually-hidden",
        )}
        htmlFor={resolvedInputId}
      >
        {label}
      </label>
      <div className="g-composer__surface">
        <Textarea
          ref={setInputRef}
          id={resolvedInputId}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={placeholder}
          rows={rows}
          disabled={disabled || pending}
          className="g-composer__textarea"
        />
        <div className="g-composer__footer">
          <div className="g-composer__footer-slot">{footer}</div>
          {trailing != null ? (
            <div className="g-composer__footer-actions">
              <div className="g-composer__footer-trailing">{trailing}</div>
              <Button
                type="button"
                size="icon"
                aria-label={submitLabel}
                disabled={!canSubmit}
                onClick={submit}
                className={variant === "conversation" ? "g-composer__submit--conversation" : undefined}
              >
                {variant === "conversation" ? <ArrowUp aria-hidden="true" /> : <Send aria-hidden="true" />}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="icon"
              aria-label={submitLabel}
              disabled={!canSubmit}
              onClick={submit}
              className={variant === "conversation" ? "g-composer__submit--conversation" : undefined}
            >
              {variant === "conversation" ? <ArrowUp aria-hidden="true" /> : <Send aria-hidden="true" />}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
