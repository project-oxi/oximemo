import * as React from "react"

import { cn } from "../lib/utils"

/**
 * Garden TurnStream — Codex 스트리밍 디테일 3단 계약
 * (docs/EXPERIENCE.md §2): 같은 턴을 산문/커맨드/실행 출력 3단 밀도로.
 * `conversationDetailMode: STEPS_PROSE | STEPS_COMMANDS | STEPS_EXECUTION`의
 * Garden 표현. reasoning은 스트리밍 중 ink-2, 커맨드는 mono, 출력 상한 도달은
 * `[output truncated]` 마커를 상단에 붙인다.
 */
export type TurnDetailMode = "prose" | "commands" | "execution"

export type TurnItem =
  | { type: "userMessage"; text: string }
  | { type: "agentMessage"; text: string; phase?: "final_answer" | null }
  | { type: "reasoning"; text: string }
  | {
      type: "commandExecution"
      command: string
      output?: string
      truncated?: boolean
      failed?: boolean
    }
  | { type: "plan"; text: string }

function TurnStream({
  mode,
  items,
  className,
  strings = { failed: "Failed", completed: "Completed", truncated: "[output truncated]" },
}: {
  mode: TurnDetailMode
  items: TurnItem[]
  className?: string
  strings?: { failed: string; completed: string; truncated: string }
}) {
  return (
    <div
      data-slot="turn-stream"
      data-mode={mode}
      className={cn("flex flex-col gap-2", className)}
    >
      {items.map((item, i) => (
        <TurnCell key={i} mode={mode} item={item} strings={strings} />
      ))}
    </div>
  )
}

function TurnCell({ mode, item, strings }: { mode: TurnDetailMode; item: TurnItem; strings: { failed: string; completed: string; truncated: string } }) {
  switch (item.type) {
    case "userMessage":
      return (
        <div className="text-ui font-medium text-ink">{item.text}</div>
      )
    case "agentMessage":
      if (mode === "commands") {
        return (
          <div className="text-caption text-ink-2 truncate">
            {item.text}
          </div>
        )
      }
      return <div className="text-ui text-ink">{item.text}</div>
    case "reasoning":
      if (mode === "prose") {
        return (
          <div className="text-caption text-ink-2">{item.text}</div>
        )
      }
      return (
        <div className="text-micro text-ink-3 truncate">{item.text}</div>
      )
    case "plan":
      return <div className="text-caption text-ink">{item.text}</div>
    case "commandExecution": {
      if (mode === "prose") {
        return (
          <div className="flex items-center gap-1.5 text-caption">
            <span
              role="img" aria-label={item.failed ? strings.failed : strings.completed}
              className={cn(
                "inline-block size-1.5 rounded-full",
                item.failed ? "bg-red" : "bg-green"
              )}
            />
            <span className="font-mono text-ink truncate">{item.failed && <span aria-hidden="true">× </span>}{item.command}</span>
          </div>
        )
      }
      return (
        <div className="bg-inset overflow-hidden rounded-control">
          <div className="text-mono flex h-7 items-center gap-2 px-2 text-ink">
            <span
              role="img" aria-label={item.failed ? strings.failed : strings.completed}
              className={cn(
                "inline-block size-1.5 shrink-0 rounded-full",
                item.failed ? "bg-red" : "bg-green"
              )}
            />
            <span className="truncate">{item.failed && <span aria-hidden="true">× </span>}{item.command}</span>
          </div>
          {mode === "execution" && item.output !== undefined && (
            <div className="border-line border-t px-2 py-1.5">
              {item.truncated && (
                <div className="text-micro text-ink-3 mb-1 font-medium">
                  {strings.truncated}
                </div>
              )}
              <pre tabIndex={0} aria-label={item.command} className="text-mono text-ink-2 overflow-x-auto whitespace-pre">
                {item.output}
              </pre>
            </div>
          )}
        </div>
      )
    }
  }
}

export { TurnStream }
