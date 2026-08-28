/**
 * Task edit popover (tasks spec §7.2, Plan C Task 9).
 *
 * A Base UI Popover that mutates every field on a task line:
 *   - status (status table from cfg)
 *   - priority (None / Highest..Lowest)
 *   - start / scheduled / due (native date input + 오늘/내일/지우기)
 *   - recurrence text with LIVE next-occurrence preview (reuses
 *     `lib/taskLine.nextOccurrencePreview`; preview never writes the
 *     shortcut label — the actual commit goes through `applyTransform`
 *     / `patchTask` and serializes the date as ISO)
 *   - description (text body)
 *
 * `⌘Enter` commits; `Esc` closes; plain `Tab` walks the controls.
 * The component is purely presentational: it computes the diff against
 * the initial state and emits a sequenced `TaskEdit[]` via `onCommit`
 * so the editor and the views can route the writes through their own
 * kernel paths (`applyTaskTransform` vs `patchTask`).
 */
import { useEffect, useMemo, useState } from "react";
import { Popover } from "@base-ui-components/react";

import { useI18n, type Dict, type Locale } from "../lib/i18n";
import {
  nextOccurrencePreview,
  type DateField,
  type Priority,
  type StatusType,
  type TaskLineCfg,
} from "../lib/taskLine";
import type { TaskEdit } from "../lib/types";
import { shiftISODate, todayLocalISO } from "../lib/dates";
import { relativeDayLabel } from "../lib/relativeDay";
export interface TaskEditInitial {
  symbol: string;
  statusType: StatusType;
  text: string;
  priority: Priority;
  start: string | null;
  scheduled: string | null;
  due: string | null;
  recurrence: string | null;
}

export interface TaskEditPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Element the popover anchors to (Task 9 spec: positions itself
   *  near the trigger — the edit button in views, or a virtual anchor
   *  at the caret line in the editor). */
  anchor: HTMLElement | null;
  initial: TaskEditInitial;
  cfg: TaskLineCfg;
  /** ISO "YYYY-MM-DD" for the popover's recurrence preview + the
   *  오늘/내일 shortcuts. Defaults to `todayLocalISO()` so callers
   *  rarely need to thread it through. */
  todayISO?: string;
  /** Receives a SEQUENCED `TaskEdit[]` — one per changed field, in
   *  dependency order (status → dates → priority → text →
   *  recurrence). Empty array = the user clicked commit without
   *  changing anything (caller can still close). */
  onCommit: (edits: TaskEdit[]) => void;
}

const PRIORITY_OPTIONS: Priority[] = ["highest", "high", "medium", "low", "lowest", null];

const STATUS_LABEL_KEY: Record<StatusType, keyof Dict> = {
  TODO: "task_status_todo",
  IN_PROGRESS: "task_status_in_progress",
  ON_HOLD: "task_status_on_hold",
  DONE: "task_status_done",
  CANCELLED: "task_status_cancelled",
  NON_TASK: "task_status_non_task",
};

const PRIORITY_LABEL_KEY: Record<Exclude<Priority, null>, keyof Dict> = {
  highest: "task_priority_highest",
  high: "task_priority_high",
  medium: "task_priority_medium",
  low: "task_priority_low",
  lowest: "task_priority_lowest",
};


interface DateFieldMeta {
  field: DateField;
  label: string;
}

export function TaskEditPopover({
  open,
  onOpenChange,
  anchor,
  initial,
  cfg,
  todayISO,
  onCommit,
}: TaskEditPopoverProps) {
  const { t, locale } = useI18n();
  const today = todayISO ?? todayLocalISO();

  // Local draft state — one slot per editable field. Seeded from the
  // popover's `initial` each time it opens (the popover owns its own
  // buffer so cancelling discards every change atomically).
  const [symbol, setSymbol] = useState(initial.symbol);
  const [text, setText] = useState(initial.text);
  const [priority, setPriority] = useState<Priority>(initial.priority);
  const [start, setStart] = useState<string | null>(initial.start);
  const [scheduled, setScheduled] = useState<string | null>(initial.scheduled);
  const [due, setDue] = useState<string | null>(initial.due);
  const [recurrence, setRecurrence] = useState<string | null>(initial.recurrence);

  useEffect(() => {
    if (!open) return;
    setSymbol(initial.symbol);
    setText(initial.text);
    setPriority(initial.priority);
    setStart(initial.start);
    setScheduled(initial.scheduled);
    setDue(initial.due);
    setRecurrence(initial.recurrence);
  }, [open, initial]);

  // Anchor precedence mirrors the kernel: due → scheduled → start.
  // Null when none of the three is set (caller shows "needs date").
  const anchorForPreview = due ?? scheduled ?? start;
  const preview = useMemo(
    () => nextOccurrencePreview(recurrence ?? "", anchorForPreview, today),
    [recurrence, anchorForPreview, today],
  );
  // Diff the draft against the initial state and emit one WIRE edit
  // per changed field. The wire form (PascalCase, externally tagged)
  // is what both `patchTask` and `applyTaskTransform` accept — the
  // editor path routes through the taskLine mirror's `editFromJson`
  // adapter, and the views pass the same wire edits to `patchTask`.
  // Sequencing matters: status flips can clear `done` (terminal
  // transition), dates are independent, priority / text /
  // recurrence can run last since they don't influence each
  // other's spans on the same line.
  const buildEdits = (): TaskEdit[] => {
    const edits: TaskEdit[] = [];
    if (symbol !== initial.symbol) edits.push({ SetStatus: symbol });
    if (start !== initial.start)
      edits.push({ SetDate: { field: "Start", value: start } });
    if (scheduled !== initial.scheduled)
      edits.push({ SetDate: { field: "Scheduled", value: scheduled } });
    if (due !== initial.due)
      edits.push({ SetDate: { field: "Due", value: due } });
    if (priority !== initial.priority) {
      const wire: "Highest" | "High" | "Medium" | "Low" | "Lowest" | "None" =
        priority === null
          ? "None"
          : (priority[0]!.toUpperCase() + priority.slice(1)) as "Highest" | "High" | "Medium" | "Low" | "Lowest";
      edits.push({ SetPriority: wire });
    }
    if (text !== initial.text) edits.push({ SetText: text });
    if (recurrence !== initial.recurrence)
      edits.push({ SetRecurrence: recurrence });
    return edits;
  };

  const commit = () => {
    onCommit(buildEdits());
    onOpenChange(false);
  };

  // ⌘Enter commits; Esc closes — both must not leak to the page
  // (Esc would otherwise steal focus from the editor). The popover's
  // own Base UI wrapper already handles outside-click dismissal, so
  // these only matter when the popup has focus.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onOpenChange(false);
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      commit();
    }
  };

  const dateMeta: DateFieldMeta[] = [
    { field: "start", label: t.task_field_start },
    { field: "scheduled", label: t.task_field_scheduled },
    { field: "due", label: t.task_field_due },
  ];

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange} modal={false}>
      {/* Hidden anchor trigger — the visible trigger lives outside the
          popover (the row's edit button in views; a virtual span
          positioned at the caret in the editor). We need a `Trigger`
          for Base UI's positioning engine, but the rendered element
          itself mirrors the caller's anchor position. */}
      <Popover.Trigger
        render={
          <span
            ref={(el: HTMLSpanElement | null) => {
              if (anchor && el && anchor !== el) {
                const r = anchor.getBoundingClientRect();
                el.style.position = "fixed";
                el.style.left = `${r.left}px`;
                el.style.top = `${r.top}px`;
                el.style.width = `${r.width}px`;
                el.style.height = `${r.height}px`;
                el.style.pointerEvents = "none";
              }
            }}
            aria-hidden
            className="contents"
          />
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4} className="z-[60]">
          <Popover.Popup
            data-task-edit-popover
            onKeyDown={onKeyDown}
            className="w-80 rounded-[var(--popover-radius)] border border-line bg-surface-raised p-3 shadow-lg animate-popover-in"
          >
            <div className="flex flex-col gap-2.5 text-[12px] text-text">
              <Row label={t.task_field_status}>
                <select
                  autoFocus
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                  className="w-full rounded-[var(--input-radius)] bg-surface px-2 py-1 text-[12px] shadow-[var(--input-shadow)] focus-visible:outline-none focus-visible:shadow-[var(--input-shadow-focus)]"
                >
                  {cfg.statuses.map((s) => (
                    <option key={s.symbol} value={s.symbol}>
                      {t[STATUS_LABEL_KEY[s.type]]}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label={t.task_field_priority}>
                <select
                  value={priority === null ? "__none__" : priority}
                  onChange={(e) =>
                    setPriority(e.target.value === "__none__" ? null : (e.target.value as Priority))
                  }
                  className="w-full rounded-[var(--input-radius)] bg-surface px-2 py-1 text-[12px] shadow-[var(--input-shadow)] focus-visible:outline-none focus-visible:shadow-[var(--input-shadow-focus)]"
                >
                  {PRIORITY_OPTIONS.map((p) => (
                    <option key={p ?? "none"} value={p === null ? "__none__" : p}>
                      {p === null ? t.task_priority_none : t[PRIORITY_LABEL_KEY[p]]}
                    </option>
                  ))}
                </select>
              </Row>
              {dateMeta.map((d) => (
                <DateRow
                  key={d.field}
                  label={d.label}
                  value={d.field === "start" ? start : d.field === "scheduled" ? scheduled : due}
                  today={today}
                  locale={locale}
                  t={t}
                  onChange={(v) => {
                    if (d.field === "start") setStart(v);
                    else if (d.field === "scheduled") setScheduled(v);
                    else setDue(v);
                  }}
                />
              ))}
              <Row label={t.task_recurrence}>
                <div className="flex flex-col gap-1">
                  <input
                    type="text"
                    value={recurrence ?? ""}
                    placeholder="every week"
                    onChange={(e) =>
                      setRecurrence(e.target.value.length > 0 ? e.target.value : null)
                    }
                    className="w-full rounded-[var(--input-radius)] bg-surface px-2 py-1 text-[12px] shadow-[var(--input-shadow)] focus-visible:outline-none focus-visible:shadow-[var(--input-shadow-focus)]"
                  />
                  <RecurrencePreview
                    recurrence={recurrence}
                    preview={preview}
                    today={today}
                    locale={locale}
                    t={t}
                  />
                </div>
              </Row>
              <Row label={t.task_field_description}>
                <input
                  type="text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  className="w-full rounded-[var(--input-radius)] bg-surface px-2 py-1 text-[12px] shadow-[var(--input-shadow)] focus-visible:outline-none focus-visible:shadow-[var(--input-shadow-focus)]"
                />
              </Row>
              <div className="mt-1 flex items-center justify-between text-[11px] text-text-subtle">
                <span>⌘⏎ {t.task_edit}</span>
                <span>Esc</span>
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

interface RowProps {
  label: string;
  children: React.ReactNode;
}

function Row({ label, children }: RowProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
        {label}
      </span>
      {children}
    </label>
  );
}

interface DateRowProps {
  label: string;
  value: string | null;
  today: string;
  locale: Locale;
  t: Dict;
  onChange: (v: string | null) => void;
}

function DateRow({ label, value, today, locale, t, onChange }: DateRowProps) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
        {label}
      </span>
      <div className="flex items-center gap-1.5">
        <input
          type="date"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value.length > 0 ? e.target.value : null)}
          className="flex-1 rounded-[var(--input-radius)] bg-surface px-2 py-1 text-[12px] shadow-[var(--input-shadow)] focus-visible:outline-none focus-visible:shadow-[var(--input-shadow-focus)]"
        />
        <button
          type="button"
          onClick={() => onChange(today)}
          className="rounded-[var(--tag-radius)] bg-surface px-2 py-1 text-[11px] text-text-subtle shadow-[var(--input-shadow)] transition-colors duration-150 hover:bg-surface-muted"
        >
          {t.today}
        </button>
        <button
          type="button"
          onClick={() => onChange(shiftISODate(today, 1))}
          className="rounded-[var(--tag-radius)] bg-surface px-2 py-1 text-[11px] text-text-subtle shadow-[var(--input-shadow)] transition-colors duration-150 hover:bg-surface-muted"
        >
          {t.tomorrow}
        </button>
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-label={t.clear}
          title={t.clear}
          className="rounded-[var(--tag-radius)] bg-surface px-2 py-1 text-[11px] text-text-subtle shadow-[var(--input-shadow)] transition-colors duration-150 hover:bg-surface-muted"
        >
          {t.clear}
        </button>
      </div>
      {value && (
        <span className="pl-0.5 text-[10px] text-text-subtle">
          {relativeDayLabel(value, today, locale)}
        </span>
      )}
    </div>
  );
}

interface RecurrencePreviewProps {
  recurrence: string | null;
  preview: string | null;
  today: string;
  locale: Locale;
  t: Dict;
}

function RecurrencePreview({ recurrence, preview, today, locale, t }: RecurrencePreviewProps) {
  const trimmed = recurrence?.trim() ?? "";
  if (trimmed.length === 0) return null;
  if (preview === null) {
    return <span className="text-[10px] text-text-subtle">{t.task_recurrence_needs_date}</span>;
  }
  return (
    <span className="text-[10px] text-text-subtle">
      {t.task_recurrence_next.replace("{date}", relativeDayLabel(preview, today, locale))}
    </span>
  );
}
