/**
 * Shared hook: commit one `patch_task` per row (Task 6).
 *
 * Every view-layer task cell (table, board, list, cards) collapses to
 * the same wire call: `patchTask({ Exact: row.task.task_ref }, edit,
 * todayLocalISO())` followed by `["base"]` invalidate. The error
 * surface is identical too: `TaskConflict` → localized
 * `task_conflict_reload` toast + invalidate; everything else →
 * first-line toast + invalidate.
 *
 * Returning a memoized handler (one per `row.task.task_ref` change)
 * keeps React-Query's referential-equality checks happy inside the
 * TaskCheckbox's onToggle closure.
 */
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { patchTask } from "./api";
import { todayLocalISO } from "./dates";
import { useI18n } from "./i18n";
import type { BaseRow, TaskEdit } from "./types";
import { useUI } from "../stores/ui";

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
 *  edit list (Plan C Task 9's `TaskEditPopover`). Each edit runs
 *  independently through the guarded `patch_task` path, so a kernel
 *  conflict on edit N stops the sequence at N (no rollback — the
 *  user can reopen the popover and re-apply the remaining edits). */
export function useTaskEditMany(row: BaseRow): (edits: TaskEdit[]) => void {
  const single = useTaskEdit(row);
  return useCallback(
    (edits: TaskEdit[]) => {
      for (const edit of edits) single(edit);
    },
    [single],
  );
}
