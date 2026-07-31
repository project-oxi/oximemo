/**
 * Note detail + editor (§7.3). Opens (controlled by the `selectedId` UI state)
 * as a Base UI Dialog, loads the full note via `get_note`, and debounces edits
 * into `update_note` (500ms autosave). A pending edit is flushed on close so no
 * input is lost.
 */
import { Dialog } from "@base-ui-components/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pin } from "lucide-react";

import { deleteNote, getNote, updateNote, listCategories } from "../lib/api";
import { colorForCategory, paperFor } from "../lib/color";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";
import { NoteEditorForm } from "./NoteEditorForm";
import type { CategoryDef } from "../lib/types";

export function NoteDetail() {
  const { t } = useI18n();
  const selectedId = useUI((s) => s.selectedId);
  const select = useUI((s) => s.select);
  const setError = useUI((s) => s.setError);
  const draftId = useUI((s) => s.draftId);
  const setDraftId = useUI((s) => s.setDraftId);
  const open = selectedId !== null;
  const qc = useQueryClient();

  const note = useQuery({
    queryKey: ["note", selectedId],
    queryFn: () => getNote(selectedId!),
    enabled: open,
  });

  const [body, setBody] = useState("");
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<CategoryDef[]>([]);
  const [pinned, setPinned] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [seededId, setSeededId] = useState<string | null>(null);

  useEffect(() => {
    listCategories().then(setCategories).catch(() => {});
  }, []);

  // Seed the draft exactly once per loaded note; reset when the dialog closes.
  useEffect(() => {
    if (open && note.data && seededId !== note.data.id) {
      setBody(note.data.body);
      setCategory(note.data.category);
      setPinned(note.data.pinned);
      setDirty(false);
      setSeededId(note.data.id);
    }
    if (!open && seededId !== null) setSeededId(null);
  }, [open, note.data, seededId]);

  // Debounced autosave (§7.3, 500ms).
  useEffect(() => {
    if (!dirty || !selectedId) return;
    const h = window.setTimeout(() => {
      void updateNote(selectedId, body, pinned, category)
        .then((n) => {
          qc.setQueryData(["note", selectedId], n);
          setDirty(false);
          qc.invalidateQueries({ queryKey: ["notes"] });
          qc.invalidateQueries({ queryKey: ["facets"] });
        })
        .catch((e) => {
          setError(String(e).split("\n")[0]);
          // Leave dirty=true so the next change or a manual retry attempts
          // the save again; the user can also close to flush.
        });
    }, 500);
    return () => window.clearTimeout(h);
  }, [dirty, body, pinned, category, selectedId, qc]);

  const close = () => {
    // A note minted by "new note" this session is discarded while still
    // empty, so cancelled drafts don't accumulate as orphan files.
    if (selectedId && selectedId === draftId && !body.trim()) {
      void deleteNote(selectedId)
        .then(() => qc.invalidateQueries({ queryKey: ["notes"] }))
        .catch((e) => setError(String(e).split("\n")[0]));
      setDraftId(null);
      select(null);
      return;
    }
    // Flush a pending edit before dismissing.
    if (dirty && selectedId) {
      void updateNote(selectedId, body, pinned, category)
        .then((n) => {
          qc.setQueryData(["note", selectedId], n);
          qc.invalidateQueries({ queryKey: ["notes"] });
          qc.invalidateQueries({ queryKey: ["facets"] });
        })
        .catch((e) => setError(String(e).split("\n")[0]));
    }
    if (selectedId === draftId) setDraftId(null);
    select(null);
  };

  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDirty(true);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" />
        <Dialog.Popup
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              close();
            }
          }}
          className="fixed left-1/2 top-1/2 z-50 isolate flex max-h-[80vh] w-[min(640px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-hidden rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
        >
          {category && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 -z-10"
              style={{ backgroundColor: paperFor(colorForCategory(category, categories)) }}
            />
          )}
          {note.isLoading || !note.data || seededId !== note.data.id ? (
            <div className="py-10 text-center text-sm text-zinc-400">…</div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-400">
                  {note.data.id.slice(0, 8)}
                </span>
                <button
                  type="button"
                  onClick={() => edit(setPinned)(!pinned)}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] transition-colors ${
                    pinned
                      ? "bg-amber-100 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400"
                      : "text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                  }`}
                >
                  <Pin size={12} /> {t.pinned}
                </button>
              </div>
              <NoteEditorForm
                body={body}
                onBodyChange={edit(setBody)}
                documentId={note.data.id}
                category={category}
                onCategoryChange={edit(setCategory)}
                categories={categories}
                onConfirm={close}
                confirmLabel={t.done}
                confirmKbd="⌘⏎"
              />
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
