import * as React from "react"
import { Terminal } from "lucide-react"

import { cn } from "../lib/utils"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { SegmentedControl } from "./ui/segmented-control"

/**
 * Garden ApprovalDecision — Codex 승인 결정 계약(docs/EXPERIENCE.md §2):
 * 커맨드/파일 변경 승인 요청에 decision(allow/deny) × 지속(한 번만/이 대화/항상)
 * + 사유(거부 시)로 응답한다. 키 규약: Enter=승인, Escape=거부.
 * 300초 타임아웃/timeout decision은 호출자(런타임) 책임.
 */
export type ApprovalPersistence = "once" | "conversation" | "always"

export interface ApprovalDecision {
  allow: boolean
  persistence: ApprovalPersistence
  reason?: string
}

const PERSISTENCE_LABEL: Record<ApprovalPersistence, string> = {
  once: "한 번만",
  conversation: "이 대화",
  always: "항상",
}

function ApprovalDecisionCard({
  title,
  detail,
  onDecision,
  className,
}: {
  /** 승인 대상 요약 — 커맨드라인이면 mono로 렌더 */
  title: string
  /** 명령 출력/파일 목록 등 보조 설명 */
  detail?: string
  onDecision: (decision: ApprovalDecision) => void
  className?: string
}) {
  const [persistence, setPersistence] =
    React.useState<ApprovalPersistence>("once")
  const [reason, setReason] = React.useState("")

  const decide = (allow: boolean) =>
    onDecision({
      allow,
      persistence,
      reason: allow || !reason.trim() ? undefined : reason.trim(),
    })

  return (
    <div
      role="group"
      aria-label={title}
      tabIndex={0}
      onKeyDown={(event) => {
        // IME 조합 중 키 무시(§4.3), 인터랙티브 자식에서의 Enter는 위임하지 않음
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.target !== event.currentTarget)
          return
        if (event.key === "Enter") {
          event.preventDefault()
          decide(true)
        } else if (event.key === "Escape") {
          event.preventDefault()
          decide(false)
        }
      }}
      data-slot="approval-decision"
      className={cn(
        "bg-surface focus-visible:ring-ring/40 w-80 max-w-full rounded-xl border border-line-strong p-4 shadow-overlay outline-none focus-visible:ring-[2px]",
        className
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className="bg-inset text-ink-2 flex size-7 shrink-0 items-center justify-center rounded-control">
          <Terminal aria-hidden className="size-3.5" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-caption font-medium text-ink">{title}</span>
          {detail && (
            <span className="text-mono font-mono text-ink-2 break-all">
              {detail}
            </span>
          )}
        </div>
      </div>

      <SegmentedControl
        aria-label="허용 범위"
        className="mt-3 w-full"
        value={persistence}
        onValueChange={setPersistence}
        options={(Object.keys(PERSISTENCE_LABEL) as ApprovalPersistence[]).map(value => ({ value, label: PERSISTENCE_LABEL[value] }))}
      />

      <Input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="사유 (거부 시)"
        className="mt-3"
        aria-label="거부 사유"
      />

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-keyshortcuts="Escape"
          onClick={() => decide(false)}
        >
          거부
        </Button>
        <Button
          type="button"
          size="sm"
          aria-keyshortcuts="Enter"
          onClick={() => decide(true)}
        >
          허용
        </Button>
      </div>
    </div>
  )
}

export { ApprovalDecisionCard }
