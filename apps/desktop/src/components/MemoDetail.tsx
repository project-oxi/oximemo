/**
 * Memo detail + editor (§7.3). Opens (controlled by the `selectedId` UI state)
 * as a Base UI Dialog, loads the full note via `get_memo`, and debounces edits
 * into `update_memo` (500ms autosave). A pending edit is flushed on close so no
 * input is lost.
 */
import { Dialog } from "@base-ui-components/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Folder, Star } from "lucide-react";

import { deleteMemo, getMemo, updateMemo, listFolders } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";
import { ContextDock } from "./ContextDock";
import { TagChipRow } from "./TagChipRow";
import { HtmlNoteEditor } from "./HtmlNoteEditor";
import { MemoEditorForm } from "./MemoEditorForm";
import type { FolderComboboxHandle } from "./FolderCombobox";
import type { FolderEntry } from "../lib/types";

export function MemoDetail() {
  const { t } = useI18n();
  const selectedId = useUI((s) => s.selectedId);
  const select = useUI((s) => s.select);
  const setError = useUI((s) => s.setError);
  const draftId = useUI((s) => s.draftId);
  const draftPristine = useUI((s) => s.draftPristine);
  const setDraftId = useUI((s) => s.setDraftId);
  const open = selectedId !== null;
  const qc = useQueryClient();

  const memo = useQuery({
    queryKey: ["memo", selectedId],
    queryFn: () => getMemo(selectedId!),
    enabled: open,
  });

  const [body, setBody] = useState("");
  const [folder, setFolder] = useState("");
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [favorite, setFavorite] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [seededId, setSeededId] = useState<string | null>(null);
  const folderPickerRef = useRef<FolderComboboxHandle>(null);

  useEffect(() => {
    listFolders().then(setFolders).catch(() => {});
  }, []);

  useEffect(() => {
    if (open && memo.data && seededId !== memo.data.id) {
      setBody(memo.data.body);
      setFolder(memo.data.folder);
      setFavorite(memo.data.favorite);
      setDirty(false);
      setSeededId(memo.data.id);
    }
    if (!open && seededId !== null) setSeededId(null);
  }, [open, memo.data, seededId]);

  useEffect(() => {
    if (!dirty || !selectedId) return;
    const h = window.setTimeout(() => {
      void updateMemo(selectedId, body, favorite)
        .then((n) => {
          qc.setQueryData(["memo", selectedId], n);
          setDirty(false);
          qc.invalidateQueries({ queryKey: ["memos"] });
          qc.invalidateQueries({ queryKey: ["facets"] });
        })
        .catch((e) => {
          setError(String(e).split("\n")[0]);
        });
    }, 500);
    return () => window.clearTimeout(h);
  }, [dirty, body, favorite, selectedId, qc]);

  const close = () => {
    // Discard a session-minted draft (new memo, fresh daily note) closed
    // while still pristine: blank, or exactly the body it was born with
    // (a daily note's template — the user typed nothing).
    if (selectedId && selectedId === draftId && (!body.trim() || body === (draftPristine ?? ""))) {
      void deleteMemo(selectedId)
        .then(() => {
          qc.invalidateQueries({ queryKey: ["memos"] });
          qc.invalidateQueries({ queryKey: ["folderChildren"] });
        })
        .catch((e) => setError(String(e).split("\n")[0]));
      setDraftId(null);
      select(null);
      return;
    }
    if (dirty && selectedId) {
      void updateMemo(selectedId, body, favorite)
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

  const closeRef = useRef(close);
  closeRef.current = close;

  // ⌘⏎ — the kbd hint shown on the Done button. Saves (close() flushes the
  // pending edit) and closes the dialog from any focus: editor, HTML mode,
  // or a toolbar control.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const edit = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setDirty(true);
  };
  const popupSize = "h-[80vh] w-[min(640px,92vw)] p-5";

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity duration-200 ease-out data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup
          className={`fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[var(--dialog-radius)] border border-line bg-surface-raised shadow-lg transition-[opacity,translate,scale] duration-200 ease-out data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 ${popupSize}`}
        >
          <div className="flex h-full flex-col">
            <Dialog.Title className="sr-only">{t.done}</Dialog.Title>
            <div className="mb-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => folderPickerRef.current?.open()}
                className="inline-flex items-center gap-1 rounded-[var(--tag-radius)] bg-surface-muted px-2 py-1 text-xs text-text-subtle transition-colors duration-150 hover:bg-surface hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                title={folder || t.folder_root}
              >
                <Folder size={12} />
                {folder || t.folder_root}
              </button>
              <button
                type="button"
                onClick={() => edit(setFavorite)(!favorite)}
                aria-label={favorite ? t.action_unfavorite : t.action_favorite}
                className={`ml-auto rounded-md p-1.5 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                  favorite ? "text-hue-amber hover:bg-surface-muted" : "text-text-subtle hover:bg-surface-muted hover:text-hue-amber"
                }`}
              >
                <Star size={14} className={favorite ? "fill-hue-amber" : undefined} />
              </button>
              <button
                type="button"
                onClick={close}
                className="rounded-[var(--button-radius)] bg-interactive-primary px-3 py-1.5 text-xs font-medium text-interactive-primary-foreground transition-colors duration-150 hover:bg-interactive-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                {t.done}
              </button>
            </div>
            {memo.isLoading || !memo.data || seededId !== memo.data.id ? (
              <div className="flex h-full items-center justify-center text-text-subtle">…</div>
            ) : memo.data.format === "html" ? (
              <div className="flex min-h-0 flex-1 flex-col gap-2.5">
                <HtmlNoteEditor
                  documentId={memo.data.id}
                  body={body}
                  onChange={edit(setBody)}
                />
                <TagChipRow body={body} />
              </div>
            ) : (
              <MemoEditorForm
                documentId={memo.data.id}
                folder={folder}
                onFolderChange={edit(setFolder)}
                folders={folders}
                body={body}
                onBodyChange={edit(setBody)}
                folderPickerRef={folderPickerRef}
              />
            )}
            {memo.data && seededId === memo.data.id && (
              <ContextDock
                noteId={memo.data.id}
                title={memo.data.title}
                tags={memo.data.tags}
                dirty={dirty}
              />
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}