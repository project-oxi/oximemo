import { Button } from "@garden/ui";
import { useEffect, useRef, useState } from "react";
import { copilotSuggest, type WritingRevision } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { decideWritingReview, writingRevisionChange, type WritingReviewItem } from "../lib/writingReview";
import { useUI } from "../stores/ui";

interface Props {
  noteId: string;
  body: string;
  ready: boolean;
  onApply: (revision: WritingRevision, expectedSource: string) => boolean;
}

export function WritingReview({ noteId, body, ready, onApply }: Props) {
  const { t } = useI18n();
  const [review, setReview] = useState<{ source: string; items: WritingReviewItem[]; truncated: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const pendingRequest = useRef<number | null>(null);
  const live = useRef({ noteId, body });
  live.current = { noteId, body };
  useEffect(() => {
    sequence.current += 1;
    pendingRequest.current = null;
    setReview(null);
    setRunning(false);
    setError(null);
    return () => { sequence.current += 1; };
  }, [noteId]);

  const request = async () => {
    if (!ready || pendingRequest.current !== null) return;
    const requestId = ++sequence.current;
    pendingRequest.current = requestId;
    const source = body;
    setRunning(true);
    setError(null);
    try {
      const result = await copilotSuggest("review", noteId, source);
      if (sequence.current !== requestId) return;
      if (live.current.noteId !== noteId || live.current.body !== source) {
        setError(t.writing_review_stale);
        return;
      }
      setReview({ source, truncated: result.review_truncated ?? false,
        items: (result.revisions ?? []).map((revision) => ({ revision, decision: "pending" })) });
    } catch (cause) {
      if (sequence.current === requestId) setError(String(cause).split("\n")[0]);
    } finally {
      if (pendingRequest.current === requestId) pendingRequest.current = null;
      if (sequence.current === requestId) setRunning(false);
    }
  };

  const index = review?.items.findIndex((item) => item.decision === "pending") ?? -1;
  const item = index >= 0 ? review!.items[index] : null;
  const pending = review?.items.filter((entry) => entry.decision === "pending").length ?? 0;
  const stale = review !== null && review.source !== body;
  const change = item && review ? writingRevisionChange(body, item.revision) : null;
  const resolved = review?.items.filter((entry) => entry.decision !== "pending") ?? [];

  return (
    <section className="space-y-3" aria-label={t.writing_review}>
      {ready ? (
        <Button size="sm" variant="secondary" disabled={running || !body.trim()} onClick={() => { void request(); }}>
          {running ? t.writing_review_running : review ? t.writing_review_again : t.writing_copilot_review}
        </Button>
      ) : (
        <div className="space-y-2">
          <p className="leading-relaxed text-text-muted">{t.writing_review_setup}</p>
          <Button size="sm" variant="secondary" onClick={() => {
            const ui = useUI.getState();
            ui.setSettingsTab("copilot");
            ui.setSettingsOpen(true);
          }}>{t.settings}</Button>
        </div>
      )}
      <p role="status" aria-live="polite" className="text-text-subtle">
        {running ? t.writing_review_running : review
          ? pending ? t.writing_review_remaining.replace("{n}", String(pending))
            : review.items.length ? t.writing_review_finished : t.writing_review_empty
          : t.writing_review_ai_hint}
      </p>
      {error && <p role="alert" className="break-words text-text-muted">{error}</p>}
      {review?.truncated && <p className="text-text-muted">{t.writing_review_truncated}</p>}
      {stale && <p role="alert" className="text-text-muted">{t.writing_review_stale}</p>}
      {item && (
        <article className="space-y-3 rounded-md border border-line p-3" aria-label={t.writing_review_proposal}>
          <div>
            <h3 className="mb-1 text-text-subtle">{t.writing_review_original}</h3>
            <p className="whitespace-pre-wrap break-words text-text-muted">{item.revision.original}</p>
          </div>
          <div>
            <h3 className="mb-1 text-text-subtle">{t.writing_review_replacement}</h3>
            <p className="whitespace-pre-wrap break-words font-medium">{item.revision.replacement || t.writing_review_delete}</p>
          </div>
          <p className="break-words leading-relaxed text-text-muted">{item.revision.reason}</p>
          {!change && !stale && <p className="text-text-muted">{t.writing_review_unmatched}</p>}
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={running || stale || !change} onClick={() => {
              if (!review || !change || live.current.body !== review.source) return;
              if (!onApply(item.revision, review.source)) {
                setError(t.writing_review_stale);
                return;
              }
              const source = body.slice(0, change.from) + change.insert + body.slice(change.to);
              setReview({ ...review, source, items: decideWritingReview(review.items, index, "applied") });
              setError(null);
            }}>{t.writing_review_apply}</Button>
            <Button size="sm" variant="ghost" disabled={running} onClick={() => {
              if (review) setReview({ ...review, items: decideWritingReview(review.items, index, "ignored") });
            }}>{t.writing_review_ignore}</Button>
          </div>
        </article>
      )}
      {resolved.length > 0 && (
        <details className="text-text-muted">
          <summary className="cursor-pointer">{t.writing_review_resolved.replace("{n}", String(resolved.length))}</summary>
          <ul className="mt-2 space-y-2">
            {resolved.map((entry, position) => (
              <li key={position} className="space-y-1 border-t border-line pt-2">
                <span className="font-medium">{entry.decision === "applied" ? t.writing_review_applied : t.writing_review_ignored}</span>
                <p className="whitespace-pre-wrap break-words">{entry.revision.original}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
