import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "../../lib/utils"

export type SheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  closeLabel: string
  trigger: React.ReactElement
  children: React.ReactNode
  side?: "left" | "right"
  className?: string
}

function Sheet({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  trigger,
  children,
  side = "right",
  className,
}: SheetProps) {
  const descriptionId = React.useId()
  const hasDescription = Boolean(description)

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="g-sheet__overlay"
          data-slot="sheet-overlay"
        />
        <DialogPrimitive.Content
          aria-modal="true"
          aria-describedby={hasDescription ? descriptionId : undefined}
          className={cn("g-sheet__content", className)}
          data-side={side}
          data-slot="sheet-content"
        >
          <header className="g-sheet__header">
            <div className="g-sheet__heading">
              <DialogPrimitive.Title className="g-sheet__title">
                {title}
              </DialogPrimitive.Title>
              {hasDescription ? (
                <DialogPrimitive.Description
                  className="g-sheet__description"
                  id={descriptionId}
                >
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close
              type="button"
              className="g-sheet__close"
              aria-label={closeLabel}
            >
              <X aria-hidden="true" focusable="false" />
            </DialogPrimitive.Close>
          </header>
          <div className="g-sheet__body">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export { Sheet }
