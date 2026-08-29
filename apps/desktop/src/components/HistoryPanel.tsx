/**
 * Note history (Consumption Contract 1.3): the brain ledger's occurrence
 * chain for this note — every synced revision, oldest first, full content.
 * Purely additive (C1): a stopped daemon or disabled brain hides the panel
 * entirely; local mechanical undo is the git safety net's job, not this
 * panel's. Collapsed by default; the chain is fetched on first expand and
 * marked stale so reopened panels refresh.
 */
import { History, Loader2 } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { brainHistory } from "../lib/api";
import { useI18n } from "../lib/i18n";

export function HistoryPanel({ path }: { path: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["brain-history", path],
    queryFn: () => brainHistory(path),
    enabled: open,
    staleTime: 0,
    retry: false,
  });

  // Daemon offline / brain disabled / older daemon without the RPC:
  // the panel hides itself — never an error surface in the editor (C1).
  if (q.isError) return null;
  const episodes = q.data ?? [];
  const newest = [...episodes].reverse();

  return (
    <div className="border-t border-line pt-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-xs text-text-subtle transition-colors hover:bg-surface-muted hover:text-text"
      >
        <History size={12} />
        {t.brain_history}
        {q.isLoading && <Loader2 size={11} className="animate-spin" />}
        {!q.isLoading && episodes.length > 0 && (
          <span className="font-normal text-text-subtle">
            {t.brain_history_count.replace("{n}", String(episodes.length))}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1 max-h-56 space-y-1.5 overflow-y-auto px-1 pb-1">
          {q.isLoading ? null : episodes.length === 0 ? (
            <p className="py-1 text-xs text-text-subtle">{t.brain_history_empty}</p>
          ) : (
            newest.map((e) => {
              const content = e.content.trim();
              const shown = content.slice(0, 400);
              const remaining = content.length - shown.length;
              return (
                <div key={e.revision} className="rounded-md bg-surface-muted/60 px-2 py-1.5">
                  <p className="text-[10px] font-medium text-text-subtle">
                    {new Date(e.committed_at_ms).toLocaleString()}
                    <span className="ml-1 font-normal">#{e.revision.slice(0, 7)}</span>
                  </p>
                  <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-text">
                    {shown}
                  </pre>
                  {remaining > 0 && (
                    <p className="mt-0.5 text-[10px] text-text-subtle">
                      +{remaining} {t.brain_history_more_chars}
                    </p>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
