/**
 * `openTask` navigation + hash repair (spec §5).
 *
 * The frontend cannot recompute `TaskLineHash` (BLAKE3 lives in core), so the
 * flow is:
 *   1. Optimistically open the memo (selectedId) so the dialog mounts.
 *   2. Resolve the line via `resolve_task_line`: it returns the original
 *      line if the bytes still hash correctly, the unique line whose bytes
 *      do hash correctly (the move case), or `null` when the hash is
 *      absent/ambiguous (a stale link).
 *   3. Queue the (resolved) line as `pendingTaskAnchor` so MemoDetail can
 *      scroll + select it once the editor remounts. On null, fall back to
 *      a no-scroll open and fire `onStale` so the caller can toast.
 *
 * The pure `openTask` is dependency-injected so it stays testable without
 * Tauri/Zustand/React. `useOpenTask` is the thin React-side binding for
 * real callers — i18n is the caller's concern, this module never imports
 * the locale dictionaries.
 */
import { useCallback } from "react";

import { resolveTaskLine } from "./api";
import type { TaskRef } from "./types";
import { useUI } from "../stores/ui";

/** Anchor the editor scrolls to. `line` is 0-based (matches `TaskRef.line`). */
export interface TaskAnchor {
  memoId: string;
  line: number;
}

/** Dependencies injected into the pure `openTask` so it has no React or
 *  Tauri surface — every test passes fakes. */
export interface OpenTaskDeps {
  /** Selects the memo (sets `selectedId`). Optimistic — happens before
   *  the async hash resolve, so the dialog mounts immediately. */
  select: (id: string) => void;
  /** Stores the post-resolve line. MemoDetail consumes this on mount. */
  setAnchor: (a: TaskAnchor | null) => void;
  /** Hash-repair lookup. Returns the resolved line, or `null` when the
   *  original line is stale / ambiguous / absent. */
  resolve: (ref: TaskRef) => Promise<number | null>;
  /** Fires when the link is stale (resolve returned null). The caller
   *  decides what the user sees (a toast is the typical choice). */
  onStale?: () => void;
}

/**
 * Open the task's parent memo and queue a scroll target. The flow is
 * deliberately side-effect-isolated; the caller injects the store-writers
 * and the IPC. See the file header for the full rationale.
 *
 * - `select` runs synchronously up front so the dialog opens immediately.
 * - `setAnchor` runs only after `resolve` lands — a null result clears
 *   any prior anchor (we are explicitly landing on this memo with no
 *   scroll target) and fires `onStale` if provided.
 * - A `resolve` rejection propagates: the anchor is left untouched and
 *   the caller decides what to do (typically: fall back to opening
 *   without a scroll). We do not swallow the error silently.
 */
export async function openTask(ref: TaskRef, deps: OpenTaskDeps): Promise<void> {
  const { memo_id: memoId } = ref;
  deps.select(memoId);
  const line = await deps.resolve(ref);
  if (line === null) {
    deps.setAnchor(null);
    deps.onStale?.();
    return;
  }
  deps.setAnchor({ memoId, line });
}

/** React binding: `resolve` is the Tauri IPC, `select`/`setAnchor` come
 *  from the UI store, and `onStale` is supplied by the caller (typically
 *  MemoDetail) so the i18n key lookup stays in the caller's scope. */
export function useOpenTask(opts: { onStale: () => void }): (ref: TaskRef) => Promise<void> {
  const select = useUI((s) => s.select);
  const setAnchor = useUI((s) => s.setTaskAnchor);
  const { onStale } = opts;
  return useCallback(
    (ref: TaskRef) =>
      openTask(ref, {
        select,
        setAnchor,
        resolve: (r) => resolveTaskLine(r.memo_id, r.line, r.line_hash),
        onStale,
      }),
    [select, setAnchor, onStale],
  );
}
