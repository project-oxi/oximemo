/**
 * TasksView — the `type: tasks` checkbox-list view (tasks spec §7.4).
 *
 * Rows arrive from BaseView's shared `run_base` query (the view def
 * owns filtering/ordering/paging); this surface lays them out as one
 * 「지금 선 레인」 NowLane (2026-11-11) via the pure `buildLane` helper
 * (`due` with `scheduled` fallback). 묶음 머리 여섯 개를 지금 선 하나로
 * 바꿨다 — 무채색 앱에서 「지남」 색 칩은 「오늘」과 구분되지 않았다.
 * 선 위 = 늦은 것(가장 늦은 것이 맨 위 · 계단 막대 + 「N일 지남」),
 * 선 아래 = 오늘부터 가까운 순(행 사이 간격이 남은 날을 말한다),
 * 날짜 없음은 맨 아래 접힌 한 줄. 같은 날 안에서는 우선순위 순.
 *
 * The checkbox toggles through the guarded `patch_task` + `["base"]`
 * invalidate path every other view shares (`useTaskToggle`); a row
 * click opens the parent note scrolled to the task's line (`openTask`'s
 * hash-repair flow). Right-click opens the shared task row menu and
 * the pencil opens the edit popover.
 */
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";

import { getConfig } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { buildLane, type LaneEntry } from "../../lib/nowLane";
import { relativeDayLabel, useTodayKey } from "../../lib/relativeDay";
import { cfgFromJson } from "../../lib/taskLine";
import { initialFromDto } from "../../lib/taskPopoverSeed";
import { useTaskEditMany, useTaskToggle } from "../../lib/taskToggle";
import { useOpenTask } from "../../lib/taskNav";
import type { BaseRow, TaskDto } from "../../lib/types";
import type { TaskIconField } from "../../lib/taskIcons";
import { useUI } from "../../stores/ui";
import { CtxRoot, CtxTrigger } from "../ContextMenu";
import { LaneNowRule, LatenessBar, UndatedFold, laneDayLabel } from "../NowLane";
import { TaskCheckbox } from "../TaskCheckbox";
import { TaskEditPopover } from "../TaskEditPopover";
import { TaskFieldChip } from "../TaskFieldChip";
import { TaskRowCtxMenu } from "../TaskRowCtxMenu";

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
  const { t, locale } = useI18n();
  const todayISO = useTodayKey();
  const lane = useMemo(() => buildLane(rows, todayISO), [rows, todayISO]);
  const total = lane.overdue.length + lane.upcoming.length + lane.undated.length;
  if (total === 0) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-4 py-8">
        <p className="text-sm text-text-subtle">{t.tasks_view_empty}</p>
        <button type="button" onClick={() => useUI.getState().setQuickAddOpen(true)}
          className="rounded-[var(--button-radius)] bg-interactive-primary px-3 py-1.5 text-xs font-medium text-interactive-primary-foreground">
          {t.task_panel_quick_add}
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col pt-1 pb-2">
      {lane.overdue.length > 0 && (
        <ul aria-label={t.task_group_overdue}>
          {lane.overdue.map((entry) => (
            <TasksRow key={entry.row.row_id} entry={entry} />
          ))}
        </ul>
      )}
      <div className="px-4">
        <LaneNowRule todayISO={todayISO} locale={locale} t={t} />
      </div>
      {lane.upcoming.length > 0 && (
        <ul>
          {lane.upcoming.map((entry) => (
            <TasksRow key={entry.row.row_id} entry={entry} />
          ))}
        </ul>
      )}
      <div className="mt-3">
        <UndatedFold count={lane.undated.length} t={t}>
          <ul aria-label={t.task_group_no_date}>
            {lane.undated.map((row) => (
              <TasksRow key={row.row_id} entry={{ row, diff: 0, gap: 0, steps: 0, sameDayAsPrev: false }} undated />
            ))}
          </ul>
        </UndatedFold>
      </div>
    </div>
  );
}

/** One task row: checkbox + description + chips + 날짜 끝자리 + parent-note
 *  breadcrumb + pencil. The text button opens the task's line in its
 *  note; the checkbox and pencil are sibling buttons so toggling or
 *  editing never navigates. */
function TasksRow({ entry, undated }: { entry: LaneEntry<BaseRow>; undated?: boolean }) {
  const { row, diff, gap, steps, sameDayAsPrev } = entry;
  const onToggle = useTaskToggle(row);
  const commitEdits = useTaskEditMany(row);
  const setToast = useUI((s) => s.setToast);
  const { locale, t } = useI18n();
  const open = useOpenTask({ onStale: () => setToast(t.task_conflict_reload) });
  const todayISO = useTodayKey();
  const cfgQ = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const cfg = useMemo(() => (cfgQ.data?.tasks ? cfgFromJson(cfgQ.data.tasks) : null), [cfgQ.data]);
  const [editOpen, setEditOpen] = useState(false);
  const editAnchorRef = useRef<HTMLButtonElement | null>(null);
  const task = row.task;
  // 열려 있는 동안 다시 그려져도 초안이 지워지지 않게 — 팝오버는 initial 이 바뀌면 초안을 새로 채운다.
  const initial = useMemo(() => (task ? initialFromDto(task) : null), [task]);
  if (!task || !initial) return null;
  const title =
    row.summary.title ?? row.summary.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  const priority = priorityIconField(task.priority);
  const eff = task.due ?? task.scheduled;
  // 행 끝 날짜가 이미 기한(없으면 예정)을 말한다. 예정 칩은 기한과 다른 날일 때만 정보가 된다.
  const showScheduled = task.due !== null && task.scheduled !== null && task.scheduled !== task.due;
  const done = task.status_type === "DONE" || task.status_type === "CANCELLED";
  const dayLabel = eff ? (diff < 0 ? relativeDayLabel(eff, todayISO, locale) : laneDayLabel(eff, todayISO, locale)) : "";
  return (
    <li style={gap > 0 ? { marginTop: gap } : undefined}>
      <CtxRoot>
        <CtxTrigger
          render={
            <div className="group flex w-full items-center gap-3 rounded-md px-4 py-1.5 transition-colors duration-150 hover:bg-surface-muted/60" />
          }
        >
          <TaskCheckbox
            statusType={task.status_type}
            label={task.text}
            onToggle={onToggle}
          />
          <button
            type="button"
            onClick={() => void open(task.task_ref)}
            className={`min-w-0 flex-1 truncate text-left text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${done ? "text-text-subtle line-through" : "text-text"}`}
            title={task.text}
          >
            {task.text || "—"}
          </button>
          <span className="flex shrink-0 items-center gap-1.5">
            {showScheduled && (
              <TaskFieldChip
                field="scheduled"
                value={relativeDayLabel(task.scheduled!, todayISO, locale)}
              />
            )}
            {priority && <TaskFieldChip field={priority} value="" />}
            {task.recurrence && <TaskFieldChip field="recurrence" value={task.recurrence} />}
          </span>
          {!undated && (
            <span className="flex w-28 shrink-0 items-center justify-end gap-1.5 text-[11px] tabular-nums">
              {steps > 0 && <LatenessBar steps={steps} />}
              {/* 같은 날이 이어지면 글자는 첫 행만 — 간격 0 이 같은 날임을 말한다. 낭독기에는 그대로 읽힌다. */}
              <span className={sameDayAsPrev ? "sr-only" : steps > 0 ? "font-semibold text-text" : "text-text-subtle"}>
                {dayLabel}
              </span>
            </span>
          )}
          <span className="w-24 shrink-0 truncate text-[11px] text-text-subtle" title={title}>
            @ {title}
          </span>
          <button
            ref={editAnchorRef}
            type="button"
            aria-label={t.task_edit}
            title={t.task_edit}
            onClick={() => setEditOpen((o) => !o)}
            className="invisible shrink-0 rounded-[var(--tag-radius)] p-1 text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text group-hover:visible focus-visible:visible"
          >
            <Pencil size={12} />
          </button>
          <TaskRowCtxMenu
            done={task.status_type === "DONE"}
            text={task.text}
            onOpen={() => void open(task.task_ref)}
            onToggle={onToggle}
          />
        </CtxTrigger>
      </CtxRoot>
      {cfg && editOpen && (
        <TaskEditPopover
          open={editOpen}
          onOpenChange={(o) => {
            setEditOpen(o);
            // Esc · 바깥 클릭으로 닫으면 연필로 초점을 돌린다 — 키보드 사용자가 자리를 잃지 않게.
            if (!o) editAnchorRef.current?.focus();
          }}
          anchor={editAnchorRef.current}
          initial={initial}
          cfg={cfg}
          todayISO={todayISO}
          onCommit={(edits) => commitEdits(edits)}
        />
      )}
    </li>
  );
}
