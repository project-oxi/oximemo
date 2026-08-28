/**
 * Pure edit-mapping + board-drag gating for task cells (Plan C Task 6).
 *
 * Every view-layer commit goes through this module so the wire shape lives
 * in one place:
 *   • `editForCell(property, value)` → wire-shape `TaskEdit` (PascalCase
 *     externally-tagged union — see Rust emitter in `tasks.rs`).
 *   • `isEditableTaskColumn(property, row)` → true only for `task.*`
 *     properties when the row carries a task.
 *   • `nextSymbolFor(statusTable, symbol)` → the symbol the row's checkbox
 *     should toggle to. `BUILTIN_STATUS_TABLE` mirrors the four canonical
 *     symbols the Rust kernel defines when no status config is supplied.
 *   • `dragCommitsStatus(groupBy)` → true only when the board is grouped by
 *     `task.status`; any other group-by routes the drop through the existing
 *     note-prop `updateMemo` path (and `task.type` explicitly disables drag,
 *     since the kernel doesn't accept task-type drops).
 *
 * Why PascalCase wire shape here: `patchTask` in `lib/api.ts` is the thin
 * invoke wrapper — it serializes `edit` as the Rust kernel's externally
 * tagged enum. The TS mirror (`lib/taskLine.ts`) reads the same shape via
 * `editFromJson`; the wire lockstep is pinned in `types.ts`.
 */
import type { BaseRow, TaskDto, TaskEdit } from "./types";

/** Pulled from `TaskDto.status_type` so this module follows any future
 *  variant additions (e.g. `WAITING`) without a separate copy. */
type StatusType = TaskDto["status_type"];
type DateFieldWord = "Created" | "Start" | "Scheduled" | "Due" | "Done" | "Cancelled";

/** Priority word on the wire (PascalCase per Rust emitter). */
type PriorityWord = "Highest" | "High" | "Medium" | "Low" | "Lowest" | "None";

const TASK_DATE_FIELDS: Record<string, DateFieldWord> = {
  "task.due": "Due",
  "task.scheduled": "Scheduled",
  "task.start": "Start",
  "task.created": "Created",
  "task.done": "Done",
  "task.cancelled": "Cancelled",
};

const TASK_PRIORITY_WORDS = new Set<PriorityWord>([
  "Highest",
  "High",
  "Medium",
  "Low",
  "Lowest",
  "None",
]);

/** Recognized task.* column properties (the spec §4 edit set). */
export const TASK_COLUMN_KEYS = new Set<string>([
  "task.status",
  "task.due",
  "task.scheduled",
  "task.start",
  "task.priority",
  "task.text",
]);

/** The four canonical status symbols the Rust kernel ships by default.
 *  Mirror's `BUILTIN_STATUSES` uses the same set; we keep a parallel one
 *  here so this module never depends on `taskLine.ts` (the views might
 *  not have the mirror's cfg available). Configured statuses override at
 *  the call site by passing an extended table to `nextSymbolFor`. */
export interface StatusTableEntry {
  next: string;
  type: StatusType;
}

function buildBuiltinStatusTable(): Map<string, StatusTableEntry> {
  return new Map<string, StatusTableEntry>([
    [" ", { next: "x", type: "TODO" }],
    ["/", { next: "x", type: "IN_PROGRESS" }],
    ["x", { next: " ", type: "DONE" }],
    ["X", { next: " ", type: "DONE" }],
    ["-", { next: " ", type: "CANCELLED" }],
  ]);
}

export const BUILTIN_STATUS_TABLE: ReadonlyMap<string, StatusTableEntry> = buildBuiltinStatusTable();

/** Resolve the symbol a checkbox should toggle to. `statusTable` is the
 *  builtin table extended with any user-configured statuses (mirrors the
 *  mirror's `buildStatusTable`); unknown symbols pass through unchanged. */
export function nextSymbolFor(
  statusTable: ReadonlyMap<string, StatusTableEntry>,
  symbol: string,
): string {
  const entry = statusTable.get(symbol === "X" ? "x" : symbol);
  return entry ? entry.next : symbol;
}

/** Map a column property + value to the wire-shape `TaskEdit`. Returns
 *  `undefined` when the property is not a task cell (the view's existing
 *  note-prop `updateMemo` path keeps responsibility for those). */
export function editForCell(
  property: string,
  value?: string | null,
): TaskEdit | undefined {
  switch (property) {
    case "task.status": {
      if (value === undefined || value === null) return "Toggle";
      return { SetStatus: String(value) };
    }
    case "task.due":
    case "task.scheduled":
    case "task.start":
    case "task.created":
    case "task.done":
    case "task.cancelled": {
      const field = TASK_DATE_FIELDS[property];
      if (!field) return undefined;
      const v = value === undefined || value === null || value === "" ? null : String(value);
      return { SetDate: { field, value: v } };
    }
    case "task.priority": {
      if (typeof value !== "string") return undefined;
      if (!TASK_PRIORITY_WORDS.has(value as PriorityWord)) return undefined;
      return { SetPriority: value as PriorityWord };
    }
    case "task.text": {
      if (typeof value !== "string") return undefined;
      return { SetText: value };
    }
  }
  return undefined;
}

/** True only when the column is a `task.*` property AND the row carries a
 *  task. Note rows keep the existing `updateMemo` path even when the view
 *  declares a `task.*` column (the row simply renders read-only there —
 *  the spec calls this the "view-only on note rows" behavior). */
export function isEditableTaskColumn(property: string, row: BaseRow): boolean {
  if (!TASK_COLUMN_KEYS.has(property)) return false;
  return row.task !== null;
}

/** Predicate for whether a board drop should commit `SetStatus(S)` per
 *  dragged `row.task.task_ref`. Only `task.status` grouping routes through
 *  `patchTask`; everything else (note props, task.type) keeps the existing
 *  scalar-prop `updateMemo` path or disables drag. */
export function dragCommitsStatus(groupBy: string | null): boolean {
  return groupBy === "task.status";
}
