/**
 * Wire-boundary repair for memo summaries (v0.10.0 launch crash).
 *
 * The 2026-08-23 folder redesign made `path` the single source of truth on
 * the Rust DTO (`MemoSummary` no longer serializes `folder`), but the
 * frontend contract (`types.ts`) and its consumers (cards, sidebar,
 * palette, timeline, list view) still read `memo.folder`. With real Tauri
 * data that field arrived `undefined` and crashed the launch render
 * (`hueFor(undefined)` → "reading 'length'"); the browser fallback
 * synthesizes `folder`, which is why dev/browser mode never failed.
 *
 * The adapter (lib/tauri.ts) funnels every summary-bearing response
 * through here so consumers keep seeing the folder the type promises.
 */
import { parentOf } from "./dropTarget";

/** A wire MemoSummary: `folder` may be absent (Rust omits it by design). */
type SummaryLike = { path: string; folder?: string };

/** Derive `folder` from `path` when the wire omitted it ("" = vault root). */
export function withFolder<T extends SummaryLike>(m: T): T & { folder: string } {
  return { ...m, folder: m.folder ?? parentOf(m.path) };
}


/**
 * Repair one invoke response in place by command name. Responses that carry
 * no summaries (or are null/error-shaped) pass through untouched.
 */
export function normalizeSummaries<T>(cmd: string, res: T): T {
  if (res === null || res === undefined) return res;
  switch (cmd) {
    case "list_memos":
    case "query_notes": {
      const page = res as { items?: SummaryLike[] };
      if (Array.isArray(page.items)) {
        return { ...page, items: page.items.map((m) => withFolder(m)) } as T;
      }
      return res;
    }
    case "search_memos":
      return (Array.isArray(res) ? (res as SummaryLike[]).map((m) => withFolder(m)) : res) as T;
    case "run_base": {
      const page = res as { rows?: { summary?: SummaryLike }[] };
      if (Array.isArray(page.rows)) {
        return {
          ...page,
          rows: page.rows.map((r) =>
            r.summary ? { ...r, summary: withFolder(r.summary) } : r,
          ),
        } as T;
      }
      return res;
    }
    default:
      return res;
  }
}
