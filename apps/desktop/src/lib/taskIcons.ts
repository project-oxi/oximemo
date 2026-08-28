/**
 * Task metadata icon catalog (tasks spec §7.0).
 *
 * One catalog, two render mechanisms, one visual result:
 * - React surfaces render `lucide` (lucide-react ^0.460.0 components);
 * - CM6 widget DOM can't mount React, so the same pinned lucide SVG path
 *   data is inlined in `app.css` as `mask-image` data URIs under
 *   `maskClass` (background-color: currentColor).
 *
 * `taskIcons.test.ts` asserts both halves exist for every row.
 */
import type { LucideIcon } from "lucide-react";
import {
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarPlus,
  CalendarX,
  ChevronDown,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  CircleAlert,
  Equal,
  Play,
  Repeat,
  TriangleAlert,
} from "lucide-react";

export type TaskIconField =
  | "created"
  | "start"
  | "scheduled"
  | "due"
  | "done"
  | "cancelled"
  | "recurrence"
  | "priority-highest"
  | "priority-high"
  | "priority-medium"
  | "priority-low"
  | "priority-lowest"
  | "invalid-date"
  | "unsupported-recurrence";

export interface TaskIconDef {
  /** lucide-react component for React surfaces. */
  lucide: LucideIcon;
  /** app.css class carrying the same glyph as an SVG mask (CM6 widgets). */
  maskClass: string;
}

export const TASK_FIELD_ICONS: Record<TaskIconField, TaskIconDef> = {
  created: { lucide: CalendarPlus, maskClass: "ox-task-ic-created" },
  start: { lucide: Play, maskClass: "ox-task-ic-start" },
  scheduled: { lucide: CalendarClock, maskClass: "ox-task-ic-scheduled" },
  due: { lucide: CalendarDays, maskClass: "ox-task-ic-due" },
  done: { lucide: CalendarCheck, maskClass: "ox-task-ic-done" },
  cancelled: { lucide: CalendarX, maskClass: "ox-task-ic-cancelled" },
  recurrence: { lucide: Repeat, maskClass: "ox-task-ic-recurrence" },
  "priority-highest": { lucide: ChevronsUp, maskClass: "ox-task-ic-priority-highest" },
  "priority-high": { lucide: ChevronUp, maskClass: "ox-task-ic-priority-high" },
  "priority-medium": { lucide: Equal, maskClass: "ox-task-ic-priority-medium" },
  "priority-low": { lucide: ChevronDown, maskClass: "ox-task-ic-priority-low" },
  "priority-lowest": { lucide: ChevronsDown, maskClass: "ox-task-ic-priority-lowest" },
  "invalid-date": { lucide: TriangleAlert, maskClass: "ox-task-ic-invalid-date" },
  "unsupported-recurrence": { lucide: CircleAlert, maskClass: "ox-task-ic-unsupported-recurrence" },
};
