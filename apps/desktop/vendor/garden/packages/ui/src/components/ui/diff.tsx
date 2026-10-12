import * as React from "react"

import { cn } from "../../lib/utils"

/**
 * Garden Diff — Codex 디프 뷰 계약(docs/EXPERIENCE.md §2, DESIGN §5):
 * mono 12px / line-height 1.8, 추가=green tint 필, 삭제=red tint 필,
 * 행 번호 최소 4ch, 표면은 surface 94% + fg 틴트. 굵은 보더 없음.
 * 승인 액션은 primary(승인)+tertiary(거부) — 색 도배 금지.
 */
export interface DiffLine {
  kind: "add" | "del" | "context"
  oldNumber?: number
  newNumber?: number
  content: string
}

interface DiffProps extends React.ComponentProps<"div"> {
  title?: string
  lines: DiffLine[]
}

const KIND_CLASS: Record<DiffLine["kind"], string> = {
  add: "bg-green-tint",
  del: "bg-red-tint",
  context: "",
}

function Diff({ title, lines, className, ...props }: DiffProps) {
  const added = lines.filter((l) => l.kind === "add").length
  const removed = lines.filter((l) => l.kind === "del").length

  return (
    <div
      data-slot="diff"
      className={cn(
        "border-line overflow-hidden rounded-card border",
        className
      )}
      style={{
        // 디프 서페이스 틴트: surface 94% + fg (Codex --diffs 규약)
        background: "color-mix(in srgb, var(--surface) 94%, var(--ink))",
      }}
      {...props}
    >
      {(title || added > 0 || removed > 0) && (
        <div className="border-line bg-inset flex items-center gap-2 border-b px-3 py-1.5">
          {title && (
            <span className="text-caption font-medium text-ink">{title}</span>
          )}
          <span className="ml-auto font-mono text-micro">
            {added > 0 && <span className="text-green">+{added}</span>}
            {added > 0 && removed > 0 && (
              <span className="text-ink-3"> · </span>
            )}
            {removed > 0 && <span className="text-red">−{removed}</span>}
          </span>
        </div>
      )}
      <div className="overflow-x-auto p-2" tabIndex={0} role={title || props["aria-label"] ? "region" : undefined} aria-label={props["aria-label"] ?? title}>
        {lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              "font-mono text-mono grid min-w-max grid-cols-[4ch_4ch_2ch_1fr] leading-[1.8]",
              KIND_CLASS[line.kind]
            )}
          >
            <span className="text-ink-3 select-none pr-2 text-right">
              {line.oldNumber ?? ""}
            </span>
            <span className="text-ink-3 select-none pr-2 text-right">
              {line.newNumber ?? ""}
            </span>
            <span className="text-ink-2 select-none">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
            <span className="text-ink whitespace-pre">{line.content}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export { Diff }
