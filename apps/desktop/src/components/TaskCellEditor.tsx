/**
 * Typed task-cell editor (Plan C Task 6): one column property in
 * `task.status | task.due | task.scheduled | task.start | task.priority | task.text`
 * becomes a small editor that commits through `patch_task`. The shape:
 *
 *   - task.status → cycle button (commits `Toggle`; the kernel resolves the
 *     next symbol from its effective status table so the client doesn't
 *     need configured statuses).
 *   - task.due / task.scheduled / task.start → `<input type="date">` that
 *     commits `SetDate` with ISO "YYYY-MM-DD" or `null` on clear.
 *   - task.priority → select over the five PascalCase words; `None` clears.
 *   - task.text → text input that commits `SetText`.
 *
 * Every commit goes through `onChange(value: string | null)` so the parent
 * owns the wire-shape mapping (`editForCell`) and the optimistic-lock
 * toast; this component stays purely presentational.
 */
import type { BaseRow, TaskDto } from "../lib/types";

const PRIORITY_WORDS = ["Highest", "High", "Medium", "Low", "Lowest", "None"] as const;
type PriorityWord = (typeof PRIORITY_WORDS)[number];

const PRIORITY_LABELS: Record<PriorityWord, string> = {
  Highest: "highest",
  High: "high",
  Medium: "medium",
  Low: "low",
  Lowest: "lowest",
  None: "none",
};

const CAMEL_TO_PASCAL: Record<string, PriorityWord> = {
  highest: "Highest",
  high: "High",
  medium: "Medium",
  low: "Low",
  lowest: "Lowest",
  none: "None",
};

const TASK_DATE_KEYS: Record<string, keyof Pick<TaskDto, "due" | "scheduled" | "start">> = {
  due: "due",
  scheduled: "scheduled",
  start: "start",
};

export interface TaskCellEditorProps {
  row: BaseRow;
  propKey: string;
  /** String-list commits (date, priority word, text); null clears. */
  onChange: (value: string | null) => void;
}

export function TaskCellEditor({ row, propKey, onChange }: TaskCellEditorProps) {
  const task = row.task;
  if (!task) return null;

  if (propKey === "status") {
    return (
      <button
        type="button"
        onClick={() => onChange(null)}
        title={`[${task.symbol}] toggle`}
        className="rounded-[var(--tag-radius)] border border-line bg-surface px-1.5 py-0.5 font-mono text-[11px] text-text transition-colors duration-150 hover:border-line-strong"
      >
        {task.symbol === " " ? "□" : task.symbol}
      </button>
    );
  }

  const dateField = TASK_DATE_KEYS[propKey];
  if (dateField) {
    const value = task[dateField] ?? "";
    return (
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value || null)}
        className="bg-transparent px-1 py-0 text-[12px] text-text outline-none"
      />
    );
  }

  if (propKey === "priority") {
    // TaskDto.priority reads camelCase ("high"); the wire is PascalCase
    // ("High"). Map at the boundary so the parent's `editForCell` only
    // ever sees the wire word.
    const current: PriorityWord = CAMEL_TO_PASCAL[task.priority] ?? "None";
    return (
      <select
        value={current}
        onChange={(e) => onChange(e.target.value === "None" ? null : e.target.value)}
        className="bg-transparent px-1 py-0 text-[12px] text-text outline-none"
      >
        {PRIORITY_WORDS.map((w) => (
          <option key={w} value={w}>
            {PRIORITY_LABELS[w]}
          </option>
        ))}
      </select>
    );
  }

  if (propKey === "text") {
    return (
      <input
        type="text"
        defaultValue={task.text}
        onBlur={(e) => {
          if (e.target.value !== task.text) onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") (e.target as HTMLInputElement).blur();
        }}
        className="min-w-0 flex-1 bg-transparent px-1 py-0 text-[12px] text-text outline-none"
      />
    );
  }

  return null;
}
