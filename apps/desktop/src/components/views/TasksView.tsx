/**
 * TasksView — the `type: tasks` checkbox-list view (tasks spec §7.4).
 *
 * Rows arrive from BaseView's shared `run_base` query (the view def
 * owns filtering/ordering/paging); this surface only GROUPS them under
 * the spec's default section headers via the pure `taskBucket` helper
 * (`due` with `scheduled` fallback, Sunday-first week). The checkbox
 * toggles through the guarded `patch_task` + `["base"]` invalidate
 * path every other view shares (`useTaskToggle`); a row click opens
 * the parent note scrolled to the task's line (`openTask`'s
 * hash-repair flow).
 */
import { useI18n, type Dict } from "../../lib/i18n";
import { dayTone, relativeDayLabel, useTodayKey } from "../../lib/relativeDay";
import { taskBucket, type TaskBucket } from "../../lib/taskBucket";
import { useTaskToggle } from "../../lib/taskToggle";
import { useOpenTask } from "../../lib/taskNav";
import type { BaseRow, TaskDto } from "../../lib/types";
import type { TaskIconField } from "../../lib/taskIcons";
import { useUI } from "../../stores/ui";
import { TaskCheckbox } from "../TaskCheckbox";
import { TaskFieldChip } from "../TaskFieldChip";

/** Section render order (spec §7.4 default grouping). */
const ORDER: TaskBucket[] = ["overdue", "today", "tomorrow", "this_week", "later", "no_date"];

function groupLabel(t: Dict, bucket: TaskBucket): string {
  switch (bucket) {
    case "overdue": return t.task_group_overdue;
    case "today": return t.task_group_today;
    case "tomorrow": return t.task_group_tomorrow;
    case "this_week": return t.task_group_this_week;
    case "later": return t.task_group_later;
    case "no_date": return t.task_group_no_date;
  }
}

function priorityIconField(priority: TaskDto["priority"]): TaskIconField | null {
  switch (priority) {
    case "highest": return "priority-highest";
    case "high": return "priority-high";
    case "medium": return "priority-medium";
    case "low": return "priority-low";
    case "lowest": return "priority-lowest";
    default: return null;
  }
}

export function TasksView({ rows }: { rows: BaseRow[] }) {
  const { t } = useI18n();
  const todayISO = useTodayKey();
  const byBucket = new Map<TaskBucket, BaseRow[]>();
  for (const row of rows) {
    if (!row.task) continue;
    const bucket = taskBucket(row.task, todayISO);
    const group = byBucket.get(bucket);
    if (group) group.push(row);
    else byBucket.set(bucket, [row]);
  }
  return (
    <div className="flex flex-col pb-2">
      {ORDER.map((bucket) => {
        const group = byBucket.get(bucket);
        if (!group?.length) return null;
        const label = groupLabel(t, bucket);
        return (
          <section key={bucket} aria-label={label}>
            <div className="flex items-baseline gap-2 px-4 pt-2 pb-1">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-subtle">{label}</h3>
              <span className="text-[10px] text-text-subtle/70">{group.length}</span>
            </div>
            {group.map((row) => (
              <TasksRow key={row.row_id} row={row} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

/** One task row: checkbox + description + field chips + parent-note
 *  breadcrumb. The whole row opens the task's line in its note; the
 *  checkbox click is captured so toggling never navigates. */
function TasksRow({ row }: { row: BaseRow }) {
  const onToggle = useTaskToggle(row);
  const setToast = useUI((s) => s.setToast);
  const { locale, t } = useI18n();
  const open = useOpenTask({ onStale: () => setToast(t.task_conflict_reload) });
  const todayISO = useTodayKey();
  const task = row.task;
  if (!task) return null;
  const title =
    row.summary.title ?? row.summary.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  const priority = priorityIconField(task.priority);
  return (
    <button
      type="button"
      onClick={() => void open(task.task_ref)}
      className="flex w-full items-baseline gap-3 rounded-md px-4 py-1.5 text-left transition-colors duration-150 hover:bg-surface-muted/60"
    >
      <span onClick={(e) => e.stopPropagation()} className="inline-flex items-baseline">
        <TaskCheckbox
          statusType={task.status_type}
          label={task.text}
          onToggle={onToggle}
        />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-text" title={task.text}>
        {task.text || "—"}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {task.scheduled && (
          <TaskFieldChip
            field="scheduled"
            value={relativeDayLabel(task.scheduled, todayISO, locale)}
            tone={dayTone(task.scheduled, todayISO)}
          />
        )}
        {task.due && (
          <TaskFieldChip
            field="due"
            value={relativeDayLabel(task.due, todayISO, locale)}
            tone={dayTone(task.due, todayISO)}
          />
        )}
        {priority && <TaskFieldChip field={priority} value="" />}
        {task.recurrence && <TaskFieldChip field="recurrence" value={task.recurrence} />}
      </span>
      <span className="w-24 shrink-0 truncate text-[11px] text-text-subtle" title={title}>
        @ {title}
      </span>
    </button>
  );
}
