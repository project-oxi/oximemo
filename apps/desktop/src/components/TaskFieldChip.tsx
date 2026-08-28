/**
 * Task metadata chip: catalog icon + text value with due-date tone
 * (tasks spec §7.0). Icons come from the shared catalog; CM6 widgets
 * render the same glyphs via CSS masks (see lib/taskIcons.ts).
 */
import { TASK_FIELD_ICONS, type TaskIconField } from "../lib/taskIcons";
import type { DayTone } from "../lib/relativeDay";

const TONE_CLASS: Record<DayTone, string> = {
  overdue: "text-status-error",
  today: "text-status-warning",
  future: "text-text-subtle",
};

export function TaskFieldChip({
  field,
  value,
  tone,
}: {
  field: TaskIconField;
  value: string;
  tone?: DayTone;
}) {
  const Icon = TASK_FIELD_ICONS[field].lucide;
  return (
    <span
      data-field={field}
      className={`inline-flex items-center gap-1 text-[11px] ${tone ? TONE_CLASS[tone] : "text-text-subtle"}`}
    >
      <Icon size={12} aria-hidden className="shrink-0" />
      <span>{value}</span>
    </span>
  );
}
