import { useEffect, useRef, useState, type ComponentProps } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "./button"
import { cn } from "../../lib/utils"

export interface CopyCommandProps extends Omit<ComponentProps<"div">, "children" | "onCopy"> {
  command: string
  label: string
  copyLabel: string
  copyingLabel: string
  copiedLabel: string
  errorLabel: string
  /** Hosts may supply a native clipboard bridge; the browser clipboard is the default. */
  onCopy?: (command: string) => Promise<void>
}

/** Copy the exact displayed command. Execution always belongs to the host. */
export function CopyCommand({ command, label, copyLabel, copyingLabel, copiedLabel, errorLabel, onCopy, className, ...props }: CopyCommandProps) {
  const [result, setResult] = useState<{ command: string; status: "copying" | "copied" | "error" } | null>(null)
  const request = useRef(0)
  const pending = useRef(false)
  useEffect(() => {
    request.current += 1
    pending.current = false
    setResult(null)
    return () => { request.current += 1; pending.current = false }
  }, [command])
  const status = result?.command === command ? result.status : null
  const copy = async () => {
    if (pending.current) return
    pending.current = true
    const id = ++request.current
    setResult({ command, status: "copying" })
    try {
      if (onCopy) await onCopy(command)
      else await navigator.clipboard.writeText(command)
      if (id === request.current) setResult({ command, status: "copied" })
    } catch {
      if (id === request.current) setResult({ command, status: "error" })
    } finally {
      if (id === request.current) pending.current = false
    }
  }
  return <div {...props} className={cn("g-copy-command", className)} role="group" aria-label={label}>
    <div className="g-copy-command-row">
      <pre><code>{command}</code></pre>
      <Button type="button" variant="ghost" onClick={copy} disabled={status === "copying"}>
        {status === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {status === "copying" ? copyingLabel : status === "copied" ? copiedLabel : copyLabel}
      </Button>
    </div>
    <span className="g-copy-command-status" role="status" data-error={status === "error" || undefined}>
      {status === "error" ? errorLabel : status === "copied" ? copiedLabel : ""}
    </span>
  </div>
}
