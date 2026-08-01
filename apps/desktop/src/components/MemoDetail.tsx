/**
 * Memo detail + editor (§7.3). Opens (controlled by the `selectedId` UI state)
 * as a Base UI Dialog, loads the full note via `get_note`, and debounces edits
 * into `update_note` (500ms autosave). A pending edit is flushed on close so no
 * input is lost.
 */
import { Dialog } from "@base-ui-components/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Star } from "lucide-react";

import { deleteMemo, getMemo, updateMemo, listCategories } from "../lib/api";
import { colorForCategory, paperFor } from "../lib/color";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";
import { MemoEditorForm } from "./MemoEditorForm";
import type { CategoryComboboxHandle } from "./CategoryCombobox";
import type { CategoryDef } from "../lib/types";

export function MemoDetail() {
  const { t } = useI18n();
  const selectedId = useUI((s) => s.selectedId);
  const select = useUI((s) => s.select);
  const setError = useUI((s) => s.setError);
  const draftId = useUI((s) => s.draftId);
  const setDraftId = useUI((s) => s.setDraftId);
  const open = selectedId !== null;
  const qc = useQueryClient();

  const memo = useQuery({
    queryKey: ["memo", selectedId],
    queryFn: () => getMemo(selectedId!),
    enabled: open,
  });

  const [body, setBody] = useState("");
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<CategoryDef[]>([]);
  const [favorite, setFavorite] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [seededId, setSeededId] = useState<string | null>(null);
  const [immersive, setImmersive] = useState(false);
  const categoryPickerRef = useRef<CategoryComboboxHandle>(null);

  useEffect(() => {
    listCategories().then(setCategories).catch(() => {});
  }, []);

  // Seed the draft exactly once per loaded memo; reset when the dialog closes.
  useEffect(() => {
    if (open && memo.data && seededId !== memo.data.id) {
      setBody(memo.data.body);
      setCategory(memo.data.category);
      setFavorite(memo.data.favorite);
      setDirty(false);
      setSeededId(memo.data.id);
      setImmersive(false);
    }
    if (!open && seededId !== null) setSeededId(null);
  }, [open, memo.data, seededId]);

  // Debounced autosave (§7.3, 500ms).
  useEffect(() => {
    if (!dirty || !selectedId) return;
    const h = window.setTimeout(() => {
      void updateMemo(selectedId, body, favorite, category)
        .then((n) => {
          qc.setQueryData(["memo", selectedId], n);
          setDirty(false);
          qc.invalidateQueries({ queryKey: ["memos"] });
          qc.invalidateQueries({ queryKey: ["facets"] });
        })
        .catch((e) => {
          setError(String(e).split("\n")[0]);
          // Leave dirty=true so the next change or a manual retry attempts
          // the save again; the user can also close to flush.
        });
    }, 500);
    return () => window.clearTimeout(h);
  }, [dirty, body, favorite, category, selectedId, qc]);

  const close = () => {
    // A note minted by "new memo" this session is discarded while still
    // empty, so cancelled drafts don't accumulate as orphan files.
    if (selectedId && selectedId === draftId && !body.trim()) {
      void deleteMemo(selectedId)
        .then(() => qc.invalidateQueries({ queryKey: ["memos"] }))
        .catch((e) => setError(String(e).split("\n")[0]));
      setDraftId(null);
      select(null);
      return;
    }
    // Flush a pending edit before dismissing.
    if (dirty && selectedId) {
      void updateMemo(selectedId, body, favorite, category)
        .then((n) => {
          qc.setQueryData(["memo", selectedId], n);
          qc.invalidateQueries({ queryKey: ["memos"] });
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
  const popupSize = immersive
    ? "max-h-[94vh] w-[min(900px,96vw)] p-6"
    : "max-h-[80vh] w-[min(640px,92vw)] p-5";

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" />
        <Dialog.Popup
          onKeyDown={(e) => {
            const mod = e.metaKey || e.ctrlKey;
            if (mod && e.key === "Enter") {
              e.preventDefault();
              close();
            } else if (mod && e.key.toLowerCase() === "l") {
              e.preventDefault();
              categoryPickerRef.current?.open();
            } else if (mod && e.key === ".") {
              e.preventDefault();
              setImmersive((v) => !v);
            }
          }}
          className={`fixed left-1/2 top-1/2 z-50 isolate flex ${popupSize} -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900`}
        >
          {category && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 -z-10"
              style={{ backgroundColor: paperFor(colorForCategory(category, categories)) }}
            />
          )}
          {memo.isLoading || !memo.data || seededId !== memo.data.id ? (
            <div className="py-10 text-center text-sm text-zinc-400">…</div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-400">
                  {memo.data.id.slice(0, 8)}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => edit(setFavorite)(!favorite)}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] transition-colors ${
                      favorite
                        ? "bg-amber-100 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400"
                        : "text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                    }`}
                  >
                    <Star size={12} /> {t.favorite}
                  </button>
                  <button
                    type="button"
                    onClick={() => setImmersive((v) => !v)}
                    aria-label={immersive ? t.compact_mode : t.focus_mode}
                    title={`${immersive ? t.compact_mode : t.focus_mode} (⌘.)`}
                    className="rounded-full p-1.5 text-zinc-400 transition-colors hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                  >
                    {immersive ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                  </button>
                </div>
              </div>
              <MemoEditorForm
                body={body}
                onBodyChange={edit(setBody)}
                documentId={memo.data.id}
                category={category}
                onCategoryChange={edit(setCategory)}
                categories={categories}
                onConfirm={close}
                confirmLabel={t.done}
                confirmKbd="⌘⏎"
                categoryPickerRef={categoryPickerRef}
                immersive={immersive}
              />
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
