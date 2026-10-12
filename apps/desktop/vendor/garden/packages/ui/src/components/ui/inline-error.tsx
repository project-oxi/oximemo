import * as React from "react"
import { RefreshCw, TriangleAlert } from "lucide-react"

import { cn } from "../../lib/utils"
import { Button } from "./button"

/**
 * Garden InlineError — 섹션 데이터 실패의 인라인 표면
 * (docs/EXPERIENCE.md §5.1): role="alert" + 원인 한 줄 + Retry.
 * 전역 오류와 중첩하지 않는다.
 */
export type InlineErrorProps = React.ComponentProps<"div"> & {
  /** 재시도 진행 중 — 버튼 비활성 + 스피너 */
  pending?: boolean
} & (
  | { onRetry: () => void; retryLabel: string }
  | { onRetry?: undefined; retryLabel?: string }
)

function InlineError({
  children,
  onRetry,
  retryLabel,
  pending = false,
  className,
  ...props
}: InlineErrorProps) {
  return (
    <div
      role="alert"
      data-slot="inline-error"
      aria-busy={pending || undefined}
      className={cn(
        "flex min-w-0 items-start gap-3 text-ui text-ink",
        className
      )}
      {...props}
    >
      <TriangleAlert aria-hidden className="mt-1.5 size-4 shrink-0 text-red" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 min-h-7 flex-1 basis-48 content-center [overflow-wrap:anywhere]">{children}</span>
        {onRetry && (
          <Button
            type="button"
            variant="ghost"
            onClick={onRetry}
            disabled={pending}
            aria-busy={pending || undefined}
          >
            <RefreshCw
              aria-hidden
              className={cn("size-3", pending && "animate-spin")}
            />
            {retryLabel}
          </Button>
        )}
      </div>
    </div>
  )
}

export { InlineError }
