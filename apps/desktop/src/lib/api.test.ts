import { describe, expect, test } from "bun:test";

import {
  addTask,
  listTasks,
  moveTasks,
  patchTask,
  resolveTaskLine,
  transformTaskDraft,
} from "./api";
import type { TaskLineHash, TaskRef } from "./types";

/**
 * Browser-mode task-command policy. Bun defines no `window`, so
 * `invoke` (lib/tauri.ts) routes to `browserFallback` — the fallback IS
 * the unit under test, no mock layer needed (summaryFolder.test.ts
 * convention). The desktop paths are exercised by the Rust gates.
 */

const ref: TaskRef = {
  memo_id: "01999999-9999-7999-9999-999999999999",
  line: 0,
  line_hash: "0000000000000000" as TaskLineHash,
};

const DESKTOP_ONLY = "task commands require the desktop app";

describe("task commands in browser mode", () => {
  test("the five vault commands reject desktop-only", async () => {
    await expect(listTasks(null)).rejects.toThrow(DESKTOP_ONLY);
    await expect(resolveTaskLine(ref.memo_id, 0, "0".repeat(16))).rejects.toThrow(
      DESKTOP_ONLY,
    );
    await expect(patchTask({ Exact: ref }, "Toggle", "2026-08-28")).rejects.toThrow(
      DESKTOP_ONLY,
    );
    await expect(
      addTask("Inbox", "text", {
        created: null,
        start: null,
        scheduled: null,
        due: null,
        priority: "None",
        recurrence: null,
        tags: [],
      }, "2026-08-28"),
    ).rejects.toThrow(DESKTOP_ONLY);
    await expect(
      moveTasks(
        { source: ref.memo_id, tasks: [ref], destination: "Inbox", expected_destination_hash: null },
        "2026-08-28",
      ),
    ).rejects.toThrow(DESKTOP_ONLY);
  });

  test("transform_task_draft dispatches to the taskLine mirror", async () => {
    // Golden-corpus case `toggle_done_to_todo_clears_done`: toggling a
    // done task back to todo clears the ✅ done date (today is unused).
    const out = await transformTaskDraft("- [x] task ✅ 2026-08-20\n", 0, "Toggle", "2026-08-27");
    expect(out.changes).toEqual([
      {
        start_line: 0,
        delete_lines: 1,
        insert_lines: ["- [ ] task "],
      },
    ]);
    // The browser mirror does not track the spawn hint.
    expect(out.spawned_line_hint).toBeNull();
  });

  test("transform_task_draft accepts the tagged wire edit forms", async () => {
    const out = await transformTaskDraft(
      "- [ ] task\n",
      0,
      { SetPriority: "High" },
      "2026-08-27",
    );
    expect(out.changes[0]?.insert_lines[0]).toBe("- [ ] task ⏫");
  });

  test("transform_task_draft validates today like the Rust command", async () => {
    await expect(transformTaskDraft("- [ ] t\n", 0, "Toggle", "08/27/2026")).rejects.toThrow(
      "expected YYYY-MM-DD",
    );
  });
});
