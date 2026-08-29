/**
 * Sidebar tasks panel (T-사이드바): the slim companion to the full
 * `할 일` base view. Runs the installed `queries/할 일.query` against the
 * same `["base", sourceKey, idx, mtime]` cache key BaseView uses, so a
 * toggle here re-renders the main view's row (and vice-versa) without
 * a duplicate fetch. Filters out DONE/CANCELLED client-side (the base
 * filter restricts by date only), groups by overdue/today, and caps
 * height so a long backlog can't push the rest of the sidebar off
 * screen. The section header carries a `+` quick-add button (opens
 * the shared ⌘⇧T overlay via `useUI.quickAddOpen`) and a chevron that
 * opens the full tasks view in the main area.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus, SquareCheck } from "lucide-react";

import { runBase } from "../lib/api";
import { dayTone, relativeDayLabel, useTodayKey } from "../lib/relativeDay";
import { taskBucket } from "../lib/taskBucket";
import { useTaskToggle } from "../lib/taskToggle";
import { useOpenTask } from "../lib/taskNav";
import type { BasePage, BaseRow, RunBaseReq, TaskDto } from "../lib/types";
import { useUI } from "../stores/ui";
import { TaskCheckbox } from "./TaskCheckbox";
import { TaskFieldChip } from "./TaskFieldChip";
import { useI18n } from "../lib/i18n";

/** Vault-relative path of the installed `할 일` base — must match the
 *  Rust `TASKS_BASE_REL` seed and the sidebar's own TASKS_BASE_PATH. */
const TASKS_BASE_PATH = "queries/할 일.query";

/** View index 0 of the installed base = "오늘" (overdue + today).
 *  The base's own filter narrows to `due <= today || scheduled <= today`,
 *  so this panel does not need a second pass. */
const VIEW_INDEX = 0;

/** Hard row cap for the sidebar (the main view uses BaseView's pagination).
 *  Keeps a pathological backlog from blowing the sidebar height — past this
 *  the user clicks the chevron to open the full view. */
const ROW_CAP = 50;

/** Status types that count as still-open work (the base returns ALL rows
 *  matching the date filter; we hide terminal ones in the sidebar). */
function isOpen(statusType: TaskDto["status_type"]): boolean {
  return statusType !== "DONE" && statusType !== "CANCELLED";
}

export function TasksPanel() {
  const { t, locale } = useI18n();
  const openBase = useUI((s) => s.openBase);
  const setQuickAddOpen = useUI((s) => s.setQuickAddOpen);
  const setToast = useUI((s) => s.setToast);
  const todayISO = useTodayKey();

  // Share the cache key with BaseView so a toggle or query edit is a
  // single invalidate. The sidebar never reads the def, so we use a
  // fixed "sidebar" mtime marker — when BaseView invalidates ["base"]
  // on a patch_task or save_base, both surfaces refresh together.
  const runQ = useQuery<BasePage>({
    queryKey: ["base", TASKS_BASE_PATH, VIEW_INDEX, "sidebar"],
    queryFn: () => {
      const req: RunBaseReq = {
        viewIndex: VIEW_INDEX,
        offset: 0,
        // Over-fetch: the base returns ALL rows matching the date filter,
        // so we still leave ROW_CAP visible after dropping DONE/CANCELLED.
        limit: ROW_CAP * 2,
        group: null,
        nowMs: null,
        localOffsetSeconds: null,
        includeGroupCounts: false,
        includeSummaries: true,
        thisId: null,
      };
      return runBase({ Path: TASKS_BASE_PATH }, req);
    },
    enabled: true,
  });

  // Open rows only, grouped into overdue / today. The base's filter
  // already excludes future-dated tasks, so anything that survives is
  // either overdue or today by taskBucket.
  const { overdue, today } = useMemo<{ overdue: BaseRow[]; today: BaseRow[] }>(() => {
    const overdueRows: BaseRow[] = [];
    const todayRows: BaseRow[] = [];
    for (const row of runQ.data?.rows ?? []) {
      const task = row.task;
      if (!task) continue;
      if (!isOpen(task.status_type)) continue;
      const bucket = taskBucket(task, todayISO);
      if (bucket === "overdue") overdueRows.push(row);
      else if (bucket === "today") todayRows.push(row);
      // future / no_date: the base's filter excluded them, but skip defensively.
    }
    return {
      overdue: overdueRows.slice(0, ROW_CAP),
      today: todayRows.slice(0, ROW_CAP),
    };
  }, [runQ.data, todayISO]);

  const total = overdue.length + today.length;

  return (
    <section className="mt-3">
      <header className="flex items-center justify-between pr-3 pl-3">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
          {t.tasks_section}
          {total > 0 && (
            <span className="ml-1 text-text-subtle/70 font-normal normal-case">
              {total}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t.task_panel_quick_add}
            title={t.task_panel_quick_add}
            onClick={() => setQuickAddOpen(true)}
            className="grid size-5 place-items-center rounded-[var(--tag-radius)] text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text"
          >
            <Plus size={12} />
          </button>
          <button
            type="button"
            aria-label={t.task_panel_open_all}
            title={t.task_panel_open_all}
            onClick={() => openBase({ path: TASKS_BASE_PATH })}
            className="grid size-5 place-items-center rounded-[var(--tag-radius)] text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text"
          >
            <ChevronRight size={12} />
          </button>
        </div>
      </header>

      <div className="mt-1 max-h-[260px] overflow-y-auto px-2">
        {total === 0 ? (
          <div className="flex items-center gap-2 px-2 py-2 text-[11px] text-text-subtle/70">
            <SquareCheck size={12} aria-hidden className="shrink-0" />
            <span>{t.task_panel_empty}</span>
          </div>
        ) : (
          <>
            {overdue.length > 0 && (
              <BucketGroup
                label={t.task_group_overdue}
                tone="overdue"
                rows={overdue}
                locale={locale}
                todayISO={todayISO}
                onStale={() => setToast(t.task_conflict_reload)}
              />
            )}
            {today.length > 0 && (
              <BucketGroup
                label={t.task_group_today}
                tone="today"
                rows={today}
                locale={locale}
                todayISO={todayISO}
                onStale={() => setToast(t.task_conflict_reload)}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}

function BucketGroup({
  label,
  tone,
  rows,
  locale,
  todayISO,
  onStale,
}: {
  label: string;
  tone: "overdue" | "today";
  rows: BaseRow[];
  locale: "ko" | "en";
  todayISO: string;
  onStale: () => void;
}) {
  return (
    <div className="pt-1">
      <div className="flex items-baseline gap-2 px-2 pb-0.5">
        <h3
          className={`text-[10px] font-semibold uppercase tracking-wide ${
            tone === "overdue" ? "text-status-error" : "text-text-subtle"
          }`}
        >
          {label}
        </h3>
        <span className="text-[10px] text-text-subtle/70">{rows.length}</span>
      </div>
      {rows.map((row) => (
        <PanelTaskRow
          key={row.row_id}
          row={row}
          locale={locale}
          todayISO={todayISO}
          onStale={onStale}
        />
      ))}
    </div>
  );
}

function PanelTaskRow({
  row,
  locale,
  todayISO,
  onStale,
}: {
  row: BaseRow;
  locale: "ko" | "en";
  todayISO: string;
  onStale: () => void;
}) {
  const onToggle = useTaskToggle(row);
  const open = useOpenTask({ onStale });
  const task = row.task;
  if (!task) return null;
  // Prefer `due` for the chip label — it carries the day the work is owed,
  // matching the overdue/today grouping. Fall back to scheduled.
  const chipDate = task.due ?? task.scheduled;
  const dateField = task.due ? "due" : "scheduled";
  return (
    <button
      type="button"
      onClick={() => void open(task.task_ref)}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-text-muted transition-colors duration-150 hover:bg-surface-muted hover:text-text"
    >
      <span
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center"
      >
        <TaskCheckbox
          statusType={task.status_type}
          label={task.text}
          onToggle={onToggle}
        />
      </span>
      <span className="min-w-0 flex-1 truncate" title={task.text}>
        {task.text || "—"}
      </span>
      {chipDate && (
        <span className="shrink-0">
          <TaskFieldChip
            field={dateField}
            value={relativeDayLabel(chipDate, todayISO, locale)}
            tone={dayTone(chipDate, todayISO)}
          />
        </span>
      )}
    </button>
  );
}
