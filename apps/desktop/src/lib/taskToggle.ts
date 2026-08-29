/**
 * Shared hooks: commit `patch_task` edits from the view layer (Task 6,
 * Plan C Task 9).
 *
 * Every view-layer task cell (table, board, list, cards) collapses to
 * the same wire call: `patchTask({ Exact: row.task.task_ref }, edit,
 * todayLocalISO())` followed by a `["base"]` invalidate. The error
 * surface is identical too: `TaskConflict` → localized
 * `task_conflict_reload` toast + invalidate; everything else →
 * first-line toast + invalidate.
 *
 * Returning a memoized handler (one per `row.task.task_ref` change)
 * keeps React-Query's referential-equality checks happy inside the
 * TaskCheckbox's onToggle closure.
 *
 * Also hosts `effectiveStatuses` (Plan C Task 9 review): the popover's
 * status selector must offer the EFFECTIVE status table — the kernel's
 * builtin table unioned with the vault's `[tasks] statuses` — because
 * the raw `cfg.statuses` alone is EMPTY on default vaults. Mirrors
 * taskLine.ts's private `buildStatusTable` (that file exports no
 * builder; keep the two in lockstep).
 */
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { patchTask } from "./api";
import { todayLocalISO } from "./dates";
import { useI18n } from "./i18n";
import type { StatusDef, TaskLineCfg } from "./taskLine";
import type { BaseRow, TaskEdit, TaskRef } from "./types";
import { useUI } from "../stores/ui";

/** Kernel builtin statuses (TasksConfig::default parity with
 *  taskLine.ts's private `BUILTIN_STATUSES`): space/to-do, slash
 *  in-progress, x done, minus cancelled. */
const BUILTIN_STATUSES: StatusDef[] = [
  { symbol: " ", type: "TODO", next: "x" },
  { symbol: "/", type: "IN_PROGRESS", next: "x" },
  { symbol: "x", type: "DONE", next: " " },
  { symbol: "-", type: "CANCELLED", next: " " },
];

/** Effective status table for the popover's selector: builtins first,
 *  the vault's `[tasks] statuses` layered on top (a `symbol` the vault
 *  redefines keeps its builtin position but takes the new meaning;
 *  new symbols append). `X` normalizes to lowercase `x`, matching the
 *  kernel's case-insensitive done-symbol handling. */
export function effectiveStatuses(cfg: TaskLineCfg): StatusDef[] {
  const table = new Map<string, StatusDef>();
  for (const def of [...BUILTIN_STATUSES, ...cfg.statuses]) {
    const sym = def.symbol === "X" ? "x" : def.symbol;
    table.set(sym, { ...def, symbol: sym });
  }
  return [...table.values()];
}

export function useTaskToggle(row: BaseRow): () => void {
  const qc = useQueryClient();
  const setToast = useUI((s) => s.setToast);
  const { t } = useI18n();
  return useCallback(() => {
    if (!row.task) return;
    patchTask({ Exact: row.task.task_ref }, "Toggle", todayLocalISO())
      .then(() => void qc.invalidateQueries({ queryKey: ["base"] }))
      .catch((e: unknown) => {
        const msg = String(e);
        if (msg.includes("task conflict")) setToast(t.task_conflict_reload);
        else setToast(msg.split("\n")[0] ?? msg);
        void qc.invalidateQueries({ queryKey: ["base"] });
      });
  }, [qc, setToast, t, row.task]);
}

export function useTaskEdit(row: BaseRow): (edit: TaskEdit) => void {
  const qc = useQueryClient();
  const setToast = useUI((s) => s.setToast);
  const { t } = useI18n();
  return useCallback((edit: TaskEdit) => {
    if (!row.task) return;
    patchTask({ Exact: row.task.task_ref }, edit, todayLocalISO())
      .then(() => void qc.invalidateQueries({ queryKey: ["base"] }))
      .catch((e: unknown) => {
        const msg = String(e);
        if (msg.includes("task conflict")) setToast(t.task_conflict_reload);
        else setToast(msg.split("\n")[0] ?? msg);
        void qc.invalidateQueries({ queryKey: ["base"] });
      });
  }, [qc, setToast, t, row.task]);
}

/** Bulk variant of `useTaskEdit` for surfaces that commit a sequenced
 *  edit list (Plan C Task 9's `TaskEditPopover`). The edits are
 *  AWAIT-SEQUENCED, not fired in parallel: every successful
 *  `patch_task` rewrites the line (new `line_hash`) and a recurrence
 *  spawn-above shifts it down a row, so each round's refreshed
 *  `PatchTaskResult.task.task_ref` becomes the next round's selector —
 *  reusing the row's open-time ref would fail edits 2..N on the stale
 *  hash guard. A kernel conflict stops the sequence there (no
 *  rollback — the user can reopen the popover and re-apply the
 *  remaining edits) and still surfaces the conflict toast: a mismatch
 *  on the FIRST edit is a genuine external change. */
export function useTaskEditMany(row: BaseRow): (edits: TaskEdit[]) => void {
  const qc = useQueryClient();
  const setToast = useUI((s) => s.setToast);
  const { t } = useI18n();
  return useCallback(
    (edits: TaskEdit[]) => {
      const openTask = row.task;
      if (!openTask) return;
      void (async () => {
        let ref: TaskRef = openTask.task_ref;
        for (const edit of edits) {
          try {
            const res = await patchTask({ Exact: ref }, edit, todayLocalISO());
            ref = res.task.task_ref;
          } catch (e: unknown) {
            const msg = String(e);
            if (msg.includes("task conflict")) setToast(t.task_conflict_reload);
            else setToast(msg.split("\n")[0] ?? msg);
            void qc.invalidateQueries({ queryKey: ["base"] });
            return;
          }
        }
        void qc.invalidateQueries({ queryKey: ["base"] });
      })();
    },
    [qc, setToast, t, row.task],
  );
}
