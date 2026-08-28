/** Pure builders for the palette's 어제의 미완료 이월 command (tasks spec
 *  §7 rollover; Plan E Task 4): the request builder's strict-refs and
 *  destination-hash policy, the undo availability gate, and the inline
 *  query YAML the fetch step ships to `run_base`. */
import { describe, expect, test } from "bun:test";

import {
  dailyNoteByNameYaml,
  rolloverCandidatesYaml,
  rolloverRequest,
  undoAvailability,
} from "./taskRollover";
import type { MoveTasksReceipt, TaskDto, TaskLineHash } from "./types";

const MEMO = "019282e5-1234-7000-8000-0000000000aa";

/** Minimal TaskDto — only the fields rolloverRequest reads. */
function row(over: Partial<TaskDto> = {}): TaskDto {
  return {
    task_ref: { memo_id: MEMO, line: 4, line_hash: "aabbccddeeff0011" as TaskLineHash },
    symbol: "[ ]",
    text: "남은 할 일",
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
    ...over,
  } as TaskDto;
}

describe("rolloverRequest", () => {
  test("builds a request with verbatim strict refs and yesterday+1 destination", () => {
    const rows = [
      row(),
      row({
        task_ref: { memo_id: MEMO, line: 9, line_hash: "1122334455667788" as TaskLineHash },
      }),
    ];
    const req = rolloverRequest("2026-08-28", rows, "b3:todayhash");
    expect(req).not.toBeNull();
    expect(req!.source).toBe(MEMO);
    // Strict refs: the exact task_ref objects the query read — never
    // re-derived, so the stale-write guards bind to what the user saw.
    expect(req!.tasks).toEqual([rows[0].task_ref, rows[1].task_ref]);
    // Rollover targets the day after the source date (CLI from/to pair).
    expect(req!.destination).toEqual({ Daily: "2026-08-29" });
    expect(req!.expected_destination_hash).toBe("b3:todayhash");
  });

  test("destination-hash policy: null today hash passes through (first creation, CLI parity)", () => {
    const req = rolloverRequest("2026-08-28", [row()], null);
    expect(req).not.toBeNull();
    expect(req!.expected_destination_hash).toBeNull();
  });

  test("month and year boundaries roll the destination date correctly", () => {
    expect(rolloverRequest("2026-09-30", [row()], null)!.destination).toEqual({
      Daily: "2026-10-01",
    });
    expect(rolloverRequest("2026-12-31", [row()], null)!.destination).toEqual({
      Daily: "2027-01-01",
    });
    expect(rolloverRequest("2028-02-28", [row()], null)!.destination).toEqual({
      Daily: "2028-02-29",
    });
  });

  test("empty rows → null (nothing to carry over)", () => {
    expect(rolloverRequest("2026-08-28", [], "b3:h")).toBeNull();
  });

  test("done-family rows are rejected — rollover carries only not-done tasks", () => {
    expect(rolloverRequest("2026-08-28", [row({ status_type: "DONE" })], null)).toBeNull();
    expect(rolloverRequest("2026-08-28", [row({ status_type: "CANCELLED" })], null)).toBeNull();
    // A done task among not-done ones poisons the batch: the query
    // filtered, so its presence means stale data — refuse rather than
    // move the wrong lines.
    expect(
      rolloverRequest("2026-08-28", [row(), row({ status_type: "DONE" })], null),
    ).toBeNull();
  });

  test("mixed-source rows are rejected — one move, one source note", () => {
    const other = row({
      task_ref: { memo_id: "019282e5-9999-7999-9999-999999999999", line: 2, line_hash: "ff" as TaskLineHash },
    });
    expect(rolloverRequest("2026-08-28", [row(), other], null)).toBeNull();
  });
});

describe("undoAvailability", () => {
  const receipt: MoveTasksReceipt = {
    source: MEMO,
    destination: "019282e5-1234-7000-8000-0000000000bb",
    source_pre_hash: "b3:pre",
    source_post_hash: "b3:srcpost",
    destination_pre_hash: "b3:dstpre",
    destination_post_hash: "b3:dstpost",
    moved_lines: ["- [ ] 남은 할 일"],
  };

  test("available only while both notes still match the post-move hashes", () => {
    expect(
      undoAvailability(receipt, { source: "b3:srcpost", destination: "b3:dstpost" }),
    ).toBe(true);
  });

  test("source drift blocks undo", () => {
    expect(
      undoAvailability(receipt, { source: "b3:changed", destination: "b3:dstpost" }),
    ).toBe(false);
  });

  test("destination drift blocks undo", () => {
    expect(
      undoAvailability(receipt, { source: "b3:srcpost", destination: "b3:edited" }),
    ).toBe(false);
  });

  test("a missing note (null hash) blocks undo — never erase by absence", () => {
    expect(undoAvailability(receipt, { source: null, destination: "b3:dstpost" })).toBe(false);
    expect(undoAvailability(receipt, { source: "b3:srcpost", destination: null })).toBe(false);
  });
});

describe("inline query YAML", () => {
  test("candidates yaml: tasks source, not-done, file.name pinned to yesterday, daily folder", () => {
    const yaml = rolloverCandidatesYaml("2026-08-28", "daily");
    expect(yaml).toContain("source: tasks");
    expect(yaml).toContain('task.type != "DONE" && task.type != "CANCELLED"');
    expect(yaml).toContain('file.name == "2026-08-28"');
    expect(yaml).toContain('file.inFolder("daily")');
  });

  test("note-lookup yaml: notes source (no `source:` line), name + folder only", () => {
    const yaml = dailyNoteByNameYaml("2026-08-29", "daily");
    expect(yaml).not.toContain("source: tasks");
    expect(yaml).toContain('file.name == "2026-08-29"');
    expect(yaml).toContain('file.inFolder("daily")');
    expect(yaml).not.toContain("task.type");
  });

  test("daily folder is normalized: trailing slash trimmed, blank falls back to default", () => {
    expect(rolloverCandidatesYaml("2026-08-28", "일상/")).toContain('file.inFolder("일상")');
    expect(rolloverCandidatesYaml("2026-08-28", "")).toContain('file.inFolder("daily")');
    expect(dailyNoteByNameYaml("2026-08-29", "  ")).toContain('file.inFolder("daily")');
  });
});
