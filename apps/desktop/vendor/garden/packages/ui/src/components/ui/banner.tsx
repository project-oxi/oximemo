import * as React from "react"
import { Info, OctagonAlert, TriangleAlert, X } from "lucide-react"

import { cn } from "../../lib/utils"
import { Button } from "./button"

/**
 * Garden Banner — 컴포저 위 단일 슬롯 상태 스트립(docs/EXPERIENCE.md §5.1).
 * 지속 상태 경고(사용량·샌드박스·안전)용. 토스트와 달리 슬롯 1개, 영구
 * dismiss는 앱이 플래그로 저장. role="status" + aria-live="polite".
 */
type BannerVariant = "warning" | "danger" | "info"

export type BannerProps = React.ComponentProps<"div"> & {
  variant?: BannerVariant
  /** 우측 보조 액션 (예: "자세히") */
  action?: React.ReactNode
} & (
  | { onDismiss: () => void; dismissLabel: string }
  | { onDismiss?: undefined; dismissLabel?: never }
)

const VARIANT_CLASS: Record<
  BannerVariant,
  { iconClass: string; icon: typeof TriangleAlert }
> = {
  warning: { iconClass: "text-orange", icon: TriangleAlert },
  danger: { iconClass: "text-red", icon: OctagonAlert },
  info: { iconClass: "text-ink-2", icon: Info },
}

function Banner({
  variant = "warning",
  onDismiss,
  dismissLabel,
  action,
  className,
  children,
  ...props
}: BannerProps) {
  const { iconClass, icon: Icon } = VARIANT_CLASS[variant]
  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="banner"
      data-variant={variant}
      className={cn(
        "flex min-w-0 items-start gap-3 rounded-card border border-line bg-inset p-3 text-ui text-ink",
        className
      )}
      {...props}
    >
      <Icon aria-hidden className={cn("mt-1.5 size-4 shrink-0", iconClass)} />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 min-h-7 flex-1 basis-48 content-center whitespace-normal [overflow-wrap:anywhere]">{children}</span>
        {action && <div data-slot="banner-action" className="flex max-w-full shrink-0 items-center gap-2">{action}</div>}
      </div>
      {onDismiss && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className="text-ink-2"
        >
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  )
}

export { Banner }
