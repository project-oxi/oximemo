/**
 * Task checkbox as a real control, not a glyph (tasks spec §7.0):
 * `<button role="checkbox" aria-checked>` — keyboard-focusable, with
 * focus-visible ring per the token rules. The mark is Check (done),
 * Minus (cancelled), or a half-fill (in progress).
 */
import { Check, Minus } from "lucide-react";

import type { StatusType } from "../lib/taskLine";
import { useChangedSinceMount } from "../lib/workspaceMotion";

/** Which inner mark a status type draws; `null` = empty box. */
export function statusMark(statusType: StatusType): "check" | "minus" | "half" | null {
  switch (statusType) {
    case "DONE":
      return "check";
    case "CANCELLED":
      return "minus";
    case "IN_PROGRESS":
      return "half";
    default:
      return null;
  }
}

function ariaChecked(statusType: StatusType): "true" | "mixed" | "false" {
  if (statusType === "DONE" || statusType === "CANCELLED") return "true";
  if (statusType === "IN_PROGRESS") return "mixed";
  return "false";
}

export function TaskCheckbox({
  statusType,
  label,
  onToggle,
  disabled,
}: {
  statusType: StatusType;
  label: string;
  onToggle: () => void;
  disabled?: boolean;
}) {
  const mark = statusMark(statusType);
  // 표시가 바뀔 때마다 조건부 요소가 새로 붙으므로, 클래스만 달면 바뀐 순간에 한 번 튄다.
  const pop = useChangedSinceMount(mark) ? " motion-pop" : "";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={ariaChecked(statusType)}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className="relative inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-line-strong bg-transparent transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:pointer-events-none disabled:opacity-30"
    >
      {mark === "check" && <Check size={12} strokeWidth={3} aria-hidden className={`text-status-success${pop}`} />}
      {mark === "minus" && <Minus size={12} strokeWidth={3} aria-hidden className={`text-text-muted${pop}`} />}
      {mark === "half" && (
        <span aria-hidden className={`absolute inset-y-[2px] left-[2px] w-[5px] rounded-[2px] bg-status-info${pop}`} />
      )}
    </button>
  );
}
