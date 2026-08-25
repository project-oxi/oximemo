/**
 * Result-count store for query fences collapsed into previews (spec §6:
 * `[쿼리: N개 결과]`). Previews render synchronously, so counts resolve
 * asynchronously here — `queryPreviewCount` is a synchronous read that
 * kicks off a `run_base` (limit 1, aggregates off) on first miss, and
 * consumers re-render through `useSyncExternalStore(subscribe, version)`
 * when a count lands. Pending/error fall back to the bare `[쿼리]`
 * placeholder, so the preview never blocks on the backend.
 *
 * Cache key is `(thisId, yaml)`: a fence may reference `this.*`, which
 * resolves per containing note (same rule as the embed extension).
 * `bases:changed` / `memos:changed` clear the store; the backend result
 * cache makes the re-run cheap.
 */
import { runBase } from "./api";
import { listen } from "./tauri";
import type { RunBaseReq } from "./types";

type State = number | "error";

const cache = new Map<string, State>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let wired = false;

function emit() {
  version++;
  for (const l of listeners) l();
}

/** useSyncExternalStore subscription for count consumers. */
export function subscribeQueryCounts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** useSyncExternalStore snapshot: bumps whenever a count resolves. */
export function queryCountVersion(): number {
  return version;
}

/**
 * Synchronous count read. Returns the total when resolved, `null` while
 * pending or after an error (render `[쿼리]` then). First miss for a key
 * schedules the async resolve; wiring of the invalidation listeners is
 * lazy so importing this module stays side-effect free.
 */
export function queryPreviewCount(thisId: string | null, yaml: string): number | null {
  wire();
  const key = `${thisId ?? ""}\u0000${yaml}`;
  const st = cache.get(key);
  if (typeof st === "number") return st;
  if (st === undefined && !inflight.has(key)) void resolve(key, thisId, yaml);
  return null;
}

async function resolve(key: string, thisId: string | null, yaml: string) {
  inflight.add(key);
  const req: RunBaseReq = {
    viewIndex: 0,
    offset: 0,
    limit: 1,
    group: null,
    nowMs: null,
    localOffsetSeconds: null,
    includeGroupCounts: false,
    includeSummaries: false,
    thisId,
  };
  try {
    const page = await runBase({ Inline: { yaml } }, req);
    cache.set(key, page.total);
  } catch {
    // Malformed YAML / backend offline: keep the bare placeholder.
    cache.set(key, "error");
  } finally {
    inflight.delete(key);
    emit();
  }
}

function clear() {
  if (cache.size === 0) return;
  cache.clear();
  emit();
}

function wire() {
  if (wired) return;
  wired = true;
  void listen("bases:changed", clear).then((un) => {
    if (un) void un;
  });
  void listen("memos:changed", clear).then((un) => {
    if (un) void un;
  });
}
