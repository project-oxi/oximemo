import * as React from "react"
import { ArrowUp, ChevronDown, Folder, Mic, Plus } from "lucide-react"

import { cn } from "../lib/utils"

/**
 * Garden Composer — Codex 홈 컴포저 계약(docs/EXPERIENCE.md §2):
 * radius composer(28, superellipse 느낌) + shadow-composer, 상단 워크스페이스
 * 칩, 하단 바 = [+ 첨부] [승인 모드 칩] [실행 위치 칩] — [모델 ▾] [마이크]
 * [전송 원형 28px]. 전송 버튼은 입력 없으면 고스트, 있으면 primary inverse.
 * 후속 입력 모드(queue/steer/interrupt)는 승인 모드 칩 옆 셀렉트로 노출.
 */
export type RunLocation = "local" | "worktree" | "cloud"

const RUN_LOCATION_LABEL: Record<RunLocation, string> = {
  local: "로컬",
  worktree: "워크트리",
  cloud: "클라우드",
}

function Chip({
  onClick,
  children,
  className,
}: {
  onClick?: () => void
  children: React.ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        "text-caption text-ink-2 hover:bg-hover hover:text-ink flex h-5 cursor-pointer items-center gap-1 rounded-chip px-1.5 transition-colors outline-none focus-visible:ring-ring/40 focus-visible:ring-[2px]",
        className
      )}
    >
      {children}
    </button>
  )
}

function GardenComposer({
  workspace = "Sandbox",
  model = "GPT-6 Sol",
  placeholder = "무엇이든, 요청하세요",
  onSubmit,
  className,
}: {
  workspace?: string
  model?: string
  placeholder?: string
  onSubmit?: (text: string) => void
  className?: string
}) {
  const [value, setValue] = React.useState("")
  const [autoApprove, setAutoApprove] = React.useState(true)
  const [location, setLocation] = React.useState<RunLocation>("local")
  const canSend = Boolean(onSubmit) && value.trim().length > 0

  const send = () => {
    if (!canSend) return
    onSubmit?.(value.trim())
    setValue("")
  }

  const cycleLocation = () => {
    const order: RunLocation[] = ["local", "worktree", "cloud"]
    setLocation(order[(order.indexOf(location) + 1) % order.length])
  }

  return (
    <div
      data-slot="garden-composer"
      className={cn(
        "bg-surface shadow-composer focus-within:border-line-strong flex flex-col gap-2 rounded-[28px] border border-transparent px-3 pt-2.5 pb-2 transition-colors outline-none",
        className
      )}
    >
      <Chip className="self-start">
        <Folder aria-hidden className="size-3" />
        {workspace}
      </Chip>

      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229
          ) {
            event.preventDefault()
            send()
          }
        }}
        placeholder={placeholder}
        rows={1}
        aria-label="프롬프트"
        className="placeholder:text-ink max-h-40 min-h-6 w-full resize-none bg-transparent px-1 text-ui text-ink outline-none"
      />

      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          aria-label="첨부"
          disabled
          className="text-ink-2 hover:bg-hover hover:text-ink flex size-7 cursor-pointer items-center justify-center rounded-control transition-colors outline-none focus-visible:ring-ring/40 focus-visible:ring-[2px]"
        >
          <Plus className="size-4" />
        </button>
        <Chip onClick={() => setAutoApprove((v) => !v)}>
          <span
            aria-hidden
            className={cn(
              "inline-block size-1.5 rounded-full",
              autoApprove ? "bg-green" : "bg-ink-3"
            )}
          />
          {autoApprove ? "나 대신 승인" : "매번 묻기"}
        </Chip>
        <Chip onClick={cycleLocation}>{RUN_LOCATION_LABEL[location]}</Chip>
        <Chip className="ml-auto">
          {model}
          <ChevronDown aria-hidden className="size-3" />
        </Chip>
        <button
          type="button"
          aria-label="받아쓰기"
          disabled
          className="text-ink-2 hover:bg-hover hover:text-ink flex size-7 cursor-pointer items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-ring/40 focus-visible:ring-[2px]"
        >
          <Mic className="size-4" />
        </button>
        <button
          type="button"
          aria-label="보내기"
          onClick={send}
          disabled={!canSend}
          className={cn(
            "flex size-7 cursor-pointer items-center justify-center rounded-full transition-all outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed",
            canSend
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "bg-hover-2 text-ink-3"
          )}
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </div>
  )
}

export { GardenComposer }
