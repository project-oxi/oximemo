/**
 * Sidebar tasks panel (T-사이드바): the slim companion to the full
 * `할 일` base view. Runs the installed `queries/할 일.query` against the
 * same `["base", sourceKey, idx, mtime]` cache key BaseView uses, so a
 * toggle here re-renders the main view's row (and vice-versa) without
 * a duplicate fetch. Three views feed the panel: 오늘 (index 0, overdue +
 * due/scheduled-today), 예정 (resolved BY NAME — supplies tomorrow) and
 * 날짜 없음 (resolved BY NAME from the def — seed v2 appends it;
 * quick-added tasks carry neither date, so this is the only sidebar
 * surface where they appear). DONE/CANCELLED drop client-side and the
 * rows lay out as the NowLane slice (2026-11-11 · 할 일 화면과 같은 모양을
 * 지금 ±2일만 잘라 쓴다): 지난 것은 개수와 가장 늦은 것 몇 개, 지금 선
 * 아래 오늘 · 내일, 날짜 없음은 접힌 한 줄. The height cap keeps a long
 * backlog from pushing the rest of the sidebar off screen. The
 * section header carries a `+` quick-add button (opens the shared
 * ⌘⇧T overlay via `useUI.quickAddOpen`) and a chevron that opens the
 * full tasks view in the main area.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus, SquareCheck } from "lucide-react";
import YAML from "yaml";

import { loadBase, runBase } from "../lib/api";
import { panelSlice, type LaneEntry } from "../lib/nowLane";
import { relativeDayLabel, useTodayKey } from "../lib/relativeDay";
import { noDateViewIndex, TASKS_BASE_PATH, upcomingViewIndex } from "../lib/tasksPanel";
import { useTaskToggle } from "../lib/taskToggle";
import { useOpenTask } from "../lib/taskNav";
import type { BaseDef, BasePage, BaseRow, RunBaseReq } from "../lib/types";
import { useUI } from "../stores/ui";
import { TaskCheckbox } from "./TaskCheckbox";
import { TaskRowCtxMenu } from "./TaskRowCtxMenu";
import { CtxRoot, CtxTrigger } from "./ContextMenu";
import { useI18n } from "../lib/i18n";
import { LaneNowRule, LatenessBar, UndatedFold, laneDayLabel } from "./NowLane";

/** View index 0 of the installed base = "오늘" (overdue + today). The
 *  base's own filter narrows to `due <= today || scheduled <= today`.
 *  The 예정 and 날짜 없음 views are NOT fixed indices — they are
 *  resolved by name from the def below. */
const VIEW_INDEX = 0;

/** Hard row cap for the sidebar (the main view uses BaseView's pagination).
 *  Keeps a pathological backlog from blowing the sidebar height — past this
 *  the user clicks the chevron to open the full view. */
const ROW_CAP = 50;

/** One `run_base` request body; only the view index differs per query. */
function panelReq(viewIndex: number, limit: number): RunBaseReq {
  return {
    viewIndex,
    offset: 0,
    limit,
    group: null,
    nowMs: null,
    localOffsetSeconds: null,
    includeGroupCounts: false,
    includeSummaries: true,
    thisId: null,
  };
}

export function TasksPanel() {
  const { t, locale } = useI18n();
  const openBase = useUI((s) => s.openBase);
  const setQuickAddOpen = useUI((s) => s.setQuickAddOpen);
  const setToast = useUI((s) => s.setToast);
  const todayISO = useTodayKey();
  // The installed base's def — resolves the 예정 / 날짜 없음 views by
  // name. A pre-v2 base (or a user rename) resolves to -1 and simply
  // hides that part of the slice. Shares BaseView's ["bases", "def", …]
  // family so a query edit refreshes both surfaces.
  const defQ = useQuery({
    queryKey: ["bases", "def", TASKS_BASE_PATH],
    queryFn: () => loadBase(TASKS_BASE_PATH),
  });
  const { noDateIdx, upcomingIdx } = useMemo(() => {
    if (!defQ.data) return { noDateIdx: -1, upcomingIdx: -1 };
    try {
      const def = YAML.parse(defQ.data.yaml) as BaseDef | null;
      return { noDateIdx: noDateViewIndex(def), upcomingIdx: upcomingViewIndex(def) };
    } catch {
      return { noDateIdx: -1, upcomingIdx: -1 };
    }
  }, [defQ.data]);

  // Share the cache key with BaseView so a toggle or query edit is a
  // single invalidate. The sidebar never reads the def, so we use a
  // fixed "sidebar" mtime marker — when BaseView invalidates ["base"]
  // on a patch_task or save_base, both surfaces refresh together.
  // Over-fetch: the base returns ALL rows matching the date filter,
  // so we still leave ROW_CAP visible after dropping DONE/CANCELLED.
  const runQ = useQuery<BasePage>({
    queryKey: ["base", TASKS_BASE_PATH, VIEW_INDEX, "sidebar"],
    queryFn: () => runBase({ Path: TASKS_BASE_PATH }, panelReq(VIEW_INDEX, ROW_CAP * 2)),
    enabled: true,
  });
  // 예정 (future window): only tomorrow survives the slice. The view's
  // own order is not by date, so a very long future backlog past the
  // fetch limit can hide a tomorrow row — the chevron's full view
  // still has it.
  const upcomingQ = useQuery<BasePage>({
    queryKey: ["base", TASKS_BASE_PATH, upcomingIdx, "sidebar-upcoming"],
    queryFn: () => runBase({ Path: TASKS_BASE_PATH }, panelReq(upcomingIdx, ROW_CAP * 4)),
    enabled: upcomingIdx >= 0,
  });
  // 날짜 없음 (undated backlog): engine-filtered by the seed-v2 view
  // resolved above; disabled while the def is loading or lacks it.
  const undatedQ = useQuery<BasePage>({
    queryKey: ["base", TASKS_BASE_PATH, noDateIdx, "sidebar-no-date"],
    queryFn: () => runBase({ Path: TASKS_BASE_PATH }, panelReq(noDateIdx, ROW_CAP * 2)),
    enabled: noDateIdx >= 0,
  });

  // One NowLane slice over all three views. panelSlice drops terminal
  // statuses, de-duplicates rows two views share (due tomorrow +
  // scheduled today sits in both 오늘 and 예정) and places every row by
  // its own date, so a view-filter drift can never mis-place a row.
  const slice = useMemo(
    () =>
      panelSlice(
        [...(runQ.data?.rows ?? []), ...(upcomingQ.data?.rows ?? []), ...(undatedQ.data?.rows ?? [])],
        todayISO,
      ),
    [runQ.data, upcomingQ.data, undatedQ.data, todayISO],
  );
  // 지난 것은 몇 개만 보이고 나머지는 한 번 눌러 그 자리에 편다 — 사이드바 높이를 지난 일이 다 먹지 않게.
  const [overdueAll, setOverdueAll] = useState(false);

  const overdueCount = slice.overdueTop.length + slice.overdueRest.length;
  const undated = slice.undated.slice(0, ROW_CAP);
  const total = overdueCount + slice.upcoming.length + slice.undated.length;
  const onStale = () => setToast(t.task_conflict_reload);
  const overdueShown = overdueAll ? [...slice.overdueTop, ...slice.overdueRest] : slice.overdueTop;

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
            {overdueCount > 0 && (
              <div className="flex items-baseline gap-2 px-2 pt-1 pb-0.5 text-[10px] text-text-subtle">
                <span className="font-semibold uppercase tracking-wide">{t.task_group_overdue}</span>
                <span className="tabular-nums">{overdueCount}</span>
              </div>
            )}
            {overdueShown.map((entry) => (
              <PanelTaskRow key={entry.row.row_id} entry={entry} locale={locale} todayISO={todayISO} onStale={onStale} />
            ))}
            {!overdueAll && slice.overdueRest.length > 0 && (
              <button
                type="button"
                onClick={() => setOverdueAll(true)}
                className="w-full rounded-md px-2 py-0.5 text-left text-[11px] text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                {t.task_lane_more_overdue.replace("{n}", String(slice.overdueRest.length))}
              </button>
            )}
            <div className="px-2">
              <LaneNowRule todayISO={todayISO} locale={locale} t={t} />
            </div>
            {slice.upcoming.map((entry) => (
              <PanelTaskRow key={entry.row.row_id} entry={entry} locale={locale} todayISO={todayISO} onStale={onStale} />
            ))}
            <div className="mt-1">
              <UndatedFold count={slice.undated.length} t={t} compact>
                {undated.map((row) => (
                  <PanelTaskRow
                    key={row.row_id}
                    entry={{ row, diff: 0, gap: 0, steps: 0, sameDayAsPrev: false }}
                    undated
                    locale={locale}
                    todayISO={todayISO}
                    onStale={onStale}
                  />
                ))}
              </UndatedFold>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function PanelTaskRow({
  entry,
  undated,
  locale,
  todayISO,
  onStale,
}: {
  entry: LaneEntry<BaseRow>;
  undated?: boolean;
  locale: "ko" | "en";
  todayISO: string;
  onStale: () => void;
}) {
  const { row, diff, gap, steps, sameDayAsPrev } = entry;
  const onToggle = useTaskToggle(row);
  const open = useOpenTask({ onStale });
  const task = row.task;
  if (!task) return null;
  // 끝자리는 기한(없으면 예정) 하나 — 선 위는 「N일 지남」 + 막대, 선 아래는 오늘 · 내일.
  // 날짜 칩 아이콘은 뺐다: 지금 선 위인지 아래인지가 이미 말한다.
  const eff = task.due ?? task.scheduled;
  const dayLabel = eff ? (diff < 0 ? relativeDayLabel(eff, todayISO, locale) : laneDayLabel(eff, todayISO, locale)) : "";
  const done = task.status_type === "DONE";
  return (
    <CtxRoot>
      <CtxTrigger
        render={
          <div
            style={gap > 0 ? { marginTop: gap } : undefined}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-text-muted transition-colors duration-150 hover:bg-surface-muted hover:text-text"
          />
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
          className="min-w-0 flex-1 truncate text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          title={task.text}
        >
          {task.text || "—"}
        </button>
        {!undated && eff && (
          <span className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums">
            {steps > 0 && <LatenessBar steps={steps} />}
            {/* 같은 날이 이어지면 글자는 첫 행만 — 낭독기에는 그대로 읽힌다. */}
            <span className={sameDayAsPrev ? "sr-only" : steps > 0 ? "font-semibold text-text" : "text-text-subtle"}>
              {dayLabel}
            </span>
          </span>
        )}
        <TaskRowCtxMenu
          done={done}
          text={task.text}
          onOpen={() => void open(task.task_ref)}
          onToggle={onToggle}
        />
      </CtxTrigger>
    </CtxRoot>
  );
}
