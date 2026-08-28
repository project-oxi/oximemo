import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { useUI } from "../stores/ui";
import { openTask, type OpenTaskDeps } from "./taskNav";
import type { TaskRef } from "./types";

const REF: TaskRef = { memo_id: "m1", line: 4, line_hash: "h4" as TaskRef["line_hash"] };

/** Recorded calls of every injected dependency, in order. */
interface Recorded {
  selects: string[];
  anchors: ({ memoId: string; line: number } | null)[];
  resolves: TaskRef[];
  staleCount: number;
}

function makeDeps(
  overrides: Partial<OpenTaskDeps> & { resolveLine?: number | null },
): { deps: OpenTaskDeps; rec: Recorded } {
  const rec: Recorded = {
    selects: [],
    anchors: [],
    resolves: [],
    staleCount: 0,
  };
  const customResolve = overrides.resolve;
  const deps: OpenTaskDeps = {
    select: (id) => {
      rec.selects.push(id);
    },
    setAnchor: (a) => {
      rec.anchors.push(a);
    },
    resolve: async (ref) => {
      rec.resolves.push(ref);
      if (customResolve) return customResolve(ref);
      return overrides.resolveLine ?? null;
    },
    onStale: () => {
      rec.staleCount += 1;
    },
  };
  return { deps, rec };
}

describe("openTask flow", () => {
  test("fresh line: select runs first, then anchor on the same line", async () => {
    const { deps, rec } = makeDeps({ resolveLine: 4 });
    await openTask(REF, deps);
    expect(rec.selects).toEqual(["m1"]);
    expect(rec.resolves).toEqual([REF]);
    expect(rec.anchors).toEqual([{ memoId: "m1", line: 4 }]);
    expect(rec.staleCount).toBe(0);
  });

  test("moved line: anchor stores the RESOLVED line, not the ref's", async () => {
    const { deps, rec } = makeDeps({ resolveLine: 7 });
    await openTask(REF, deps);
    expect(rec.selects).toEqual(["m1"]);
    expect(rec.anchors).toEqual([{ memoId: "m1", line: 7 }]);
    expect(rec.staleCount).toBe(0);
  });

  test("stale: clear anchor and fire onStale; select still ran", async () => {
    const { deps, rec } = makeDeps({ resolveLine: null });
    await openTask(REF, deps);
    expect(rec.selects).toEqual(["m1"]);
    expect(rec.anchors).toEqual([null]);
    expect(rec.staleCount).toBe(1);
  });

  test("no onStale provided: stale still clears anchor, no crash", async () => {
    const { deps } = makeDeps({ resolveLine: null });
    const safeDeps: OpenTaskDeps = {
      select: deps.select,
      setAnchor: deps.setAnchor,
      resolve: deps.resolve,
    };
    await openTask(REF, safeDeps);
    expect(useUI.getState().pendingTaskAnchor).toBeNull();
  });

  test("resolve is awaited before setAnchor — anchor reflects post-resolve state", async () => {
    const order: string[] = [];
    const deps: OpenTaskDeps = {
      select: (id) => {
        order.push(`select:${id}`);
      },
      setAnchor: (a) => {
        order.push(`anchor:${a?.line ?? "null"}`);
      },
      resolve: async (r) => {
        order.push("resolve");
        return r.line + 1;
      },
    };
    await openTask(REF, deps);
    expect(order).toEqual(["select:m1", "resolve", "anchor:5"]);
  });

  test("resolve rejection propagates; no anchor, no onStale", async () => {
    const rec: Recorded = { selects: [], anchors: [], resolves: [], staleCount: 0 };
    const deps: OpenTaskDeps = {
      select: (id) => rec.selects.push(id),
      setAnchor: (a) => rec.anchors.push(a),
      resolve: async () => {
        throw new Error("network");
      },
      onStale: () => {
        rec.staleCount += 1;
      },
    };
    await expect(openTask(REF, deps)).rejects.toThrow("network");
    expect(rec.anchors).toEqual([]);
    expect(rec.staleCount).toBe(0);
  });
});

describe("ui store: pendingTaskAnchor + consume", () => {
  beforeEach(() => {
    useUI.setState({ pendingTaskAnchor: null });
  });
  afterEach(() => {
    useUI.setState({ pendingTaskAnchor: null });
  });

  test("setTaskAnchor writes and consumeTaskAnchor reads on a memoId match", () => {
    useUI.getState().setTaskAnchor({ memoId: "m1", line: 3 });
    const line = useUI.getState().consumeTaskAnchor("m1");
    expect(line).toBe(3);
    // Cleared after match
    expect(useUI.getState().pendingTaskAnchor).toBeNull();
  });

  test("mismatched memoId leaves the anchor intact", () => {
    useUI.getState().setTaskAnchor({ memoId: "m1", line: 3 });
    const line = useUI.getState().consumeTaskAnchor("m2");
    expect(line).toBeNull();
    expect(useUI.getState().pendingTaskAnchor).toEqual({ memoId: "m1", line: 3 });
  });

  test("consume when nothing queued returns null", () => {
    expect(useUI.getState().consumeTaskAnchor("anything")).toBeNull();
  });

  test("setTaskAnchor(null) clears explicitly", () => {
    useUI.getState().setTaskAnchor({ memoId: "m1", line: 3 });
    useUI.getState().setTaskAnchor(null);
    expect(useUI.getState().pendingTaskAnchor).toBeNull();
  });

  test("back-to-back consumes: first wins, second sees null", () => {
    useUI.getState().setTaskAnchor({ memoId: "m1", line: 9 });
    expect(useUI.getState().consumeTaskAnchor("m1")).toBe(9);
    expect(useUI.getState().consumeTaskAnchor("m1")).toBeNull();
  });

  test("openTask end-to-end with the real store: fresh line persists", async () => {
    useUI.setState({ pendingTaskAnchor: null });
    const rec: Recorded = { selects: [], anchors: [], resolves: [], staleCount: 0 };
    const deps: OpenTaskDeps = {
      select: (id) => rec.selects.push(id),
      setAnchor: (a) => {
        rec.anchors.push(a);
        useUI.getState().setTaskAnchor(a);
      },
      resolve: async (_r) => 4,
    };
    await openTask(REF, deps);
    expect(useUI.getState().pendingTaskAnchor).toEqual({ memoId: "m1", line: 4 });
    expect(useUI.getState().consumeTaskAnchor("m1")).toBe(4);
    expect(useUI.getState().pendingTaskAnchor).toBeNull();
  });

  test("openTask end-to-end with the real store: stale clears any prior anchor", async () => {
    useUI.setState({ pendingTaskAnchor: { memoId: "m-OTHER", line: 99 } });
    const deps: OpenTaskDeps = {
      select: () => {},
      setAnchor: (a) => useUI.getState().setTaskAnchor(a),
      resolve: async (_r) => null,
    };
    await openTask(REF, deps);
    expect(useUI.getState().pendingTaskAnchor).toBeNull();
  });
});
