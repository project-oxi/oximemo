import { beforeEach, describe, expect, test } from "bun:test";
import { runCopilotTurn } from "./copilotTurn";
import type { TurnResult } from "./api";
import { useUI } from "../stores/ui";

const payload = {
  message: "Summarize the selection",
  memo: { id: "a", title: "Note A", path: "a.md", selection: "selected text" },
  referenced: [{ id: "b", title: "Note B", path: "b.md" }],
};
const result: TurnResult = {
  response: "Summary", session_id: "session-a", exit_code: 0, signal: null,
  stderr: "", timed_out: false, changed: [], duration_ms: 1,
  model: null, provider: null, denials: null,
};

beforeEach(() => {
  useUI.setState({ copilotBusy: false, copilotStartedAt: null });
  useUI.getState().resetCopilotChat();
});

describe("copilot turn ownership", () => {
  test("a second send cannot start before the first settles", async () => {
    const pending = Promise.withResolvers<TurnResult>();
    const first = runCopilotTurn(payload, () => pending.promise);
    let duplicateCalls = 0;
    expect(await runCopilotTurn(payload, async () => {
      duplicateCalls++;
      return result;
    })).toBeNull();
    expect(duplicateCalls).toBe(0);
    expect(useUI.getState().copilotEntries).toHaveLength(1);
    pending.resolve(result);
    await first;
    expect(useUI.getState().copilotEntries.map((e) => e.role)).toEqual(["user", "agent"]);
    expect(useUI.getState().copilotSession).toBe("session-a");
    expect(useUI.getState().copilotBusy).toBe(false);
  });

  test("reset discards a late response but retains the native busy lock", async () => {
    const pending = Promise.withResolvers<TurnResult>();
    const turn = runCopilotTurn(payload, () => pending.promise);
    useUI.getState().resetCopilotChat();
    expect(useUI.getState().copilotBusy).toBe(true);
    pending.resolve(result);
    expect(await turn).toEqual(result);
    expect(useUI.getState().copilotEntries).toEqual([]);
    expect(useUI.getState().copilotSession).toBeNull();
    expect(useUI.getState().copilotBusy).toBe(false);
  });

  test("reset also discards a late error", async () => {
    const pending = Promise.withResolvers<TurnResult>();
    const turn = runCopilotTurn(payload, () => pending.promise);
    useUI.getState().resetCopilotChat();
    pending.reject(new Error("old failure"));
    await turn;
    expect(useUI.getState().copilotEntries).toEqual([]);
    expect(useUI.getState().copilotStartedAt).toBeNull();
  });

  test("failure retains the exact context for retry", async () => {
    await runCopilotTurn(payload, async () => { throw new Error("unavailable\ndetail"); });
    const error = useUI.getState().copilotEntries.at(-1);
    expect(error?.role).toBe("error");
    if (error?.role !== "error") throw new Error("missing error entry");
    expect(error.retry).toEqual(payload);
    expect(error.text).toBe("Error: unavailable");
    expect(useUI.getState().copilotBusy).toBe(false);
  });

  test("closing preserves draft, references and detachment; new chat clears them", () => {
    useUI.setState({ copilotDraft: "draft", copilotReferences: payload.referenced,
      copilotDetachedMemoId: "a", copilotOpen: true });
    useUI.getState().setCopilotOpen(false);
    useUI.getState().setCopilotOpen(true);
    expect(useUI.getState().copilotDraft).toBe("draft");
    expect(useUI.getState().copilotReferences).toEqual(payload.referenced);
    expect(useUI.getState().copilotDetachedMemoId).toBe("a");
    useUI.getState().resetCopilotChat();
    expect(useUI.getState().copilotDraft).toBe("");
    expect(useUI.getState().copilotReferences).toEqual([]);
    expect(useUI.getState().copilotDetachedMemoId).toBeNull();
  });
});


test("nonzero completion keeps response and exact retry context", async () => {
  const failed = { ...result, response: "Partial work", exit_code: 1 };
  await runCopilotTurn(payload, async () => failed);
  const entry = useUI.getState().copilotEntries.at(-1);
  expect(entry?.role).toBe("agent");
  if (entry?.role !== "agent") throw new Error("missing completion");
  expect(entry.result.response).toBe("Partial work");
  expect(entry.retry).toEqual(payload);
});
