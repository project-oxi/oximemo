/**
 * Pull a `TaskEditInitial` out of one parsed task line or one indexed
 * task DTO (Plan C Task 9). Used by both the editor (line path) and
 * the views (DTO path) to seed the popover's draft buffer from
 * whatever the caller already has in hand.
 */
import type { TaskDto } from "./types";
import type { ParsedLine } from "./taskLine";
import type { TaskEditInitial } from "../components/TaskEditPopover";

/** Parse the date out of either the emoji form (`📅 YYYY-MM-DD`) or
 *  the dataview form (`[due:: YYYY-MM-DD]`). Returns null when the
 *  span doesn't carry an ISO date — `task_field_due` tokens are
 *  recognised even when malformed, but only well-formed dates flow
 *  back to the popover. */
function readDateToken(token: string | undefined): string | null {
  if (!token) return null;
  const dv = /^\[\s*\w+\s*::\s*(\d{4}-\d{2}-\d{2})\s*\]$/.exec(token);
  if (dv) return dv[1] ?? null;
  const emoji = /\b(\d{4}-\d{2}-\d{2})\b/.exec(token);
  return emoji?.[1] ?? null;
}

/** Strip the leading emoji (the kernel writes `🔁 every week`) or the
 *  dataview wrapper (`[repeat:: every week]`) to recover the rule. */
function readRecurrenceToken(token: string | undefined): string | null {
  if (!token) return null;
  const dv = /^\[\s*repeat\s*::\s*([^\]]+?)\s*\]$/i.exec(token);
  if (dv) return dv[1]?.trim() ?? null;
  return token.replace(/^🔁\s*/, "").trim() || null;
}

/** Map the priority token (emoji or dataview) to a `Priority` value
 *  (the read side is camelCase — `Priority` from taskLine.ts). */
function readPriorityToken(token: string | undefined): TaskEditInitial["priority"] {
  if (!token) return null;
  const dv = /^\[\s*priority\s*::\s*([^\]]+?)\s*\]$/i.exec(token);
  if (dv) {
    const w = dv[1]?.toLowerCase();
    if (w === "highest" || w === "high" || w === "medium" || w === "low" || w === "lowest") {
      return w;
    }
    return null;
  }
  if (token.includes("🔺")) return "highest";
  if (token.includes("⏫")) return "high";
  if (token.includes("🔼")) return "medium";
  if (token.includes("🔽")) return "low";
  if (token.includes("⏬")) return "lowest";
  return null;
}

export function initialFromLine(parsed: ParsedLine, raw: string): TaskEditInitial {
  // Build a static field → raw-text map. The kernel's `parseTaskLine`
  // gives us the spans, but the popover wants the raw substring for
  // each editable field. A `Record` is the right shape — every key is
  // statically known — even though only three of them are read below.
  const tokens: Record<string, string | undefined> = {
    start: undefined,
    scheduled: undefined,
    due: undefined,
    recurrence: undefined,
    priority: undefined,
  };
  for (const span of parsed.spans.fields) {
    tokens[span.field] = raw.slice(span.start, span.end);
  }
  const dates: Record<"start" | "scheduled" | "due", string | null> = {
    start: readDateToken(tokens.start),
    scheduled: readDateToken(tokens.scheduled),
    due: readDateToken(tokens.due),
  };
  return {
    symbol: parsed.symbol,
    statusType: parsed.statusType,
    text: parsed.text,
    priority: readPriorityToken(tokens.priority),
    start: dates.start,
    scheduled: dates.scheduled,
    due: dates.due,
    recurrence: readRecurrenceToken(tokens.recurrence),
  };
}

/** DTO path for the popover seed (Plan C Task 9, views): the
 *  indexed `TaskDto` already has every field on its own — there's no
 *  need to reconstruct the raw line or run `parseTaskLine` when the
 *  caller already holds the parsed view. */
export function initialFromDto(task: TaskDto): TaskEditInitial {
  return {
    symbol: task.symbol,
    statusType: task.status_type,
    text: task.text,
    priority: task.priority === "none" ? null : task.priority,
    start: task.start,
    scheduled: task.scheduled,
    due: task.due,
    recurrence: task.recurrence,
  };
}
