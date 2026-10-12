import { type ComponentProps } from "react"
import { Check, Circle, LoaderCircle, X } from "lucide-react"
import { cn } from "../../lib/utils"

export interface TerminalOutputLine {
  id: string
  text: string
  tone?: "neutral" | "success" | "error"
}

export interface TerminalOutputProps extends Omit<ComponentProps<"section">, "children"> {
  label: string
  lines: readonly TerminalOutputLine[]
  state: "idle" | "running" | "success" | "error"
  statusLabel: string
}

/** A presentation of host-supplied output; never executes commands or invents progress. */
export function TerminalOutput({ label, lines, state, statusLabel, className, ...props }: TerminalOutputProps) {
  const StatusIcon = state === "running" ? LoaderCircle : state === "success" ? Check : state === "error" ? X : Circle
  return <section {...props} className={cn("g-terminal-output", className)} aria-label={label} data-state={state}>
    <header className="g-terminal-output-header">
      <span>{label}</span>
      <span role="status"><StatusIcon aria-hidden="true" />{statusLabel}</span>
    </header>
    <pre tabIndex={0} aria-label={label}><code>{lines.map(line => <span key={line.id} className="g-terminal-output-line" data-tone={line.tone ?? "neutral"}>{line.text}{"\n"}</span>)}</code></pre>
  </section>
}
