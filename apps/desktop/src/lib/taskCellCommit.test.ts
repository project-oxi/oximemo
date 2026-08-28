/**
 * Pure edit-mapping + board-drag gating for task cells (Plan C Task 6).
 *
 * The view layer calls `patchTask({ Exact: row.task.task_ref }, edit, today)`
 * with a wire-shape `TaskEdit` (externally-tagged PascalCase — see
 * `lib/api.ts::patchTask` and the adapters in `lib/taskLine.ts`). This test
 * pins the mapping from a column property + value to that wire shape so the
 * view layer doesn't reinvent the PascalCase strings per call site.
 *
 * Also pins the predicate that decides when a board drop should commit a
 * status edit (versus falling back to the existing note-prop mutation path).
 */
import { describe, expect, test } from "bun:test";

import {
  BUILTIN_STATUS_TABLE,
  dragCommitsStatus,
  editForCell,
  isEditableTaskColumn,
  nextSymbolFor,
} from "./taskCellCommit";
import type { BaseRow, TaskDto, TaskEdit, TaskRef } from "./types";

const REF: TaskRef = {
  memo_id: "019282e5-1234-7000-8000-000000000001",
  line: 0,
  line_hash: "0000000000000000" as TaskRef["line_hash"],
};

function taskRow(text: string, status: TaskDto["status_type"] = "TODO"): BaseRow {
  return {
    row_id: `t:${REF.memo_id}:${REF.line}`,
    summary: {
      id: REF.memo_id,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      hash: "h",
      favorite: false,
      folder: "ideas",
      path: `ideas/${REF.memo_id}.md`,
      title: text,
      tags: [],
      props: {},
      preview: text,
      deleted: false,
    },
    folder: "ideas",
    format: "markdown",
    task: {
      task_ref: REF,
      symbol: " ",
      status_type: status,
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
    },
    cells: [],
  };
}

function noteRow(): BaseRow {
  return {
    ...taskRow("ignored"),
    row_id: `n:${REF.memo_id}`,
    task: null,
  };
}

describe("editForCell (wire-shape TaskEdit mapping)", () => {
  test("task.status with no arg → Toggle (wire string)", () => {
    expect(editForCell("task.status")).toBe("Toggle");
  });

  test("task.status with explicit symbol → SetStatus (bare string)", () => {
    // Wire shape per Rust emitter: `{ SetStatus: "x" }` — value is a bare
    // string, not nested `{ symbol: "x" }` (the mirror's camelCase form is
    // the in-process shape; `patchTask` takes the PascalCase wire form).
    expect(editForCell("task.status", "x")).toEqual({ SetStatus: "x" });
  });

  test("task.due with ISO date → SetDate Due (PascalCase field word)", () => {
    expect(editForCell("task.due", "2026-08-30")).toEqual({
      SetDate: { field: "Due", value: "2026-08-30" },
    });
  });

  test("task.scheduled with ISO date → SetDate Scheduled", () => {
    expect(editForCell("task.scheduled", "2026-09-01")).toEqual({
      SetDate: { field: "Scheduled", value: "2026-09-01" },
    });
  });

  test("task.start with ISO date → SetDate Start", () => {
    expect(editForCell("task.start", "2026-08-29")).toEqual({
      SetDate: { field: "Start", value: "2026-08-29" },
    });
  });

  test("task.due with null → SetDate Due with null value (clear)", () => {
    expect(editForCell("task.due", null)).toEqual({
      SetDate: { field: "Due", value: null },
    });
  });

  test("task.priority with PascalCase word → SetPriority (bare word)", () => {
    expect(editForCell("task.priority", "High")).toEqual({ SetPriority: "High" });
  });

  test("task.priority with None → SetPriority None (clear)", () => {
    expect(editForCell("task.priority", "None")).toEqual({ SetPriority: "None" });
  });

  test("task.text with non-empty string → SetText", () => {
    expect(editForCell("task.text", "buy milk")).toEqual({ SetText: "buy milk" });
  });

  test("non-task property (note.rating) → undefined (handled by updateMemo path)", () => {
    expect(editForCell("note.rating", "5")).toBeUndefined();
    expect(editForCell("file.name", "x")).toBeUndefined();
    expect(editForCell("formula.score", "1")).toBeUndefined();
  });

  test("non-string priority value → undefined", () => {
    expect(editForCell("task.priority", 42 as unknown as string)).toBeUndefined();
  });

  test("every editForCell value fits the TaskEdit union (compile-time shape)", () => {
    // Type-level pin: declare each value as TaskEdit so a future refactor
    // that changes the wire shape breaks here first.
    const cases: TaskEdit[] = [
      editForCell("task.status")!,
      editForCell("task.status", "x")!,
      editForCell("task.due", "2026-08-30")!,
      editForCell("task.due", null)!,
      editForCell("task.priority", "High")!,
      editForCell("task.text", "x")!,
    ];
    expect(cases).toHaveLength(6);
  });
});

describe("isEditableTaskColumn", () => {
  test("task.* columns are editable when row.task is present", () => {
    const r = taskRow("buy milk");
    expect(isEditableTaskColumn("task.status", r)).toBe(true);
    expect(isEditableTaskColumn("task.due", r)).toBe(true);
    expect(isEditableTaskColumn("task.scheduled", r)).toBe(true);
    expect(isEditableTaskColumn("task.start", r)).toBe(true);
    expect(isEditableTaskColumn("task.priority", r)).toBe(true);
    expect(isEditableTaskColumn("task.text", r)).toBe(true);
  });

  test("note/file/formula columns are never editable through this path", () => {
    const r = taskRow("buy milk");
    expect(isEditableTaskColumn("note.rating", r)).toBe(false);
    expect(isEditableTaskColumn("file.name", r)).toBe(false);
    expect(isEditableTaskColumn("formula.score", r)).toBe(false);
  });

  test("task.* columns are read-only on note rows (no row.task)", () => {
    const r = noteRow();
    expect(isEditableTaskColumn("task.status", r)).toBe(false);
    expect(isEditableTaskColumn("task.due", r)).toBe(false);
  });
});

describe("nextSymbolFor (status toggle helper)", () => {
  test("uses the supplied status table — builtin space → x", () => {
    expect(nextSymbolFor(BUILTIN_STATUS_TABLE, " ")).toBe("x");
  });

  test("uses the supplied status table — builtin / → x", () => {
    expect(nextSymbolFor(BUILTIN_STATUS_TABLE, "/")).toBe("x");
  });

  test("uses the supplied status table — builtin x → space (back to todo)", () => {
    expect(nextSymbolFor(BUILTIN_STATUS_TABLE, "x")).toBe(" ");
  });

  test("uses the supplied status table — builtin - → space", () => {
    expect(nextSymbolFor(BUILTIN_STATUS_TABLE, "-")).toBe(" ");
  });

  test("unknown symbol returns the symbol unchanged (passthrough)", () => {
    expect(nextSymbolFor(BUILTIN_STATUS_TABLE, "Q")).toBe("Q");
  });

  test("custom status defs override builtins", () => {
    const custom = new Map(BUILTIN_STATUS_TABLE);
    custom.set("x", { next: "Q", type: "DONE" });
    expect(nextSymbolFor(custom, "x")).toBe("Q");
  });

  test("uppercase X normalizes to lowercase x (mirror's convention)", () => {
    expect(nextSymbolFor(BUILTIN_STATUS_TABLE, "X")).toBe(" ");
  });
});

describe("dragCommitsStatus (board drag gating)", () => {
  test("groupBy task.status → true (commits SetStatus on drop)", () => {
    expect(dragCommitsStatus("task.status")).toBe(true);
  });

  test("groupBy task.type → false (view-only, falls back to note-prop path or disables)", () => {
    expect(dragCommitsStatus("task.type")).toBe(false);
  });

  test("groupBy note.* → false (existing updateMemo path handles it)", () => {
    expect(dragCommitsStatus("note.status")).toBe(false);
    expect(dragCommitsStatus("note.priority")).toBe(false);
  });

  test("groupBy file.* → false", () => {
    expect(dragCommitsStatus("file.folder")).toBe(false);
  });

  test("groupBy null → false (no grouping configured)", () => {
    expect(dragCommitsStatus(null)).toBe(false);
  });
});
