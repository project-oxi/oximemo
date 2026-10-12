import * as React from "react"

import { cn } from "../../lib/utils"

/**
 * Garden EmptyState — Codex 빈 상태 계약(docs/EXPERIENCE.md §5.2):
 * 아이콘 → 단문 제목 → "예시 프롬프트/다음 행동" 설명 → 생성 CTA.
 * 빈 상태와 로드 실패가 같은 슬롯을 공유한다.
 */
function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex w-full flex-col items-center justify-center px-4 py-8 text-center",
        className
      )}
      {...props}
    >
      <div className="flex w-full max-w-72 min-w-0 flex-col items-center gap-2 [overflow-wrap:anywhere]">
        {icon && <div aria-hidden="true" className="mb-2 flex size-10 items-center justify-center rounded-card bg-inset text-ink-2 [&_svg]:size-5">{icon}</div>}
        <div className="text-bodyLg font-medium text-ink">
          {title}
        </div>
        {description && (
          <div className="text-ui text-ink-2">{description}</div>
        )}
        {action && (
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {action}
          </div>
        )}
      </div>
    </div>
  )
}

export { EmptyState }
