/**
 * row_id-keyed distinctness for query-view rows (Plan C Task 5).
 *
 * Two task lines under one parent memo share the parent memo id but MUST
 * stay distinct by row_id (`t:<memo_id>:<line>`). A freeze map or reconcile
 * map keyed by note id collapses both tasks onto one slot and the table
 * loses a row; this test pins the row_id-keyed contract against the real
 * pure fns in tableModel.
 */
import { describe, expect, test } from "bun:test";

import {
  applyFrozenOrder,
  applyFrozenOrderByRowId,
  reconcileRow,
} from "./tableModel";
import type { BaseRow, Memo, MemoSummary, TaskDto, TaskRef } from "./types";

const PARENT_ID = "019282e5-1234-7000-8000-000000000001";

function summary(id: string, folder: string): MemoSummary {
  return {
    id,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    hash: "h",
    favorite: false,
    folder,
    path: `${folder}/${id}.md`,
    title: id,
    tags: [],
    props: {},
    preview: "",
    deleted: false,
  };
}

function taskRef(line: number): TaskRef {
  return {
    memo_id: PARENT_ID,
    line,
    line_hash: `b3:line${line}`,
  } as TaskRef;
}

function taskDto(line: number, text: string): TaskDto {
  return {
    task_ref: taskRef(line),
    symbol: "[ ]",
    status_type: "TODO",
    text,
    tags: [],
    section: null,
    created: null,
    start: null,
    scheduled: null,
    due: null,
    done: null,
    cancelled: null,
    priority: "none",
    recurrence: null,
    warnings: [],
  };
}

function noteRow(rowId: string): BaseRow {
  return {
    row_id: rowId,
    summary: summary(PARENT_ID, "inbox"),
    folder: "inbox",
    format: "markdown",
    task: null,
    cells: [],
  };
}

function taskRow(rowId: string, line: number, text: string): BaseRow {
  return {
    row_id: rowId,
    summary: summary(PARENT_ID, "inbox"),
    folder: "inbox",
    format: "markdown",
    task: taskDto(line, text),
    cells: [],
  };
}

describe("row_id-keyed identity (Plan C Task 5)", () => {
  test("two task rows + one note row sharing a parent memo id stay distinct by row_id", () => {
    const note = noteRow(`n:${PARENT_ID}`);
    const taskA = taskRow(`t:${PARENT_ID}:3`, 3, "first");
    const taskB = taskRow(`t:${PARENT_ID}:7`, 7, "second");
    const fresh: BaseRow[] = [note, taskA, taskB];

    // The legacy {id}-keyed freeze collapses two tasks onto the parent's id
    // — pin the failure mode so the contract is enforced going forward.
    const legacy = applyFrozenOrder(
      fresh.map((r) => ({ id: r.summary.id, _row: r })),
      [PARENT_ID],
    );
    expect(legacy.length).toBe(1);

    // The row_id-keyed freeze keeps every row distinct.
    const ordered = applyFrozenOrderByRowId(fresh, [taskB.row_id, note.row_id]);
    expect(ordered.map((r) => r.row_id)).toEqual([
      `t:${PARENT_ID}:7`,
      `n:${PARENT_ID}`,
      `t:${PARENT_ID}:3`,
    ]);
    expect(ordered.length).toBe(3);
  });

  test("reconcileRow keys remain memo-id scoped (note props), but the row_id slot is unaffected", () => {
    const note = noteRow(`n:${PARENT_ID}`);
    const dto: Memo = {
      ...note.summary,
      body: "",
      format: "markdown",
      deleted_at: null,
      title: "updated",
      hash: "h2",
      updated_at: "2026-02-02T00:00:00Z",
      props: { status: { Str: "active" } },
    };
    const patched = reconcileRow(note.summary, dto);
    expect(patched.id).toBe(PARENT_ID);
    expect(patched.title).toBe("updated");
    expect(patched.props).toEqual({ status: { Str: "active" } });

    // The row_id is independent of the patch — it identifies the slot, not
    // the note. A re-render with a fresh BasePage may reuse the same row_id
    // for the same task line, but two task rows from one parent never
    // collide because their row_ids differ at the line segment.
    const same = taskRow(`t:${PARENT_ID}:3`, 3, "first");
    expect(note.row_id).not.toBe(same.row_id);
  });

  test("row_id ordering survives when frozen snapshot drops one of the two tasks", () => {
    const note = noteRow(`n:${PARENT_ID}`);
    const taskA = taskRow(`t:${PARENT_ID}:3`, 3, "first");
    const taskB = taskRow(`t:${PARENT_ID}:7`, 7, "second");

    // Frozen list mentions taskA and taskB; fresh page only has taskB.
    const fresh: BaseRow[] = [note, taskB];
    const ordered = applyFrozenOrderByRowId(fresh, [taskA.row_id, taskB.row_id]);
    expect(ordered.map((r) => r.row_id)).toEqual([
      `t:${PARENT_ID}:7`,
      `n:${PARENT_ID}`,
    ]);
    expect(ordered.length).toBe(2);
  });

  test("null snapshot (post-reset) passes the fresh page through unchanged", () => {
    // Spec §4: TableView's resultKeyRef reset effect clears frozenIds
    // when the result cache generation changes — the very next render
    // sees `frozenIds === null` and `applyFrozenOrderByRowId` must
    // return the fresh page as-is (no ordering constraint). This pins
    // the post-reset passthrough the TableView reset effect depends on.
    const note = noteRow(`n:${PARENT_ID}`);
    const taskA = taskRow(`t:${PARENT_ID}:3`, 3, "first");
    const taskB = taskRow(`t:${PARENT_ID}:7`, 7, "second");
    const fresh: BaseRow[] = [taskB, note, taskA];
    expect(applyFrozenOrderByRowId(fresh, null).map((r) => r.row_id)).toEqual([
      `t:${PARENT_ID}:7`,
      `n:${PARENT_ID}`,
      `t:${PARENT_ID}:3`,
    ]);
  });
});
