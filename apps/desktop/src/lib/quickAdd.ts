/**
 * ⌘⇧T quick add + capture-overlay `/할일` routing (spec §9, Plan E Task 3).
 *
 * Pure routing and parsing for the two quick-add surfaces:
 *  - the main window's ⌘⇧T spotlight input (`components/TaskQuickAdd`), and
 *  - the capture overlay's `/할일` prefix (`components/CaptureOverlay`).
 *
 * Both resolve their destination through `quickAddTarget` — an explicit
 * override wins, else the configured `[tasks] capture_target` — then call
 * `addTask(target, text, fields, todayLocalISO())`. The typed single line
 * is split into description + structured fields by the SAME taskLine
 * mirror the editor uses, so `물 마시기 🔁 every day` quick-adds a task
 * whose recurrence is a real field, not prose.
 */
import {
  cfgFromJson,
  extractAuxFields,
  parseTaskLine,
  type Priority,
  type TaskLineCfg,
  type WireTaskLineCfg,
} from "./taskLine";
import type { AddTarget, TaskFields, TaskPriorityWord, TasksWireConfig } from "./types";

/** Event the capture overlay broadcasts when its `/할일` add carried
 *  the daily+recurrence warning — the overlay window hides itself
 *  before the result arrives, so the MAIN window (`TaskQuickAdd`)
 *  listens and shows the toast. */
export const DAILY_RECURRENCE_WARNING_EVENT = "task:daily-recurrence-warning";

/** The two quick-add destinations (mirrors `[tasks] capture_target`). */
export type QuickAddMode = "daily" | "inbox";

/** Resolve the quick-add routing decision (spec §9): an explicit
 *  `override` wins; otherwise the configured `capture_target` governs
 *  both ⌘⇧T and the overlay's `/할일`; absent config defaults to
 *  `daily`. */
export function quickAddTarget(
  cfg: { capture_target?: QuickAddMode } | null | undefined,
  override?: QuickAddMode | null,
): QuickAddMode {
  if (override) return override;
  return cfg?.capture_target ?? "daily";
}

/** Turn a resolved mode into the `add_task` wire target. `todayISO` is
 *  the caller's local-midnight-stable key (`useTodayKey()` /
 *  `todayLocalISO()`). */
export function buildQuickAddTarget(mode: QuickAddMode, todayISO: string): AddTarget {
  return mode === "daily" ? { Daily: todayISO } : "Inbox";
}

/** Spec §9 anti-pattern gate: a recurring task written to a daily note
 *  accumulates its own copies in every daily note it touches — Obsidian
 *  Tasks documents this; recurring tasks belong in a stable note that
 *  daily views query. Advisory only: the write succeeded, the UI toasts
 *  (`task_daily_recurrence_warning`), never blocks. Client-side mirror
 *  of the core's `PatchTaskResult.daily_recurrence_warning` signal. */
export function shouldWarnDailyRecurrence(
  target: AddTarget,
  fields: Pick<TaskFields, "recurrence">,
): boolean {
  const kind = typeof target === "string" ? target : Object.keys(target)[0];
  return kind === "Daily" && fields.recurrence != null && fields.recurrence.trim() !== "";
}

/** The overlay's task command token (spec §9: `/할일` in the capture
 *  overlay routes through the same quick-add path). */
const OVERLAY_TASK_CMD = "/할일";

/** Does this capture-overlay body open with the `/할일` command? Returns
 *  the remainder (newlines collapsed — a task line cannot hold `\n`) or
 *  null when the body is an ordinary capture. A longer word sharing the
 *  prefix (`/할일아님`) does NOT route. */
export function overlaySlashRoute(body: string): { rest: string } | null {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith(OVERLAY_TASK_CMD)) return null;
  const rest = trimmed.slice(OVERLAY_TASK_CMD.length);
  if (rest.length > 0 && !/^\s/.test(rest)) return null;
  return { rest: rest.replace(/\s*\r?\n\s*/g, " ").trim() };
}

/** Backend `[tasks]` defaults, used only while the config query is
 *  still in flight (dataview tokens, no global filter). */
const DEFAULT_WIRE: WireTaskLineCfg = {
  global_filter: "",
  recurrence_insert: "above",
  statuses: [],
};

/** TaskLineCfg for parsing quick-add input from the wire `[tasks]`
 *  config; falls back to the backend defaults when absent. */
export function lineCfgFromTasks(tasks: TasksWireConfig | null | undefined): TaskLineCfg {
  return cfgFromJson(tasks ?? DEFAULT_WIRE);
}

/** Mirror `Priority` (camelCase read side) → WRITE-side PascalCase word
 *  (`TaskFields.priority`); null (no token) maps to "None". */
const PRIORITY_WIRE: Record<NonNullable<Priority> | "none", TaskPriorityWord> = {
  highest: "Highest",
  high: "High",
  medium: "Medium",
  low: "Low",
  lowest: "Lowest",
  none: "None",
};

/** Split the typed quick-add line into task text + structured fields
 *  using the taskLine mirror. Accepts a bare description or a full task
 *  line typed verbatim (`- [ ] …`); anything the parser cannot read
 *  falls back to the raw text with default fields. `created` stays
 *  null — core auto-stamps today on add. */
export function parseQuickAddInput(
  input: string,
  cfg: TaskLineCfg,
): { text: string; fields: TaskFields } {
  const fields: TaskFields = {
    created: null,
    start: null,
    scheduled: null,
    due: null,
    priority: "None",
    recurrence: null,
    tags: [],
  };
  // A task line is single-line by construction; collapse stray newlines
  // (multi-line paste, the overlay's shift+enter) so the text still routes.
  const line = input.replace(/\s*\r?\n\s*/g, " ").trim();
  if (!line) return { text: "", fields };
  const direct = parseTaskLine(line, cfg);
  const raw = direct ? line : `- [ ] ${line}`;
  const parsed = direct ?? parseTaskLine(raw, cfg);
  if (!parsed) return { text: line, fields };
  const aux = extractAuxFields(raw, parsed);
  return {
    // Token-only input (e.g. just `🔁 every week`) keeps the raw line as
    // the description so nothing the user typed is silently dropped.
    text: aux.text || line,
    fields: {
      created: null,
      start: aux.start,
      scheduled: aux.scheduled,
      due: aux.due,
      priority: PRIORITY_WIRE[aux.priority ?? "none"],
      recurrence: aux.recurrence,
      tags: aux.tags,
    },
  };
}
