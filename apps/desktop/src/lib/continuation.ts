/**
 * Request-source snapshot + staleness helpers for the AI continuation
 * button (MemoEditorForm). A continuation request takes seconds; the
 * answer only makes sense at the exact editor state it was asked from.
 * CM6 makes that check cheap with identity alone: swapping notes
 * remounts the editor (a fresh `EditorView` instance) and every edit —
 * including undo — produces a fresh `Text` doc instance. Same view
 * object and same doc instance ⇒ the captured cursor is still the
 * request source; anything else ⇒ the result is stale and must never
 * land at whatever cursor the editor shows now.
 */
import { type EditorState, type Text } from "@codemirror/state";

/** Only `state` is needed: staleness is judged from object identity
 *  (view + doc instance), never from re-reading positions. */
type ViewLike = { readonly state: EditorState };

/** Editor state captured when a continuation request starts. */
export interface ContinuationSource {
  /** View identity — a note switch remounts the editor, new instance. */
  view: ViewLike;
  /** Doc instance at request time — CM6 swaps it on every edit/undo. */
  doc: Text;
  /** Cursor offset the request was made from. */
  pos: number;
}

/** Capture the request source right before the provider call. */
export function continuationSource(view: ViewLike): ContinuationSource {
  return { view, doc: view.state.doc, pos: view.state.selection.main.head };
}

/** Editor text from the start up to (excluding) the captured cursor —
 *  the snapshot the provider continues from. Sent on EVERY request so
 *  unsaved prior continuations participate; the backend applies its own
 *  tail truncation. */
export function continuationPrefix(source: ContinuationSource): string {
  return source.doc.sliceString(0, source.pos);
}

export type ContinuationCheck = "apply" | "stale";

/** `"apply"` only when `live` is the very view instance the request came
 *  from AND no edit landed since (same doc instance). A selection move
 *  without an edit keeps the doc instance — the captured position is
 *  still the request source, so that still applies. */
export function continuationCheck(source: ContinuationSource, live: ViewLike): ContinuationCheck {
  return live === source.view && live.state.doc === source.doc ? "apply" : "stale";
}
