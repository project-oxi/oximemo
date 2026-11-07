import type { WritingRevision } from "./api";

/** A rewrite is one exact, unambiguous source edit; never normalize Markdown. */
export function writingRevisionChange(source: string, revision: WritingRevision) {
  const { original, replacement } = revision;
  if (!original || original === replacement) return null;
  const from = source.indexOf(original);
  if (from < 0 || source.indexOf(original, from + 1) >= 0) return null;
  return { from, to: from + original.length, insert: replacement };
}

/** Project only the accepted raw span into CodeMirror's LF coordinate space.
 * Keep the source patch separate so saving does not normalize untouched CRLF. */
export function writingRevisionUpdate(source: string, revision: WritingRevision) {
  const raw = writingRevisionChange(source, revision);
  if (!raw) return null;
  const from = source.slice(0, raw.from).replace(/\r\n?/g, "\n").length;
  const to = from + source.slice(raw.from, raw.to).replace(/\r\n?/g, "\n").length;
  const nextSource = source.slice(0, raw.from) + raw.insert + source.slice(raw.to);
  return {
    change: { from, to, insert: raw.insert.replace(/\r\n?/g, "\n") },
    nextSource,
    editorSource: source.replace(/\r\n?/g, "\n"),
    nextEditorSource: nextSource.replace(/\r\n?/g, "\n"),
  };
}

export type WritingReviewDecision = "pending" | "applied" | "ignored";
export interface WritingReviewItem {
  revision: WritingRevision;
  decision: WritingReviewDecision;
}

/** Resolving one item never consumes or hides the next pending suggestion. */
export function decideWritingReview(items: readonly WritingReviewItem[], index: number, decision: Exclude<WritingReviewDecision, "pending">): WritingReviewItem[] {
  return items.map((item, position) => position === index && item.decision === "pending"
    ? { ...item, decision } : item);
}
