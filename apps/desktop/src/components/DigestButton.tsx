/**
 * Daily-note digest button (goal 2026-10-25, F8): an explicit header action
 * for daily notes that asks the copilot for a structured markdown digest of
 * the day's note. Never auto-fires (privacy invariant — note text leaves
 * only on an explicit act) and never writes directly: a reviewed digest is
 * appended through `onInsertBody` (the editor's guarded autosave path).
 * While the editor is dirty/saving the button is disabled — an append would
 * race the editor's external-write conflict guard.
 */
import { useEffect, useRef, useState } from "react";
import { ScrollText } from "lucide-react";

import { copilotSuggest } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { IconTool } from "./IconTool";

export interface DigestButtonProps {
  memoId: string;
  body: string;
  dirty: boolean;
  saving: boolean;
  onInsertBody: (next: string) => void;
}

export function DigestButton({ memoId, body, dirty, saving, onInsertBody }: DigestButtonProps) {
  const { t } = useI18n();
  const [running, setRunning] = useState(false);
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-note state: a note switch orphans in-flight responses and drops any
  // un-reviewed digest; unmount orphans too (no setState after unmount).
  const requestSeq = useRef(0);
  useEffect(() => {
    requestSeq.current += 1; // orphan in-flight responses from the old note
    setRunning(false);
    setDigest(null);
    setError(null);
    return () => {
      requestSeq.current += 1;
    };
  }, [memoId]);

  const busy = running;
  const conflict = dirty || saving;

  const generate = () => {
    if (busy || conflict) return;
    const seq = ++requestSeq.current;
    setRunning(true);
    setError(null);
    setDigest(null);
    copilotSuggest("digest", memoId)
      .then((r) => {
        if (requestSeq.current !== seq) return;
        const md = r.markdown?.trim();
        if (!md) {
          setError(t.daily_digest_failed);
        } else {
          setDigest(md);
        }
      })
      .catch((e) => {
        if (requestSeq.current !== seq) return;
        setError(`${t.daily_digest_failed}: ${String(e).split("\n")[0]}`);
      })
      .finally(() => {
        if (requestSeq.current === seq) setRunning(false);
      });
  };

  const insert = () => {
    if (!digest) return;
    onInsertBody(body.replace(/\n*$/, "") + "\n\n" + digest + "\n");
    setDigest(null);
  };

  return (
    <div className="relative flex items-center" data-daily-digest>
      <IconTool
        onClick={generate}
        disabled={busy || conflict}
        label={busy ? t.daily_digest_running : t.daily_digest}
        hint={conflict && !busy ? t.daily_digest_running : undefined}
        className="rounded-[var(--button-radius)] p-1 text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ScrollText size={13} />
      </IconTool>
      {(digest !== null || error !== null) && (
        <div
          role="dialog"
          aria-label={t.daily_digest}
          className="absolute right-0 top-full z-10 mt-1 w-80 rounded-md border border-line bg-surface p-2 shadow-lg"
        >
          {error !== null ? (
            <p className="text-xs text-text-muted">{error}</p>
          ) : (
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap font-sans text-xs text-text-muted">{digest}</pre>
          )}
          <div className="mt-2 flex justify-end gap-1.5">
            {digest !== null && (
              <button
                type="button"
                onClick={insert}
                className="rounded-[var(--button-radius)] bg-interactive-primary px-2 py-1 text-xs font-medium text-interactive-primary-foreground transition-colors duration-150 hover:bg-interactive-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                {t.daily_digest_insert}
              </button>
            )}
            <button
              type="button"
              onClick={() => { setDigest(null); setError(null); }}
              className="rounded-md border border-line px-2 py-1 text-xs text-text hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              {t.close}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
