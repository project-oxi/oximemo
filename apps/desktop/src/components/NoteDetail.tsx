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

import { getNote, updateNote } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";
import { ColorPicker } from "./ColorPicker";
import { TagInput } from "./TagInput";

export function NoteDetail() {
  const { t } = useI18n();
  const selectedId = useUI((s) => s.selectedId);
  const select = useUI((s) => s.select);
  const open = selectedId !== null;
  const qc = useQueryClient();

  const note = useQuery({
    queryKey: ["note", selectedId],
    queryFn: () => getNote(selectedId!),
    enabled: open,
  });

  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [color, setColor] = useState("");
  const [pinned, setPinned] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [seededId, setSeededId] = useState<string | null>(null);

  // Seed the draft exactly once per loaded note; reset when the dialog closes.
  useEffect(() => {
    if (open && note.data && seededId !== note.data.id) {
      setBody(note.data.body);
      setTags(note.data.tags);
      setColor(note.data.color);
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
      void updateNote(selectedId, body, tags, pinned, color).then((n) => {
        qc.setQueryData(["note", selectedId], n);
        setDirty(false);
      });
    }, 500);
    return () => window.clearTimeout(h);
  }, [dirty, body, tags, pinned, color, selectedId]);

  const close = () => {
    // Flush a pending edit before dismissing.
    if (dirty && selectedId) {
      void updateNote(selectedId, body, tags, pinned, color).then((n) =>
        qc.setQueryData(["note", selectedId], n),
      );
    }
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
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[min(640px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-hidden rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
          {note.isLoading || !note.data ? (
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
              <textarea
                value={body}
                onChange={(e) => edit(setBody)(e.target.value)}
                autoFocus
                className="min-h-[160px] flex-1 resize-none bg-transparent text-sm leading-relaxed text-zinc-800 focus:outline-none dark:text-zinc-100"
              />
              <div className="flex flex-col gap-3">
                <TagInput tags={tags} onChange={edit(setTags)} placeholder="tag…" />
                <ColorPicker value={color} onChange={edit(setColor)} />
              </div>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
