/**
 * 어제의 미완료 이월 (tasks spec §7 rollover; Plan E Task 4): the
 * palette's explicit rollover command. Mirrors the CLI's
 * `oximemo task rollover` semantics — every not-done task from
 * yesterday's daily note moves into today's — but with a confirm step:
 * the command previews the count, commits on the toast's action, and
 * the done toast carries a guarded Undo.
 *
 * Pure halves (unit-tested in taskRollover.test.ts):
 *  - `rolloverRequest` — strict refs (the exact `task_ref`s the query
 *    read, never re-derived), single-source enforcement, done-family
 *    rejection, and the destination-hash policy: today's note hash when
 *    the note exists, null when it doesn't (move_tasks then accepts its
 *    first creation — CLI parity).
 *  - `undoAvailability` — the client-side mirror of the backend's
 *    both-post-move-hash gate, so Undo can refuse without a write.
 *
 * `runTaskRollover` orchestrates over the api layer (the
 * queryPreviewCounts precedent for a lib module calling `run_base`):
 * two one-off inline queries fetch the candidates and today's hash,
 * `moveTasks` commits, `undoMoveTasks` reverses under the same guard.
 */
import { moveTasks, runBase, undoMoveTasks } from "./api";
import { shiftISODate, todayLocalISO } from "./dates";
import type { Dict } from "./i18n";
import type { MoveTasksReceipt, MoveTasksRequest, RunBaseReq, TaskDto } from "./types";

/** Default `[daily] folder` (core's DailyConfig default). */
const DEFAULT_DAILY_FOLDER = "daily";

/** Normalize a configured daily folder: trim slashes/space, fall back
 *  to the core default when blank. */
function normalizeFolder(folder: string | null | undefined): string {
  const f = (folder ?? "").trim().replace(/^\/+|\/+$/g, "");
  return f === "" ? DEFAULT_DAILY_FOLDER : f;
}

/** One-off inline def: yesterday's not-done tasks in the daily folder
 *  (the CLI rollover candidate set, expressed as a query). */
export function rolloverCandidatesYaml(yesterdayISO: string, dailyFolder: string): string {
  const folder = normalizeFolder(dailyFolder);
  return [
    "source: tasks",
    "filters:",
    "  and:",
    '    - \'task.type != "DONE" && task.type != "CANCELLED"\'',
    `    - 'file.name == "${yesterdayISO}"'`,
    `    - 'file.inFolder("${folder}")'`,
    "views:",
    "  - { type: table }",
  ].join("\n");
}

/** One-off inline def: the note named `iso` in the daily folder — used
 *  to read today's hash before committing and both hashes before an
 *  undo. Notes source (the default), so no `source:` line. */
export function dailyNoteByNameYaml(iso: string, dailyFolder: string): string {
  const folder = normalizeFolder(dailyFolder);
  return [
    "filters:",
    "  and:",
    `    - 'file.name == "${iso}"'`,
    `    - 'file.inFolder("${folder}")'`,
    "views:",
    "  - { type: table }",
  ].join("\n");
}

/** Build the move request for a rollover (pure). `rows` are the
 *  not-done task rows the candidates query returned; refs are taken
 *  verbatim from each row's `task_ref` (strict — the stale-write guards
 *  must bind to what the query read). Returns null when there is
 *  nothing safe to move: no rows, a done-family row (stale filter
 *  data), or rows spanning more than one source note. The destination
 *  is always the day after `yesterdayISO`; `todayHash` passes through
 *  as `expected_destination_hash` (null = accept today's current state
 *  or its first creation, exactly like the CLI rollover). */
export function rolloverRequest(
  yesterdayISO: string,
  rows: TaskDto[],
  todayHash: string | null,
): MoveTasksRequest | null {
  if (rows.length === 0) return null;
  const source = rows[0].task_ref.memo_id;
  const tasks = [];
  for (const row of rows) {
    if (row.status_type === "DONE" || row.status_type === "CANCELLED") return null;
    if (row.task_ref.memo_id !== source) return null;
    if (row.task_ref.line_hash === "") return null;
    tasks.push(row.task_ref);
  }
  return {
    source,
    tasks,
    destination: { Daily: shiftISODate(yesterdayISO, 1) },
    expected_destination_hash: todayHash,
  };
}

/** Client-side mirror of the backend undo gate (spec §7): undo may
 *  proceed only while BOTH notes still hash to the receipt's post-move
 *  values. A missing note (null) is unavailability, not a pass. */
export function undoAvailability(
  receipt: Pick<MoveTasksReceipt, "source_post_hash" | "destination_post_hash">,
  currentHashes: { source: string | null; destination: string | null },
): boolean {
  return (
    currentHashes.source === receipt.source_post_hash &&
    currentHashes.destination === receipt.destination_post_hash
  );
}

/* ---- Orchestration (palette command → confirm → commit → undo) ----- */

export interface TaskRolloverUI {
  t: Dict;
  setToast: (msg: string | null, action?: { label: string; onClick: () => void }) => void;
  setError: (msg: string | null) => void;
  /** Invalidate the ["base"] query family (task lists are base views). */
  invalidateBase: () => void;
}

const RUN_REQ: Omit<RunBaseReq, "offset"> = {
  viewIndex: 0,
  limit: 500,
  group: null,
  nowMs: null,
  localOffsetSeconds: null,
  includeGroupCounts: false,
  includeSummaries: false,
  thisId: null,
};

/** Yesterday's not-done task rows (one inline query). */
async function fetchRolloverRows(iso: string, folder: string): Promise<TaskDto[]> {
  const page = await runBase(
    { Inline: { yaml: rolloverCandidatesYaml(iso, folder) } },
    { ...RUN_REQ, offset: 0 },
  );
  const out: TaskDto[] = [];
  for (const row of page.rows) if (row.task !== null) out.push(row.task);
  return out;
}

/** Current hash of the note named `iso`, or null when it doesn't
 *  exist. Never creates — `move_tasks` owns first creation. */
async function fetchNoteHash(iso: string, folder: string): Promise<string | null> {
  const page = await runBase(
    { Inline: { yaml: dailyNoteByNameYaml(iso, folder) } },
    { ...RUN_REQ, offset: 0 },
  );
  return page.rows[0]?.summary.hash ?? null;
}

/** Palette command body: preview count → confirm toast → (on action)
 *  commit → done toast with Undo. Zero candidates short-circuits with
 *  the `task_rollover_none` toast, mirroring the CLI's `[]` output. */
export async function runTaskRollover(
  dailyFolder: string | null | undefined,
  ui: TaskRolloverUI,
): Promise<void> {
  const { t, setToast, setError } = ui;
  const folder = normalizeFolder(dailyFolder);
  const today = todayLocalISO();
  const yesterday = shiftISODate(today, -1);
  try {
    const rows = await fetchRolloverRows(yesterday, folder);
    if (rows.length === 0) {
      setToast(t.task_rollover_none);
      return;
    }
    const todayHash = await fetchNoteHash(today, folder);
    const request = rolloverRequest(yesterday, rows, todayHash);
    if (!request) {
      setToast(t.task_rollover_none);
      return;
    }
    setToast(t.task_rollover_confirm.replace("{n}", String(request.tasks.length)), {
      label: t.task_rollover_commit,
      onClick: () => {
        void commitRollover(request, { folder, today, yesterday, ui });
      },
    });
  } catch (e) {
    setError(String(e).split("\n")[0]);
  }
}

interface RolloverCtx {
  folder: string;
  today: string;
  yesterday: string;
  ui: TaskRolloverUI;
}

async function commitRollover(request: MoveTasksRequest, ctx: RolloverCtx): Promise<void> {
  const { t, setToast, setError, invalidateBase } = ctx.ui;
  try {
    const receipt = await moveTasks(request, ctx.today);
    // memos:changed (Rust) covers the note surfaces; base views hold
    // the task lists.
    invalidateBase();
    setToast(t.task_rollover_done.replace("{n}", String(request.tasks.length)), {
      label: t.task_rollover_undo,
      onClick: () => {
        void undoRollover(receipt, ctx);
      },
    });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("task conflict")) setToast(t.task_rollover_conflict);
    else setError(msg.split("\n")[0]);
  }
}

async function undoRollover(receipt: MoveTasksReceipt, ctx: RolloverCtx): Promise<void> {
  const { t, setToast, setError, invalidateBase } = ctx.ui;
  try {
    // Pre-flight the same gate the backend enforces under its lock:
    // refuse without a write when either note moved on.
    const [source, destination] = await Promise.all([
      fetchNoteHash(ctx.yesterday, ctx.folder),
      fetchNoteHash(ctx.today, ctx.folder),
    ]);
    if (!undoAvailability(receipt, { source, destination })) {
      setToast(t.task_rollover_conflict);
      return;
    }
    await undoMoveTasks(receipt);
    invalidateBase();
  } catch (e) {
    const msg = String(e);
    if (msg.includes("task conflict")) setToast(t.task_rollover_conflict);
    else setError(msg.split("\n")[0]);
  }
}
