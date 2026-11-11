/**
 * Task metadata chip: catalog icon + text value with due-date tone
 * (tasks spec §7.0). Icons come from the shared catalog; CM6 widgets
 * render the same glyphs via CSS masks (see lib/taskIcons.ts).
 *
 * 2026-11-11 : 톤을 색에서 글자 무게로 바꿨다. 앱 색이 무채색이라 error/warning 색은
 * 화면에서 「오늘」과 「지남」이 거의 같아 보였다. 지남은 글자(「3일 지남」)와 굵기,
 * 할 일 목록에서는 지금 선 위라는 위치가 말한다.
 */
import { TASK_FIELD_ICONS, type TaskIconField } from "../lib/taskIcons";
import type { DayTone } from "../lib/relativeDay";

const TONE_CLASS: Record<DayTone, string> = {
  overdue: "font-semibold text-text",
  today: "font-medium text-text",
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
