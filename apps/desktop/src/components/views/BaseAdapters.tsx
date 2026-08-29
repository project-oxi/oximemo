/**
 * Note + task adapters over a base's rows (query views spec §4/§7).
 * - `cards` reuses the browse Card renderer for note rows (its own
 *   note-drag contract — the folder-card handlers of GridView/ListView
 *   are deliberately absent) and renders a task card for task rows.
 * - `list` is a lean row list: note rows show title+preview+folder+time;
 *   task rows show `TaskCheckbox` + text + parent breadcrumb.
 * Both honor the view's filters/order/limit through the shared BaseView
 * run query, ignore columns/summaries, and offer no cell editing.
 *
 * Plan C: row identity is `BaseRow.row_id` (spec §4). Two task rows
 * under one parent stay distinct by row_id; the prior `r.summary.id`
 * key collapsed them onto a single card. Task rows' `TaskCheckbox`
 * click fires `patch_task Toggle` through the shared `useTaskToggle`
 * hook (Task 6).
 *
 * Plan C Task 9: every task row carries a small edit affordance that
 * opens a `TaskEditPopover` anchored to the button. The popover
 * commits sequenced `patch_task` edits via `useTaskEditMany`.
 */
import { useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { Pencil } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "../Card";
import { useI18n } from "../../lib/i18n";
import { useFolderNames } from "../../lib/folders";
import { previewText } from "../../lib/markdownPreview";
import { queryCountVersion, subscribeQueryCounts } from "../../lib/queryPreviewCounts";
import { relativeDayLabel, dayTone, useTodayKey } from "../../lib/relativeDay";
import { useTaskEditMany, useTaskToggle } from "../../lib/taskToggle";
import { relativeTime } from "../../lib/time";
import { cfgFromJson, type TaskLineCfg } from "../../lib/taskLine";
import { getConfig } from "../../lib/api";
import type { BaseRow, FolderDef, FolderEntry, TaskDto } from "../../lib/types";
import { TaskCheckbox } from "../TaskCheckbox";
import { TaskFieldChip } from "../TaskFieldChip";
import { TaskEditPopover } from "../TaskEditPopover";
import { initialFromDto } from "../../lib/taskPopoverSeed";

interface CardsProps {
  rows: BaseRow[];
  folders: FolderDef[];
  folderEntries: FolderEntry[];
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string, favorite: boolean) => void;
}

export function BaseCardsAdapter({ rows, folders, folderEntries, onSelect, onToggleFavorite }: CardsProps) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3 p-2">
      {rows.map((r) =>
        r.task ? (
          <TaskCard key={r.row_id} row={r} onSelect={onSelect} />
        ) : (
          <Card
            key={r.row_id}
            memo={r.summary}
            folders={folders}
            folderEntries={folderEntries}
            onSelect={onSelect}
            onToggleFavorite={onToggleFavorite}
            onMoveFolder={() => {}}
            onCopyBody={() => {}}
            onDelete={() => {}}
          />
        ),
      )}
    </div>
  );
}

export function BaseListAdapter({
  rows,
  onSelect,
}: {
  rows: BaseRow[];
  onSelect: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  useSyncExternalStore(subscribeQueryCounts, queryCountVersion);
  const { displayName } = useFolderNames();
  return (
    <div className="flex flex-col">
      {rows.map((r) => {
        const title = r.summary.title ?? r.summary.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
        if (r.task) return <TaskListRow key={r.row_id} row={r} title={title} onSelect={onSelect} />;
        return (
          <button
            key={r.row_id}
            type="button"
            onClick={() => onSelect(r.summary.id)}
            className="flex items-baseline gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-surface-muted/60"
          >
            <span className="min-w-0 flex-1 truncate text-[13px] text-text">{title}</span>
            <span className="w-40 shrink-0 truncate text-[11px] text-text-subtle">
              {previewText(r.summary.preview, 90, { thisId: r.summary.id, resultsN: t.query_embed_results_n })}
            </span>
            <span className="w-24 shrink-0 truncate text-right text-[11px] text-text-subtle">
              {displayName(r.summary.folder) || t.vault_root}
            </span>
            <span className="w-16 shrink-0 text-right text-[11px] text-text-subtle">
              {relativeTime(r.summary.updated_at, locale)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Pull the active tasks cfg out of the shared config cache. The
 *  popover derives its (effective) status table and write format from
 *  it, and any call site that wants to open one needs the same value —
 *  one hook keeps them in lockstep (and lets the views gracefully
 *  degrade while the query is still loading). */
function useTasksCfg(): TaskLineCfg | null {
  const q = useQuery({ queryKey: ["config"], queryFn: getConfig });
  return q.data?.tasks ? cfgFromJson(q.data.tasks) : null;
}

/** Per-row edit affordance (Plan C Task 9): one popover per task row.
 *  Owns the commit path through `useTaskEditMany` and renders the
 *  Base UI popover anchored to the row's pencil button. */
function TaskEditPopoverController({
  task,
  row,
  cfg,
  anchor,
  open,
  onOpenChange,
  todayISO,
}: {
  task: TaskDto;
  row: BaseRow;
  cfg: TaskLineCfg;
  anchor: HTMLElement | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Shared midnight key — threads into the popover so its 오늘/내일
   *  shortcuts and recurrence preview roll over at midnight instead
   *  of freezing the mount-time day. */
  todayISO: string;
}) {
  const commit = useTaskEditMany(row);
  return (
    <TaskEditPopover
      open={open}
      onOpenChange={onOpenChange}
      anchor={anchor}
      initial={initialFromDto(task)}
      cfg={cfg}
      todayISO={todayISO}
      onCommit={(edits) => commit(edits)}
    />
  );
}

/** One task row in the list adapter: checkbox + text + chips + parent.
 *  Clicking the row opens the note; the checkbox click is captured to
 *  fire `patch_task Toggle` (Task 6). The row's `useTaskToggle` lives
 *  here, NOT inline in the parent, because hooks can't be called inside
 *  a `.map(...)` closure. The pencil button on the right opens the
 *  edit popover — visible on hover (or always-on focus). */
function TaskListRow({
  row,
  title,
  onSelect,
}: {
  row: BaseRow;
  title: string;
  onSelect: (id: string) => void;
}) {
  const onToggle = useTaskToggle(row);
  const { locale, t } = useI18n();
  const todayISO = useTodayKey();
  const cfg = useTasksCfg();
  const [editOpen, setEditOpen] = useState(false);
  const editAnchorRef = useRef<HTMLButtonElement | null>(null);
  if (!row.task) return null;
  const scheduled = row.task.scheduled;
  const due = row.task.due;
  return (
    <div className="group flex items-baseline gap-1 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-surface-muted/60">
      <button
        type="button"
        onClick={() => onSelect(row.summary.id)}
        className="flex min-w-0 flex-1 items-baseline gap-3 text-left"
      >
        <TaskCheckbox
          statusType={row.task.status_type}
          label={row.task.text}
          onToggle={onToggle}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] text-text">{row.task.text}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {scheduled && <TaskFieldChip field="scheduled" value={relativeDayLabel(scheduled, todayISO, locale)} tone={dayTone(scheduled, todayISO)} />}
          {due && <TaskFieldChip field="due" value={relativeDayLabel(due, todayISO, locale)} tone={dayTone(due, todayISO)} />}
        </span>
        <span className="w-24 shrink-0 truncate text-[11px] text-text-subtle" title={title}>
          @ {title}
        </span>
      </button>
      <button
        ref={editAnchorRef}
        type="button"
        aria-label={t.task_edit}
        title={t.task_edit}
        onClick={(e) => {
          e.stopPropagation();
          setEditOpen((o) => !o);
        }}
        className="invisible shrink-0 rounded-[var(--tag-radius)] p-1 text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text group-hover:visible focus-visible:visible"
      >
        <Pencil size={12} />
      </button>
      {cfg && editAnchorRef.current && (
        <TaskEditPopoverController
          task={row.task!}
          row={row}
          cfg={cfg}
          anchor={editAnchorRef.current}
          open={editOpen}
          onOpenChange={(o) => {
            setEditOpen(o);
            // Esc / outside dismissal restores focus to the pencil
            // (the keyboard path shouldn't drop the user's place).
            if (!o) editAnchorRef.current?.focus();
          }}
          todayISO={todayISO}
        />
      )}
    </div>
  );
}

/** Task row rendered as a card (cards adapter). Mirrors the static
 *  task-row markup the table view ships; the checkbox click fires
 *  `patch_task Toggle` (Task 6). The pencil button in the header
 *  opens the edit popover (Task 9). */
function TaskCard({ row, onSelect }: { row: BaseRow; onSelect: (id: string) => void }) {
  const onToggle = useTaskToggle(row);
  const { locale, t } = useI18n();
  const todayISO = useTodayKey();
  const cfg = useTasksCfg();
  const [editOpen, setEditOpen] = useState(false);
  const editAnchorRef = useRef<HTMLButtonElement | null>(null);
  if (!row.task) return null;
  const title = row.summary.title ?? row.summary.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  const scheduled = row.task.scheduled;
  const due = row.task.due;
  return (
    <div className="group flex flex-col gap-2 rounded-[var(--popover-radius)] border border-line bg-surface p-3 text-left shadow-sm transition-colors duration-150 hover:border-line-strong">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSelect(row.summary.id)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <TaskCheckbox
            statusType={row.task.status_type}
            label={row.task.text}
            onToggle={onToggle}
          />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text" title={row.task.text}>
            {row.task.text || "—"}
          </span>
        </button>
        <button
          ref={editAnchorRef}
          type="button"
          aria-label={t.task_edit}
          title={t.task_edit}
          onClick={(e) => {
            e.stopPropagation();
            setEditOpen((o) => !o);
          }}
          className="invisible shrink-0 rounded-[var(--tag-radius)] p-1 text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text group-hover:visible focus-visible:visible"
        >
          <Pencil size={12} />
        </button>
      </div>
      <button
        type="button"
        onClick={() => onSelect(row.summary.id)}
        className="flex flex-col gap-1.5 text-left"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {scheduled && <TaskFieldChip field="scheduled" value={relativeDayLabel(scheduled, todayISO, locale)} tone={dayTone(scheduled, todayISO)} />}
          {due && <TaskFieldChip field="due" value={relativeDayLabel(due, todayISO, locale)} tone={dayTone(due, todayISO)} />}
          {row.task.priority !== "none" && (
            <TaskFieldChip
              field={`priority-${row.task.priority}` as "priority-high" | "priority-medium" | "priority-low" | "priority-lowest" | "priority-highest"}
              value=""
            />
          )}
          {row.task.recurrence && <TaskFieldChip field="recurrence" value={row.task.recurrence} />}
        </div>
        <span className="truncate text-[10px] text-text-subtle" title={title}>
          @ {title}
        </span>
      </button>
      {cfg && editAnchorRef.current && (
        <TaskEditPopoverController
          task={row.task!}
          row={row}
          cfg={cfg}
          anchor={editAnchorRef.current}
          open={editOpen}
          onOpenChange={(o) => {
            setEditOpen(o);
            // Esc / outside dismissal restores focus to the pencil
            // (the keyboard path shouldn't drop the user's place).
            if (!o) editAnchorRef.current?.focus();
          }}
          todayISO={todayISO}
        />
      )}
    </div>
  );
}
