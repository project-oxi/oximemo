/**
 * Memo detail + editor (§7.3). Opens (controlled by the `selectedId` UI state)
 * as a Base UI Dialog, loads the full note via `get_memo`, and debounces edits
 * into `update_memo` (500ms autosave). A pending edit is flushed on close so no
 * input is lost.
 */
import { Dialog } from "@base-ui-components/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Folder, Maximize2, Minimize2, Star } from "lucide-react";

import { deleteMemo, getMemo, updateMemo, listFolders } from "../lib/api";
import { colorForFolder, paperFor } from "../lib/color";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";
import { BacklinksPanel } from "./BacklinksPanel";
import { BrainPanel } from "./BrainPanel";
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
  const [immersive, setImmersive] = useState(false);
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
      setImmersive(false);
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
    if (selectedId && selectedId === draftId && !body.trim()) {
      void deleteMemo(selectedId)
        .then(() => qc.invalidateQueries({ queryKey: ["memos"] }))
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
  const popupSize = immersive
    ? "h-[94vh] w-[min(900px,96vw)] p-6"
    : "h-[80vh] w-[min(640px,92vw)] p-5";

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" />
        <Dialog.Popup
          className={`fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-line bg-surface-raised shadow-2xl ${popupSize}`}
        >
          <div className="flex h-full flex-col">
            <Dialog.Title className="sr-only">{t.done}</Dialog.Title>
            <div className="mb-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => folderPickerRef.current?.open()}
                className="inline-flex items-center gap-1 rounded-md bg-surface-muted px-2 py-1 text-xs text-text-subtle hover:bg-surface-raised"
                title={folder || "(root)"}
              >
                <Folder size={12} />
                {folder || "(root)"}
              </button>
              <button
                type="button"
                onClick={() => edit(setFavorite)(!favorite)}
                aria-label={favorite ? t.action_unfavorite : t.action_favorite}
                className={`ml-auto rounded-md p-1.5 ${
                  favorite ? "text-hue-amber" : "text-text-subtle hover:text-hue-amber"
                }`}
              >
                <Star size={14} className={favorite ? "fill-hue-amber" : undefined} />
              </button>
              <button
                type="button"
                onClick={() => setImmersive((v) => !v)}
                className="rounded-md p-1.5 text-text-subtle hover:bg-surface-muted hover:text-text"
                aria-label={immersive ? "Exit immersive" : "Enter immersive"}
              >
                {immersive ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
              <button
                type="button"
                onClick={close}
                className="rounded-md bg-interactive-primary px-3 py-1.5 text-xs font-medium text-interactive-primary-foreground"
              >
                {t.done}
              </button>
            </div>
            {folder && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 -z-10"
                style={{ backgroundColor: paperFor(colorForFolder(folder)) }}
              />
            )}
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
                onConfirm={close}
                confirmLabel={t.done}
                confirmKbd="⌘⏎"
                folderPickerRef={folderPickerRef}
                immersive={immersive}
              />
            )}
            {!immersive && memo.data && seededId === memo.data.id && (
              <>
                <BacklinksPanel noteId={memo.data.id} />
                <BrainPanel
                  noteId={memo.data.id}
                  title={memo.data.title}
                  tags={memo.data.tags}
                />
              </>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}