/**
 * Sidebar tasks panel (T-사이드바): the slim companion to the full
 * `할 일` base view. Runs the installed `queries/할 일.query` against the
 * same `["base", sourceKey, idx, mtime]` cache key BaseView uses, so a
 * toggle here re-renders the main view's row (and vice-versa) without
 * a duplicate fetch. Two views feed the panel: 오늘 (index 0, overdue +
 * due/scheduled-today) and 날짜 없음 (resolved BY NAME from the def —
 * seed v2 appends it; quick-added tasks carry neither date, so this is
 * the only sidebar surface where they appear). DONE/CANCELLED drop
 * client-side, rows group into the three buckets, and height caps keep
 * a long backlog from pushing the rest of the sidebar off screen. The
 * section header carries a `+` quick-add button (opens the shared
 * ⌘⇧T overlay via `useUI.quickAddOpen`) and a chevron that opens the
 * full tasks view in the main area.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus, SquareCheck } from "lucide-react";
import YAML from "yaml";

import { loadBase, runBase } from "../lib/api";
import { dayTone, relativeDayLabel, useTodayKey } from "../lib/relativeDay";
import { noDateViewIndex, partitionPanelRows } from "../lib/tasksPanel";
import { useTaskToggle } from "../lib/taskToggle";
import { useOpenTask } from "../lib/taskNav";
import type { BaseDef, BasePage, BaseRow, RunBaseReq } from "../lib/types";
import { useUI } from "../stores/ui";
import { TaskCheckbox } from "./TaskCheckbox";
import { TaskFieldChip } from "./TaskFieldChip";
import { useI18n } from "../lib/i18n";

/** Vault-relative path of the installed `할 일` base — must match the
 *  Rust `TASKS_BASE_REL` seed and the sidebar's own TASKS_BASE_PATH. */
const TASKS_BASE_PATH = "queries/할 일.query";

/** View index 0 of the installed base = "오늘" (overdue + today). The
 *  base's own filter narrows to `due <= today || scheduled <= today`.
 *  The 날짜 없음 view is NOT a fixed index — it is resolved by name
 *  from the def below (seed v2 appends it after any user views). */
const VIEW_INDEX = 0;

/** Hard row cap for the sidebar (the main view uses BaseView's pagination).
 *  Keeps a pathological backlog from blowing the sidebar height — past this
 *  the user clicks the chevron to open the full view. */
const ROW_CAP = 50;


export function TasksPanel() {
  const { t, locale } = useI18n();
  const openBase = useUI((s) => s.openBase);
  const setQuickAddOpen = useUI((s) => s.setQuickAddOpen);
  const setToast = useUI((s) => s.setToast);
  const todayISO = useTodayKey();
  // The installed base's def — resolves the 날짜 없음 view by name.
  // A pre-v2 base (or a user rename) resolves to -1 and simply hides
  // the undated bucket. Shares BaseView's ["bases", "def", …] family
  // so a query edit refreshes both surfaces.
  const defQ = useQuery({
    queryKey: ["bases", "def", TASKS_BASE_PATH],
    queryFn: () => loadBase(TASKS_BASE_PATH),
  });
  const noDateIdx = useMemo(() => {
    if (!defQ.data) return -1;
    try {
      return noDateViewIndex(YAML.parse(defQ.data.yaml) as BaseDef | null);
    } catch {
      return -1;
    }
  }, [defQ.data]);

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
  // 날짜 없음 (undated backlog): engine-filtered by the seed-v2 view
  // resolved above; disabled while the def is loading or lacks it.
  const undatedQ = useQuery<BasePage>({
    queryKey: ["base", TASKS_BASE_PATH, noDateIdx, "sidebar-no-date"],
    queryFn: () => {
      const req: RunBaseReq = {
        viewIndex: noDateIdx,
        offset: 0,
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
    enabled: noDateIdx >= 0,
  });

  // Open rows grouped into overdue / today / 날짜 없음. Each view's
  // filter pre-narrows its rows; partitionPanelRows drops terminal
  // statuses and defensively skips any row that lands in the wrong
  // input, capping each bucket at ROW_CAP.
  const { overdue, today, noDate } = useMemo(
    () =>
      partitionPanelRows(
        runQ.data?.rows ?? [],
        undatedQ.data?.rows ?? [],
        todayISO,
        ROW_CAP,
      ),
    [runQ.data, undatedQ.data, todayISO],
  );

  const total = overdue.length + today.length + noDate.length;

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
            {noDate.length > 0 && (
              <BucketGroup
                label={t.task_group_no_date}
                tone="neutral"
                rows={noDate}
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
  tone: "overdue" | "today" | "neutral";
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
