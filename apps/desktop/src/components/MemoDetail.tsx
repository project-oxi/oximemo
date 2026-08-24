/**
 * Memo detail + editor (§7.3). Opens (controlled by the `selectedId` UI state)
 * as a Base UI Dialog, loads the full note via `get_memo`, and debounces edits
 * into `update_memo` (500ms autosave). A pending edit is flushed on close so no
 * input is lost.
 */
import { Dialog } from "@base-ui-components/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Folder, Star } from "lucide-react";

import {
  deleteMemo,
  getMemo,
  getConfig,
  moveNote,
  openDailyNote,
  updateMemo,
  listFolders,
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useFolderNames } from "../lib/folders";
import { daysBetween, shiftISODate, todayLocalISO } from "../lib/dates";
import { useUI } from "../stores/ui";
import { ContextDock } from "./ContextDock";
import { HistoryPanel } from "./HistoryPanel";
import { PropertyPanel } from "./PropertyPanel";
import { HtmlNoteEditor } from "./HtmlNoteEditor";
import { TagChipRow } from "./TagChipRow";
import { MemoEditorForm } from "./MemoEditorForm";
import type { FolderComboboxHandle } from "./FolderCombobox";
import type { FolderEntry, Memo } from "../lib/types";

export function MemoDetail() {
  const { t } = useI18n();
  const displayFolder = useFolderNames().displayName;
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

  /** Folder changes apply immediately (move_note) — the picker is the
   *  note's real location, not a pending edit. Optimistic; rolls back on
   *  failure. Body/favorite keeps its debounced-save flow. */
  const applyFolder = (f: string) => {
    const prev = folder;
    setFolder(f);
    const id = memo.data?.id;
    if (!id || f === memo.data?.folder) return;
    void moveNote(id, f)
      .then(() => {
        qc.setQueryData<Memo | undefined>(["memo", id], (m) => (m ? { ...m, folder: f } : m));
        qc.invalidateQueries({ queryKey: ["memos"] });
        qc.invalidateQueries({ queryKey: ["folderChildren"] });
      })
      .catch((e) => {
        setFolder(prev);
        setError(String(e).split("\n")[0]);
      });
  };

  // Daily-note navigation (user prompt 2026-08-23): a note living at
  // `{daily.folder}/YYYY-MM-DD.*` is a journal entry — offer day arrows
  // and a relative-date chip. Arrows open (or mint, like the calendar)
  // the neighbouring day; "next" stops at today so arrows never create
  // future entries by accident.
  const configQ = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const dailyFolder = configQ.data?.daily?.folder || "daily";
  const dailyDate = useMemo(() => {
    const m = memo.data?.path?.match(
      new RegExp(`^${dailyFolder}/(\\d{4}-\\d{2}-\\d{2})\\.(md|html)$`),
    );
    return m?.[1] ?? null;
  }, [memo.data?.path, dailyFolder]);
  const today = todayLocalISO();
  const goDaily = (delta: number) => {
    if (!dailyDate) return;
    openDailyNote(shiftISODate(dailyDate, delta))
      .then(({ memo: m, created }) => {
        select(m.id);
        if (created) setDraftId(m.id, m.body);
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };
  const relLabel = (() => {
    if (!dailyDate) return null;
    const diff = daysBetween(today, dailyDate);
    if (diff === 0) return t.rel_today;
    if (diff === 1) return t.rel_yesterday;
    return diff > 1
      ? t.rel_days_ago.replace("{n}", String(diff))
      : t.rel_in_days.replace("{n}", String(-diff));
  })();

  const edit = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setDirty(true);
  };
  const popupSize = "h-[80vh] w-[min(880px,92vw)] p-5";

  // The copilot window (bottom-right, z-60) is usable WHILE a note is open
  // by design. A wider editor (880px cap) would meet it on laptop widths,
  // so nudge the dialog left just enough to keep 12px between them — but
  // never past a 12px left margin. On screens too narrow for both, the
  // copilot simply overlays the dialog edge (existing z-order contract).
  const copilotOpen = useUI((s) => s.copilotOpen);
  const [shift, setShift] = useState(0);
  useEffect(() => {
    if (!open) return;
    const recompute = () => {
      const vw = window.innerWidth;
      const copilot = copilotOpen ? Math.min(vw * 0.92, 380) + 24 + 12 : 0;
      const half = Math.min(vw * 0.92, 880) / 2;
      const need = half + copilot - vw / 2;
      const max = Math.max(vw / 2 - half - 12, 0);
      setShift(Math.max(0, Math.min(need, max)));
    };
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, [open, copilotOpen]);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity duration-200 ease-out data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup
          style={{ left: `calc(50% - ${shift}px)` }}
          className={`fixed top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[var(--dialog-radius)] border border-line bg-surface-raised shadow-lg transition-[opacity,translate,scale] duration-200 ease-out data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 ${popupSize}`}
        >
          <div className="flex h-full flex-col">
            <Dialog.Title className="sr-only">{t.done}</Dialog.Title>
            <div className="mb-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => folderPickerRef.current?.open()}
                className="inline-flex items-center gap-1 rounded-[var(--tag-radius)] bg-surface-muted px-2 py-1 text-xs text-text-subtle transition-colors duration-150 hover:bg-surface hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                title={folder ? displayFolder(folder) : t.folder_root}
              >
                <Folder size={12} />
                {folder ? displayFolder(folder) : t.folder_root}
              </button>
              {dailyDate && (
                <div className="flex items-center gap-0.5" data-daily-nav>
                  <button
                    type="button"
                    onClick={() => goDaily(-1)}
                    aria-label={t.daily_prev_day}
                    title={t.daily_prev_day}
                    className="rounded-[var(--button-radius)] p-1 text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    <ChevronLeft size={13} />
                  </button>
                  <span className="min-w-9 text-center text-[11px] text-text-subtle" data-daily-rel>
                    {relLabel}
                  </span>
                  <button
                    type="button"
                    onClick={() => goDaily(1)}
                    disabled={shiftISODate(dailyDate, 1) > today}
                    aria-label={t.daily_next_day}
                    title={t.daily_next_day}
                    className="rounded-[var(--button-radius)] p-1 text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <ChevronRight size={13} />
                  </button>
                </div>
              )}
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
            {memo.data && seededId === memo.data.id && (
              <PropertyPanel memo={memo.data} folder={folder || memo.data.folder} />
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
                onFolderChange={applyFolder}
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
            {memo.data && seededId === memo.data.id && memo.data.path && (
              <HistoryPanel path={memo.data.path} />
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}