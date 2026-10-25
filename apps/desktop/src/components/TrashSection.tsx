import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listTrashedMemos, restoreNotes } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { RowsSkeleton } from "./Skeletons";
import { useUI } from "../stores/ui";

/** Recovery remains available after the deletion toast has expired. */
export function TrashSection({ retentionDays }: { retentionDays: number }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const setToast = useUI((s) => s.setToast);
  const trash = useQuery({ queryKey: ["trash"], queryFn: listTrashedMemos });
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(20);

  const restore = async (id: string) => {
    setRestoring(id);
    setError(null);
    try {
      await restoreNotes([id]);
      for (const key of ["trash", "memos", "search", "facets", "folders", "folderChildren", "stats", "base"]) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
      setToast(t.memo_restored);
    } catch (e) {
      setError(String(e).split("\n")[0]);
    } finally {
      setRestoring(null);
    }
  };

  return (
    <section className="mt-5 border-t border-line pt-3" aria-label={t.trash_section}>
      <h3 className="text-xs font-semibold text-text">{t.trash_section}</h3>
      <p className="mt-1 text-[11px] text-text-subtle">{t.trash_hint.replace("{n}", String(retentionDays))}</p>
      {trash.isPending && (
        <div className="mt-2">
          <RowsSkeleton rows={2} />
        </div>
      )}
      {(error || trash.isError) && (
        <div role="alert" className="mt-2 text-xs text-status-error">
          <p>{error || String(trash.error).split("\n")[0]}</p>
          {trash.isError && <button type="button" onClick={() => void trash.refetch()} className="mt-1 underline">{t.retry}</button>}
        </div>
      )}
      {trash.data?.length === 0 && <p className="mt-2 text-xs text-text-subtle">{t.trash_empty}</p>}
      {!!trash.data?.length && (
        <ul className="mt-2 space-y-1">
          {trash.data.slice(0, visible).map((note) => (
            <li key={note.id} className="flex items-center gap-3 rounded-lg bg-surface-sunken px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-text" title={note.title || t.empty_memo}>{note.title || t.empty_memo}</p>
                <p className="truncate text-[11px] text-text-subtle" title={note.path}>{note.path}</p>
              </div>
              <button
                type="button"
                disabled={restoring !== null}
                aria-label={t.trash_restore_note.replace("{title}", note.title || t.empty_memo)}
                onClick={() => void restore(note.id)}
                className="shrink-0 rounded-md border border-line px-2 py-1 text-xs text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:opacity-40"
              >
                {restoring === note.id ? t.trash_restoring : t.trash_restore}
              </button>
            </li>
          ))}
        </ul>
      )}
      {trash.data && trash.data.length > visible && (
        <button type="button" onClick={() => setVisible((n) => n + 20)} className="mt-2 rounded-md border border-line px-2 py-1 text-xs text-text focus-visible:outline-2 focus-visible:outline-focus-ring">{t.trash_more}</button>
      )}
    </section>
  );
}
