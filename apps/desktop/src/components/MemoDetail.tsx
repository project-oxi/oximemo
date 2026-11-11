/**
 * Memo detail + editor (§7.3). Opens (controlled by the `selectedId` UI state)
 * as a Base UI Dialog, loads the full note via `get_memo`, and debounces edits
 * into `update_memo` after a short idle period. A pending edit is flushed on close so no
 * input is lost.
 */
import { Dialog } from "@base-ui-components/react";
import { Button, GPage, Skeleton } from "@garden/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { EditorView } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { BookOpenText, Bot, ChevronLeft, ChevronRight, Folder, Maximize2, Minimize2, PenLine, Star } from "lucide-react";

import {
  deleteMemo,
  copilotStatus,
  getMemo,
  getConfig,
  moveNote,
  openDailyNote,
  removeMemoMetadataTags,
  updateMemo,
  listFolders,
} from "../lib/api";
import { openOrCreateWikiTarget } from "../lib/memoLinks";
import { resolveEditorLink } from "../lib/editorLinks";
import { fragmentPosition } from "../lib/editorFragments";
import { isSaveAndCloseKey } from "../lib/editorKeys";
import { reconcileEditorSource } from "../lib/editorSource";
import { useWorkspaceMotion } from "../lib/workspaceMotion";
import { NO_MARGINS, marginLayout, sameMarginLayout, type MarginLayout } from "../lib/marginLayout";
import { aliasList } from "../lib/backlinkContext";
import { useI18n } from "../lib/i18n";
import { useFolderNames } from "../lib/folders";
import { daysBetween, shiftISODate, todayLocalISO } from "../lib/dates";
import { useUI } from "../stores/ui";
import { ContextDock } from "./ContextDock";
import { MarginSlot } from "./MarginLinks";
import { SaveRing } from "./SaveRing";
import { HistoryPanel } from "./HistoryPanel";
import { PropertyPanel } from "./PropertyPanel";
import { HtmlNoteEditor } from "./HtmlNoteEditor";
import { MemoEditorForm } from "./MemoEditorForm";
import { SuggestionStrip } from "./SuggestionStrip";
import { DigestButton } from "./DigestButton";
import { NoteCtxMenu } from "./NoteCtxMenu";
import { CtxRoot, CtxTrigger } from "./ContextMenu";
import { IconTool } from "./IconTool";
import { WordLookupPanel, WritingPanel } from "./WritingPanel";
import { PanelResizeHandle, readPanelWidth, writePanelWidth, WRITING_PANEL_WIDTH_KEY } from "./PanelResize";
import { isWritingTag, preservesPublishedChapters, readManuscript, writingProfile } from "../lib/writing";
import { writingRevisionUpdate } from "../lib/writingReview";
import type { WritingRevision } from "../lib/api";
import type { FolderComboboxHandle } from "./FolderCombobox";
import type { FolderEntry, Memo, MemoSummary } from "../lib/types";

const AUTOSAVE_IDLE_MS = 1200;

/** Writing inspector width bounds (px). EDITOR_RESERVE keeps the editor
 * column usable: the container-imposed ceiling tightens in narrow sheets. */
const WRITING_PANEL_MIN = 260;
const WRITING_PANEL_MAX = 520;
const WRITING_PANEL_DEFAULT = 300;
const EDITOR_RESERVE = 320;

/** Note-menu callbacks owned by the CardGrid scope (undo-toast delete,
 *  shared favorite/move/copy handlers). All optional: MemoDetail falls
 *  back to its own draft-aware actions until threaded (§3.2). */
export interface MemoDetailProps {
  onToggleFavorite?: (id: string, favorite: boolean) => void;
  onMoveFolder?: (id: string, folder: string) => void;
  onCopyBody?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export function MemoDetail({
  onToggleFavorite,
  onMoveFolder,
  onCopyBody,
  onDelete,
}: MemoDetailProps = {}) {
  const { t } = useI18n();
  const displayFolder = useFolderNames().displayName;
  const selectedId = useUI((s) => s.selectedId);
  const select = useUI((s) => s.select);
  const memoLayout = useUI((s) => s.memoLayout);
  const setMemoLayout = useUI((s) => s.setMemoLayout);
  const setError = useUI((s) => s.setError);
  const draftId = useUI((s) => s.draftId);
  const draftPristine = useUI((s) => s.draftPristine);
  const setDraftId = useUI((s) => s.setDraftId);
  const consumeTaskAnchor = useUI((s) => s.consumeTaskAnchor);
  const open = selectedId !== null;
  const qc = useQueryClient();

  const memo = useQuery({
    queryKey: ["memo", selectedId],
    queryFn: () => getMemo(selectedId!),
    enabled: open,
    refetchOnWindowFocus: false,
  });

  const [body, setBody] = useState("");
  const [folder, setFolder] = useState("");
  const foldersQ = useQuery({ queryKey: ["folders"], queryFn: listFolders });
  const folders: FolderEntry[] = foldersQ.data ?? [];
  const [favorite, setFavorite] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [seededId, setSeededId] = useState<string | null>(null);
  const sourceSnapshotRef = useRef<Memo | null>(null);
  const pendingWritingSource = useRef<{ id: string; editorSource: string; source: string } | null>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const folderPickerRef = useRef<FolderComboboxHandle>(null);
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [pendingFragment, setPendingFragment] = useState<{ id: string; value: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [editorToolsTarget, setEditorToolsTarget] = useState<HTMLDivElement | null>(null);
  const writingEnabled = useUI((s) => s.writingTools);
  const [inspector, setInspector] = useState<{ id: string; kind: "words" | "writing"; word?: string } | null>(null);
  const writingButtonRef = useRef<HTMLButtonElement>(null);
  const wordsButtonRef = useRef<HTMLButtonElement>(null);
  const [reviewSource, setReviewSource] = useState<{ id: string; body: string } | null>(null);
  const currentNote = open && memo.data?.id === selectedId && seededId === selectedId ? memo.data : null;
  const reviewId = writingEnabled && currentNote?.format === "markdown" ? currentNote.id : null;
  useEffect(() => {
    if (!reviewId) return;
    const timer = window.setTimeout(() => setReviewSource({ id: reviewId, body }), 650);
    return () => window.clearTimeout(timer);
  }, [reviewId, body]);
  useEffect(() => {
    setInspector(null);
    setReviewSource(null);
  }, [selectedId]);
  const reviewBody = reviewId && reviewSource?.id === reviewId ? reviewSource.body : null;
  const profile = useMemo(() => reviewBody === null || !currentNote
    ? null : writingProfile(reviewBody, currentNote.source_sha256 ? currentNote.tags : []), [reviewBody, currentNote]);
  const manuscript = useMemo(() => profile && reviewBody !== null ? readManuscript(reviewBody) : null, [profile, reviewBody]);
  const activeInspector = currentNote && inspector?.id === currentNote.id &&
    (inspector.kind === "words" || profile) ? inspector : null;
  const reviewUpdating = reviewBody !== body;
  // Persisted side-by-side inspector width (260..520, container-clamped).
  // Only the ≥700px container layout has a width column — below it the
  // stacked panel ignores the variable, so the value just waits.
  const [writingPanelWidth, setWritingPanelWidth] = useState(() =>
    readPanelWidth(WRITING_PANEL_WIDTH_KEY, WRITING_PANEL_MIN, WRITING_PANEL_MAX, WRITING_PANEL_DEFAULT),
  );
  const [writingPanelMax, setWritingPanelMax] = useState(WRITING_PANEL_MAX);
  const visibleWritingPanelWidth = Math.min(writingPanelWidth, writingPanelMax);
  const writingWorkspaceRef = useRef<HTMLDivElement>(null);
  /** Container-imposed ceiling: the editor column keeps ≥ EDITOR_RESERVE px. */
  const measurePanelMax = useCallback(() => {
    const workspace = writingWorkspaceRef.current;
    const width = workspace ? workspace.clientWidth : window.innerWidth;
    return Math.min(WRITING_PANEL_MAX, Math.max(WRITING_PANEL_MIN, width - EDITOR_RESERVE));
  }, []);
  // Keep a saved width from squeezing the editor on narrow sheets/windows
  // (visual clamp only — the stored preference survives re-widening).
  useLayoutEffect(() => {
    const workspace = writingWorkspaceRef.current;
    if (!workspace) return;
    const updateLimit = () => setWritingPanelMax(measurePanelMax());
    updateLimit();
    const observer = new ResizeObserver(updateLimit);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [measurePanelMax, open, activeInspector?.id]);

  useEffect(() => {
    if (!open) {
      sourceSnapshotRef.current = null;
      if (seededId !== null) setSeededId(null);
      return;
    }
    const source = reconcileEditorSource(
      sourceSnapshotRef.current, memo.data, selectedId,
      dirtyRef.current, saveInFlight.current !== null,
    );
    if (!source || source === sourceSnapshotRef.current) return;
    if (seededId === source.id && bodyRef.current !== source.body) {
      // Atomic's Markdown source is mount-only. Refresh an untouched editor
      // without stealing focus from the Copilot composer or retaining old undo.
      setEditorAutoFocus(editorView?.hasFocus ?? false);
      setEditorRevision((revision) => revision + 1);
    } else if (seededId !== source.id) {
      setEditorAutoFocus(true);
    }
    sourceSnapshotRef.current = source;
    setBody(source.body);
    bodyRef.current = source.body;
    setFolder(source.folder);
    setFavorite(source.favorite);
    favoriteRef.current = source.favorite;
    setDirty(false);
    dirtyRef.current = false;
    setSaveBlocked(false);
    setSaveProblem(null);
    setSeededId(source.id);
  }, [open, memo.data, selectedId, seededId, dirty, saving, editorView]);
  // Properties + content share one scroll container now; switching notes
  // must start reading at the top, not where the previous note ended.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [selectedId]);
  // Consume the pending task anchor as soon as the editor remounts for the
  // target memo: MemoEditorForm captures the CM6 view on its mount (via
  // `onEditorView`) and posts it here; once we have BOTH the view AND a
  // matching anchor in the store, we dispatch a scroll-into-center +
  // selection so the task line is visible. The mismatch guard lives in
  // `consumeTaskAnchor` itself: a memo opened for some other reason
  // cannot steal a still-pending task anchor.
  useEffect(() => {
    if (!editorView || !selectedId) return;
    const line = consumeTaskAnchor(selectedId);
    if (line === null) return;
    const doc = editorView.state.doc;
    if (line < 0 || line >= doc.lines) {
      // Out-of-range result from a stale or truncated body: leave the
      // cursor at the document head and stop. This is rare in practice
      // (resolve_task_line validates bounds server-side too) but a
      // crash here would be worse than a missed scroll.
      return;
    }
    const pos = doc.line(line + 1).from;
    editorView.focus();
    editorView.dispatch({
      selection: { anchor: pos, head: pos },
    });
    // Document-flow editor (single-scroll refactor): CM's own scrollDOM
    // has no overflow, so center the target line in the note scroller
    // ourselves instead of relying on scrollIntoView effects.
    const scroller = editorView.scrollDOM.closest<HTMLElement>("[data-memo-scroll]");
    const coords = editorView.coordsAtPos(pos);
    if (!scroller || !coords) return;
    const box = scroller.getBoundingClientRect();
    scroller.scrollTo({
      top:
        scroller.scrollTop +
        (coords.top - box.top) -
        box.height / 2 +
        (coords.bottom - coords.top) / 2,
    });
  }, [editorView, selectedId, memo.data?.body, consumeTaskAnchor]);
  useEffect(() => {
    if (!editorView || !pendingFragment || selectedId !== pendingFragment.id || seededId !== selectedId) return;
    const pos = fragmentPosition(editorView.state.doc, pendingFragment.value);
    setPendingFragment(null);
    if (pos === null) return;
    editorView.dispatch({ selection: { anchor: pos } });
    editorView.focus();
    const scroller = editorView.scrollDOM.closest<HTMLElement>("[data-memo-scroll]");
    const coords = editorView.coordsAtPos(pos);
    if (scroller && coords) {
      const box = scroller.getBoundingClientRect();
      scroller.scrollTo({ top: scroller.scrollTop + coords.top - box.top - box.height / 3 });
    }
  }, [editorView, pendingFragment, selectedId, seededId]);

  // One save at a time: a Done click joins the autosave rather than sending
  // two writes against the same source digest. Edits made during a save
  // stay dirty and are flushed against the receipt's new digest.
  const saveInFlight = useRef<Promise<void> | null>(null);
  const navigationInFlight = useRef(false);
  const openWikiLinkRef = useRef<(target: string) => void>(() => {});
  const onWikiLinkOpen = useCallback((target: string) => openWikiLinkRef.current(target), []);
  const navigateRef = useRef<(id: string, fragment?: string | null) => void>(() => {});
  const onNavigateMemo = useCallback((id: string, fragment?: string | null) => navigateRef.current(id, fragment), []);
  const openDocumentLinkRef = useRef<(url: string) => void>(() => {});
  const onDocumentLinkOpen = useCallback((url: string) => openDocumentLinkRef.current(url), []);
  const editVersion = useRef(0);
  const lastEditAt = useRef(0);
  const dirtyRef = useRef(dirty);
  const bodyRef = useRef(body);
  const favoriteRef = useRef(favorite);
  favoriteRef.current = favorite;
  const [saveBlocked, setSaveBlocked] = useState(false);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [editorRevision, setEditorRevision] = useState(0);
  const [editorAutoFocus, setEditorAutoFocus] = useState(true);
  // Base UI's default initial focus is the first tabbable element — the
  // header's folder button. Its rAF landed one frame after the editor's own
  // autofocus, so ⌘N/CtrlN opened a note with the caret parked on that
  // button. Aim at the body editor when it is already mounted; otherwise
  // the sheet itself, and the editor's later autofocus wins (2026.11.04).
  const popupRef = useRef<HTMLDivElement | null>(null);
  const initialFocus = useCallback(
    () => popupRef.current?.querySelector<HTMLElement>("[data-memo-scroll] .cm-content") ?? popupRef.current,
    [],
  );
  const reportSaveError = (error: unknown) => {
    setSaveBlocked(true);
    const message = String(error);
    const readable = message.includes("external_change_conflict") ? t.save_conflict : message.split("\n")[0];
    setSaveProblem(readable);
    setError(readable);
  };

  const savePending = async () => {
    while (saveInFlight.current) await saveInFlight.current;
    if (!dirtyRef.current || !selectedId) return;
    const id = selectedId;
    const version = editVersion.current;
    // A background refetch may already contain someone else's newer digest.
    // Save against the snapshot displayed when this draft began instead.
    const source = sourceSnapshotRef.current;
    if (!source || source.id !== id) throw new Error(t.save_conflict);
    setSaving(true);
    const favoritePatch = favoriteRef.current === source.favorite ? null : favoriteRef.current;
    const pending = updateMemo(id, bodyRef.current, favoritePatch, null, source.source_sha256)
      .then((n) => {
        qc.setQueryData(["memo", id], n);
        if (selectedIdRef.current === id) {
          sourceSnapshotRef.current = n;
          if (editVersion.current === version) {
            dirtyRef.current = false;
            setDirty(false);
          }
        }
        void qc.invalidateQueries({ queryKey: ["memos"] });
        void qc.invalidateQueries({ queryKey: ["facets"] });
      });
    saveInFlight.current = pending;
    try { await pending; }
    finally { saveInFlight.current = null; setSaving(false); }
  };

  const guardedNavigation = (work: () => Promise<void>) => {
    if (navigationInFlight.current) return;
    navigationInFlight.current = true;
    void (async () => {
      try {
        while (dirtyRef.current || saveInFlight.current) await savePending();
        await work();
      } catch (error) {
        setError(String(error).split("\n")[0]);
      } finally {
        navigationInFlight.current = false;
      }
    })();
  };

  navigateRef.current = (id, fragment) => guardedNavigation(async () => {
    if (fragment) setPendingFragment({ id, value: fragment });
    select(id);
  });

  openDocumentLinkRef.current = (url) => guardedNavigation(async () => {
    const target = await resolveEditorLink(url, memo.data?.path ?? "");
    if (target.kind === "external") {
      window.open(target.url, "_blank", "noopener,noreferrer");
    } else if (target.kind === "memo") {
      if (target.fragment) setPendingFragment({ id: target.id, value: target.fragment });
      select(target.id);
    } else {
      select(null);
      useUI.getState().openPdcPath(target.path);
    }
  });

  openWikiLinkRef.current = (target: string) => guardedNavigation(async () => {
        if (target.startsWith("#") && selectedId) {
          setPendingFragment({ id: selectedId, value: target.slice(1) });
          return;
        }
        const { memo: destination, created } = await openOrCreateWikiTarget(target, folder);
        qc.setQueryData(["memo", destination.id], destination);
        if (created) {
          void qc.invalidateQueries({ queryKey: ["memos"] });
          void qc.invalidateQueries({ queryKey: ["folderChildren"] });
        }
        const fragment = target.includes("#") ? target.slice(target.indexOf("#") + 1) : null;
        if (fragment) setPendingFragment({ id: destination.id, value: fragment });
        select(destination.id);
  });

  const reloadAfterCopy = async () => {
    if (!selectedId) return;
    const id = selectedId;
    try {
      await navigator.clipboard.writeText(bodyRef.current);
      const latest = await getMemo(id);
      qc.setQueryData(["memo", id], latest);
      if (selectedIdRef.current !== id) return;
      sourceSnapshotRef.current = latest;
      setBody(latest.body);
      bodyRef.current = latest.body;
      setFavorite(latest.favorite);
      favoriteRef.current = latest.favorite;
      setFolder(latest.folder);
      editVersion.current += 1;
      dirtyRef.current = false;
      setDirty(false);
      setSaveBlocked(false);
      setSaveProblem(null);
      setEditorRevision((revision) => revision + 1);
    } catch (error) { reportSaveError(error); }
  };

  useEffect(() => {
    if (!dirty || !selectedId || saving || saveBlocked) return;
    let h: number;
    const flushAfterIdle = () => {
      const remaining = AUTOSAVE_IDLE_MS - (Date.now() - lastEditAt.current);
      if (remaining > 0) {
        h = window.setTimeout(flushAfterIdle, remaining);
        return;
      }
      void savePending().catch(reportSaveError);
    };
    h = window.setTimeout(flushAfterIdle, AUTOSAVE_IDLE_MS);
    return () => window.clearTimeout(h);
  }, [dirty, body, favorite, selectedId, saving, saveBlocked, qc]);

  const close = async () => {
    if (selectedId && selectedId === draftId && (!bodyRef.current.trim() || bodyRef.current === (draftPristine ?? ""))) {
      try {
        if (saveInFlight.current) await saveInFlight.current;
        await deleteMemo(selectedId);
        void qc.invalidateQueries({ queryKey: ["memos"] });
        void qc.invalidateQueries({ queryKey: ["folderChildren"] });
      } catch (e) { setError(String(e).split("\n")[0]); return; }
      setDraftId(null);
      select(null);
      return;
    }
    try {
      while (dirtyRef.current || saveInFlight.current) await savePending();
    } catch (e) {
      reportSaveError(e);
      return; // Keep unsaved text open on conflict or I/O failure.
    }
    if (selectedId && selectedId === draftId) {
      setDraftId(null);
      useUI.getState().markFresh(selectedId);
    }
    select(null);
  };

  const closeRef = useRef(close);
  closeRef.current = close;
  const finishFromEditor = useCallback(() => { void closeRef.current(); }, []);

  // ⌘⏎ — the kbd hint shown on the Done button. Saves (close() flushes the
  // pending edit) and closes the dialog from any focus: editor, HTML mode,
  // or a toolbar control.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // !shiftKey (tasks spec §7.1 required cutover): ⌘⇧Enter belongs
      // to the CM6 task-widget toggle keymap, so the document-level
      // save-and-close listener must not also swallow it.
      if (isSaveAndCloseKey(e)) {
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
    void (async () => {
      while (dirtyRef.current || saveInFlight.current) await savePending();
      return moveNote(id, f);
    })()
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

  // Header right-click (§3.2): the open note reuses NoteCtxMenu so every
  // note surface offers the same actions. Favorite/move/copy act on the
  // open draft directly; delete prefers the CardGrid-owned handler (undo
  // toast) when threaded, otherwise deletes and closes inline.
  const menuSummary: MemoSummary | null = memo.data
    ? { ...memo.data, preview: "", deleted: false }
    : null;
  const onMenuToggleFavorite = (id: string, next: boolean) => {
    if (id !== memo.data?.id) return;
    if (onToggleFavorite) { onToggleFavorite(id, next); return; }
    edit(setFavorite)(next);
  };
  const onMenuMoveFolder = (id: string, f: string) => {
    if (id !== memo.data?.id) return;
    if (onMoveFolder) { onMoveFolder(id, f); return; }
    applyFolder(f);
  };
  const onMenuCopyBody = (id: string) => {
    if (onCopyBody) { onCopyBody(id); return; }
    void navigator.clipboard.writeText(bodyRef.current).catch((e) => setError(String(e).split("\n")[0]));
  };
  const onMenuDelete = (id: string) => {
    if (onDelete) { onDelete(id); return; }
    void (async () => {
      try {
        await deleteMemo(id);
        void qc.invalidateQueries({ queryKey: ["memos"] });
        void qc.invalidateQueries({ queryKey: ["folderChildren"] });
        select(null);
      } catch (e) {
        setError(String(e).split("\n")[0]);
      }
    })();
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
    void (async () => {
      while (dirtyRef.current || saveInFlight.current) await savePending();
      return openDailyNote(shiftISODate(dailyDate, delta));
    })()
      .then(({ memo: m, created }) => {
        qc.setQueryData(["memo", m.id], m);
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
    setSaveBlocked(false);
    setSaveProblem(null);
    editVersion.current += 1;
    lastEditAt.current = Date.now();
    dirtyRef.current = true;
    setDirty(true);
  };
  const editBody = (value: string) => {
    // CodeMirror already contains the new text. Keep the save snapshot
    // synchronous, then let React render tags and surrounding panels later.
    const pending = pendingWritingSource.current;
    pendingWritingSource.current = null;
    if (pending?.id === selectedIdRef.current && value === pending.editorSource) value = pending.source;
    bodyRef.current = value;
    editVersion.current += 1;
    lastEditAt.current = Date.now();
    dirtyRef.current = true;
    setSaveBlocked(false);
    setSaveProblem(null);
    setDirty(true);
    const editingId = selectedId;
    startTransition(() => {
      setBody((current) => selectedIdRef.current === editingId ? value : current);
    });
  };
  // AI applies (suggestion chips, digest insert) must write through the
  // editor, not around it: editBody only syncs the draft state because it
  // assumes CodeMirror already holds the text. A state-only write here
  // desyncs the view, and the next keystroke would silently overwrite the
  // applied suggestion. One whole-doc dispatch keeps a single undo step
  // and flows through the editor's own editBody listener.
  const applyBodyEdit = (next: string) => {
    const view = editorView;
    if (!view) {
      editBody(next);
      return;
    }
    const current = view.state.doc.toString();
    if (next === current) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: next },
      scrollIntoView: true,
    });
  };
  // CSS positions the reading sheet beside Copilot when the viewport fits
  // both; at narrow widths the established overlay ordering remains.
  const copilotOpen = useUI((s) => s.copilotOpen);
  const frameTiming = useWorkspaceMotion();
  const [frameMotion, setFrameMotion] = useState(false);
  const previousFrame = useRef({ memoLayout, copilotOpen });
  // Only user layout changes animate geometry. A viewport resize must fit
  // immediately, including if it interrupts an expansion already in flight.
  useLayoutEffect(() => {
    const changed = previousFrame.current.memoLayout !== memoLayout || previousFrame.current.copilotOpen !== copilotOpen;
    previousFrame.current = { memoLayout, copilotOpen };
    if (!open || frameTiming.reduce) {
      setFrameMotion(false);
      return;
    }
    if (!changed) return;
    setFrameMotion(true);
    const settle = () => {
      setFrameMotion(false);
      window.removeEventListener("resize", settle);
    };
    const timeout = window.setTimeout(settle, frameTiming.move.duration * 1000);
    window.addEventListener("resize", settle);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("resize", settle);
    };
  }, [memoLayout, copilotOpen, open, frameTiming.reduce, frameTiming.move.duration]);
  const setCopilotOpen = useUI((s) => s.setCopilotOpen);
  const copilot = useQuery({ queryKey: ["copilot-status"], queryFn: copilotStatus });
  const copilotVisible = (copilot.data?.enabled ?? false) && (copilot.data?.activated ?? false);
  // Suggestion auto-trigger (goal 2026-10-25): an explicit opt-in toggle
  // (default false) AND an activated agent — note text leaving for the
  // provider must never happen silently.
  const autoSuggest = copilotVisible && configQ.data?.copilot?.suggest_after_save === true;

  // Margin links (2026-11-11 «MarginLinks»): immersive 마크다운 본문의 양옆 여백에
  // 연결을 놓는다. 창이 아니라 스크롤 틀의 내용 폭을 잰다 — 코파일럿 padding 이 여백을
  // 줄이기 때문이다. 프레임이 펼쳐지는 동안은 재지 않는다(폭이 매 프레임 바뀌어 여백이 깜박인다).
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const attachScroll = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []);
  const [margins, setMargins] = useState<MarginLayout>(NO_MARGINS);
  const [marginLeftEl, setMarginLeftEl] = useState<HTMLElement | null>(null);
  const [marginRightEl, setMarginRightEl] = useState<HTMLElement | null>(null);
  // 글쓰기 점검 패널이 열려 있으면 여백을 끈다 — 패널이 옆자리를 차지해 연결 여백과 겹쳐 읽힌다.
  const marginsActive = memoLayout === "immersive" && !frameMotion && memo.data?.format === "markdown" && !activeInspector;
  useLayoutEffect(() => {
    if (!scrollEl || !marginsActive) {
      setMargins(NO_MARGINS);
      return;
    }
    const measure = () => {
      const cs = getComputedStyle(scrollEl);
      const next = marginLayout({
        outerWidth: scrollEl.offsetWidth,
        clientWidth: scrollEl.clientWidth,
        padLeft: parseFloat(cs.paddingLeft) || 0,
        padRight: parseFloat(cs.paddingRight) || 0,
        readingWidth: parseFloat(cs.getPropertyValue("--memo-reading-width")) || 760,
      });
      setMargins((prev) => (sameMarginLayout(prev, next) ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scrollEl);
    return () => observer.disconnect();
  }, [scrollEl, marginsActive]);
  // 여백 위에서 굴린 휠은 본문으로 넘긴다 — 여백 상자는 스크롤 틀의 형제라 그냥 두면 휠이 멎는다.
  const forwardMarginWheel = useCallback((e: React.WheelEvent<HTMLElement>) => {
    const box = e.currentTarget;
    if (box.scrollHeight <= box.clientHeight) scrollRef.current?.scrollBy({ top: e.deltaY });
  }, []);
  const memoProps = memo.data?.props;
  const aliases = useMemo(() => aliasList(memoProps?.aliases), [memoProps]);

  const closeInspector = () => {
    const trigger = activeInspector?.kind === "words" ? wordsButtonRef : writingButtonRef;
    setInspector(null);
    trigger.current?.focus();
  };
  const toggleInspector = (kind: "words" | "writing") => {
    if (!currentNote) return;
    if (activeInspector?.kind === kind) {
      closeInspector();
      return;
    }
    const selection = editorView
      ? editorView.state.sliceDoc(editorView.state.selection.main.from, editorView.state.selection.main.to)
      : window.getSelection()?.toString() ?? "";
    setInspector({ id: currentNote.id, kind, word: selection.trim().length <= 40 ? selection.trim().replace(/\s+/gu, " ") : "" });
  };
  const jumpToWritingLine = (line: number) => {
    if (!editorView || !currentNote || editorView.state.doc.toString() !== reviewBody?.replace(/\r\n?/g, "\n")) {
      setError(t.writing_stale);
      return;
    }
    const pos = editorView.state.doc.line(Math.min(line, editorView.state.doc.lines)).from;
    editorView.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    editorView.focus();
  };
  const insertPlanning = (action: { kind: "scenario" } | { kind: "character"; name: string }): boolean => {
    if (!editorView || !currentNote) return false;
    const doc = editorView.state.doc;
    const current = readManuscript(doc.toString());
    if (current.unclosedComment) {
      setError(t.writing_unclosed_comment);
      return false;
    }
    const planning = current.planning;
    const isCharacter = action.kind === "character";
    const section = isCharacter ? current.characterSection : current.scenario;
    if (!isCharacter && section) return false;
    const insertionLine = (isCharacter ? current.characterSection?.endLine : undefined) ?? planning?.endLine;
    const from = insertionLine ? doc.line(insertionLine).from : doc.length;
    const heading = [
      !planning && `## ${t.writing_notes_heading}`,
      !section && `### ${isCharacter ? t.writing_characters : t.writing_scenario}`,
    ].filter(Boolean);
    if (isCharacter) heading.push(`#### ${action.name.replace(/[\\`*_{}\[\]()#+!<>|%]/g, "\\$&")}`);
    const fields = isCharacter ? t.writing_character_fields : t.writing_scenario_fields;
    const previous = doc.sliceString(Math.max(0, from - 2), from);
    const prefix = !from || previous.endsWith("\n\n") ? "" : previous.endsWith("\n") ? "\n" : "\n\n";
    const block = prefix + heading.join("\n\n") + "\n\n";
    const caret = from + block.length + fields.indexOf("\n");
    const insert = block + fields + (from < doc.length ? "\n\n" : "\n");
    const candidate = readManuscript(doc.sliceString(0, from) + insert + doc.sliceString(from));
    const recognized = isCharacter ? candidate.characters.length === current.characters.length + 1 : !!candidate.scenario;
    if (!recognized || !preservesPublishedChapters(current, candidate)) {
      setError(t.writing_planning_blocked);
      return false;
    }
    editorView.dispatch({
      changes: { from, insert },
      selection: { anchor: caret },
      effects: EditorView.scrollIntoView(caret, { y: "center" }),
    });
    editorView.focus();
    return true;
  };

  const clearStoredWritingTags = async () => {
    const source = sourceSnapshotRef.current;
    const digest = source?.source_sha256;
    if (!source || !digest || source.id !== selectedId || dirtyRef.current || saveInFlight.current) return;
    const indices = source.tags.flatMap((tag, index) => isWritingTag(tag) ? [index] : []);
    if (!indices.length) return;
    setSaving(true);
    const pending = (async () => {
      const removal = indices.length === source.tags.length ? "All" : { Indices: indices } as const;
      const receipt = await removeMemoMetadataTags(source.path, digest, removal);
      const updated = await getMemo(source.id);
      if (updated.source_sha256 !== receipt.sha256) throw new Error("external_change_conflict");
      qc.setQueryData(["memo", source.id], updated);
      if (selectedIdRef.current === source.id) sourceSnapshotRef.current = updated;
      void qc.invalidateQueries({ queryKey: ["memos"] });
      void qc.invalidateQueries({ queryKey: ["facets"] });
    })();
    saveInFlight.current = pending;
    try { await pending; }
    catch (error) { setError(String(error).includes("external_change_conflict") ? t.save_conflict : String(error).split("\n")[0]); }
    finally { saveInFlight.current = null; setSaving(false); }
  };
  const applyWritingRevision = (revision: WritingRevision, expectedSource: string): boolean => {
    const view = editorView;
    if (!view || !currentNote || selectedIdRef.current !== currentNote.id
      || bodyRef.current !== expectedSource) return false;
    const update = writingRevisionUpdate(expectedSource, revision);
    if (!update || view.state.doc.toString() !== update.editorSource) return false;
    const { change } = update;
    // Atomic's update listener calls editBody synchronously with LF text.
    // Carry the exact source patch through that callback, without rewriting
    // untouched line endings or bypassing the guarded autosave path.
    pendingWritingSource.current = {
      id: currentNote.id, editorSource: update.nextEditorSource, source: update.nextSource,
    };
    try {
      view.dispatch({
        changes: change,
        selection: { anchor: change.from + change.insert.length },
        annotations: isolateHistory.of("full"),
        effects: EditorView.scrollIntoView(change.from, { y: "center" }),
      });
    } finally {
      pendingWritingSource.current = null;
    }
    return true;
  };
  const prepareWritingCopilot = (_task: "scenario") => {
    const agent = copilot.data?.agent;
    const noteId = currentNote?.id;
    if (!agent || !noteId) return;
    guardedNavigation(async () => {
      if (selectedIdRef.current !== noteId) return;
      const store = useUI.getState();
      if (store.copilotAgent !== agent) {
        store.resetCopilotChat();
        useUI.setState({ copilotAgent: agent });
      }
      const draft = useUI.getState().copilotDraft;
      const prompt = t.writing_copilot_scenario_prompt;
      store.setCopilotDraft(draft ? draft + "\n\n" + prompt : prompt);
      store.setCopilotDetachedMemoId(null);
      setInspector(null);
      setCopilotOpen(true);
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="memo-backdrop fixed inset-0 z-40 transition-opacity duration-200 ease-out data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup
          ref={popupRef}
          initialFocus={initialFocus}
          data-copilot={copilotOpen}
          data-layout={memoLayout}
          data-frame-motion={frameMotion}
          data-native-window={typeof window !== "undefined" && "__TAURI_INTERNALS__" in window}
          className="memo-sheet z-50 overflow-hidden transition-opacity duration-200 ease-out data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
        >
          <div className="memo-sheet-inner flex h-full flex-col">
            <Dialog.Title className="sr-only">{memo.data?.title || t.empty_memo}</Dialog.Title>
            <CtxRoot>
              <CtxTrigger
                render={<span className="contents" />}
              >
                <div className="memo-sheet-header" data-tauri-drag-region="deep">
              {memo.data && seededId === memo.data.id && (
                <SaveRing dirty={dirty} saving={saving} blocked={saveBlocked || saveProblem !== null} />
              )}
              {(!memo.data || memo.data.format === "html") && (
                <span className="inline-flex items-center gap-1 text-xs text-text-subtle">
                  <Folder size={12} aria-hidden />
                  {folder ? displayFolder(folder) : t.folder_root}
                </span>
              )}
              <div ref={setEditorToolsTarget} className="memo-editor-tools-slot" />
              {dailyDate && (
                <div className="flex items-center gap-0.5" data-daily-nav>
                  <IconTool
                    onClick={() => goDaily(-1)}
                    label={t.daily_prev_day}
                    className="rounded-[var(--button-radius)] p-1 text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    <ChevronLeft size={13} />
                  </IconTool>
                  <span className="min-w-9 text-center text-[11px] text-text-subtle" data-daily-rel>
                    {relLabel}
                  </span>
                  <IconTool
                    onClick={() => goDaily(1)}
                    disabled={shiftISODate(dailyDate, 1) > today}
                    label={t.daily_next_day}
                    className="rounded-[var(--button-radius)] p-1 text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <ChevronRight size={13} />
                  </IconTool>
                  {copilotVisible && (
                    <DigestButton
                      memoId={memo.data!.id}
                      body={body}
                      dirty={dirty}
                      saving={saving}
                      onInsertBody={applyBodyEdit}
                    />
                  )}
                </div>
              )}
              <div className="memo-sheet-actions">
                {currentNote && (
                  <IconTool
                    ref={wordsButtonRef}
                    onClick={() => toggleInspector("words")}
                    label={t.word_lookup}
                    aria-expanded={activeInspector?.kind === "words"}
                    aria-controls={activeInspector?.kind === "words" ? "memo-writing-inspector" : undefined}
                    className="memo-header-tool text-text-subtle hover:bg-surface-muted"
                  ><BookOpenText size={15} aria-hidden /></IconTool>
                )}
                {profile && (
                  <IconTool
                    ref={writingButtonRef}
                    onClick={() => toggleInspector("writing")}
                    label={t.writing_tools}
                    aria-expanded={activeInspector?.kind === "writing"}
                    aria-controls={activeInspector?.kind === "writing" ? "memo-writing-inspector" : undefined}
                    className="memo-header-tool relative text-text-subtle hover:bg-surface-muted"
                  >
                    <PenLine size={15} aria-hidden />
                  </IconTool>
                )}
                <IconTool
                  onClick={() => edit(setFavorite)(!favorite)}
                  label={favorite ? t.action_unfavorite : t.action_favorite}
                  aria-pressed={favorite}
                  className={`rounded-md p-1.5 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                    favorite ? "text-hue-amber hover:bg-surface-muted" : "text-text-subtle hover:bg-surface-muted hover:text-hue-amber"
                  }`}
                >
                  <Star size={14} className={favorite ? "fill-hue-amber" : undefined} />
                </IconTool>
                {copilotVisible && (
                  <IconTool data-copilot-trigger onClick={() => { setFrameMotion(!frameTiming.reduce); setCopilotOpen(!copilotOpen); }} label={t.copilot_fab} aria-pressed={copilotOpen} className="memo-header-tool text-text-subtle hover:bg-surface-muted">
                    <Bot size={16} aria-hidden />
                  </IconTool>
                )}
                <IconTool
                  onClick={() => { setFrameMotion(!frameTiming.reduce); setMemoLayout(memoLayout === "immersive" ? "sheet" : "immersive"); }}
                  label={memoLayout === "immersive" ? t.memo_sheet_view : t.memo_immersive_view}
                  className="memo-header-tool text-text-subtle hover:bg-surface-muted active:bg-surface-muted"
                >
                  {memoLayout === "immersive" ? <Minimize2 size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}
                </IconTool>
                <Button
                  type="button"
                  onClick={close}
                  className="rounded-[var(--button-radius)] bg-interactive-primary px-3 py-1.5 text-xs font-medium text-interactive-primary-foreground transition-colors duration-150 hover:bg-interactive-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                >
                  {t.done}
                </Button>
              </div>
                </div>
                {menuSummary && (
                  <NoteCtxMenu
                    memo={menuSummary}
                    folderEntries={folders}
                    onToggleFavorite={onMenuToggleFavorite}
                    onMoveFolder={onMenuMoveFolder}
                    onCopyBody={onMenuCopyBody}
                    onDelete={onMenuDelete}
                  />
                )}
              </CtxTrigger>
            </CtxRoot>
            <div
              ref={writingWorkspaceRef}
              className="memo-writing-workspace min-h-0 flex-1"
              data-inspector={activeInspector !== null}
              style={activeInspector ? ({ "--g-layout-panel-width": `${visibleWritingPanelWidth}px` } as CSSProperties) : undefined}
            >
              {memo.isLoading || !memo.data || seededId !== memo.data.id ? (
                // Skeleton in the sheet's shape: title, property chips, body
                // paragraphs — stands in for PropertyPanel + content.
                <div aria-hidden="true" className="flex h-full flex-col gap-3 p-6">
                  <Skeleton className="h-5 w-1/3" />
                  <div className="flex gap-2">
                    <Skeleton className="h-6 w-20 rounded-full" />
                    <Skeleton className="h-6 w-16 rounded-full" />
                    <Skeleton className="h-6 w-24 rounded-full" />
                  </div>
                  <div className="mt-2 space-y-2">
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-11/12" />
                    <Skeleton className="h-3 w-4/5" />
                    <Skeleton className="h-3 w-2/3" />
                  </div>
                </div>
              ) : (
                // Single scroll container: properties + content read as one
                // document (user prompt 2026-08-30 — many properties no longer
                // cap the content viewport). Chrome (header, dock, history)
                // stays fixed outside.
                <div className="memo-margin-stage">
                <div
                  ref={attachScroll}
                  data-memo-scroll
                  data-format={memo.data.format}
                  className="memo-sheet-scroll flex min-h-0 flex-1 flex-col overflow-y-auto"
                >
                  {saveProblem && (
                    <div role="alert" className="mb-2 rounded-md border border-line bg-surface-muted p-3 text-xs text-text-muted">
                      <p>{saveProblem}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button type="button" onClick={() => { void navigator.clipboard.writeText(bodyRef.current).catch(reportSaveError); }} className="rounded-md border border-line px-2 py-1 text-text hover:bg-surface focus-visible:outline-2 focus-visible:outline-focus-ring">{t.save_copy_draft}</button>
                        <button type="button" onClick={() => { void reloadAfterCopy(); }} className="rounded-md border border-line px-2 py-1 text-text hover:bg-surface focus-visible:outline-2 focus-visible:outline-focus-ring">{t.save_copy_reload}</button>
                      </div>
                    </div>
                  )}
                  <PropertyPanel memo={memo.data} folder={folder || memo.data.folder} body={body} />
                  {memo.data.format === "html" ? (
                    // IDE-style split panes keep their internal scrollers; pin
                    // the workspace to the scroller height so only the
                    // property block flows above it.
                    <GPage width="full" className="memo-sheet-body flex h-full min-h-0 shrink-0 flex-col gap-2.5">
                      <HtmlNoteEditor
                        key={`${memo.data.id}:${editorRevision}`}
                        documentId={memo.data.id}
                        body={body}
                        onChange={editBody}
                      />
                    </GPage>
                  ) : (
                    <GPage width={memoLayout === "immersive" ? "reading" : "full"} className="memo-sheet-body">
                      <MemoEditorForm
                        autoFocus={editorAutoFocus}
                        toolbarTarget={editorToolsTarget}
                        key={`${memo.data.id}:${editorRevision}`}
                        documentId={memo.data.id}
                        folder={folder}
                        onFolderChange={applyFolder}
                        folders={folders}
                        body={body}
                        onBodyChange={editBody}
                        onSaveAndClose={finishFromEditor}
                        onWikiLinkOpen={onWikiLinkOpen}
                        onDocumentLinkOpen={onDocumentLinkOpen}
                        onNavigateMemo={onNavigateMemo}
                        folderPickerRef={folderPickerRef}
                        onEditorView={setEditorView}
                      />
                    </GPage>
                  )}
                </div>
                {margins.left && (
                  <MarginSlot side="left" box={margins.left} label={t.margin_backlinks} slotRef={setMarginLeftEl} onWheel={forwardMarginWheel} />
                )}
                {margins.right && (
                  <MarginSlot side="right" box={margins.right} label={t.margin_related} slotRef={setMarginRightEl} onWheel={forwardMarginWheel} />
                )}
                </div>
              )}
              {activeInspector && (
                <div
                  id="memo-writing-inspector"
                  className="memo-writing-panel relative min-h-0 min-w-0"
                  onKeyDown={(event) => {
                    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    event.stopPropagation();
                    closeInspector();
                  }}
                >
                  {/* Width handle for the side-by-side (≥700px container)
                      layout — drag or Arrow/Shift+Arrow/Home/End. */}
                  <PanelResizeHandle
                    side="end"
                    value={visibleWritingPanelWidth}
                    min={WRITING_PANEL_MIN}
                    max={WRITING_PANEL_MAX}
                    measureMax={measurePanelMax}
                    onResize={setWritingPanelWidth}
                    onResizeCommit={(w) => writePanelWidth(WRITING_PANEL_WIDTH_KEY, w)}
                    label={t.writing_panel_resize}
                    controls="memo-writing-inspector"
                  />
                  {activeInspector.kind === "words" ? (
                    <WordLookupPanel
                      key={activeInspector.id}
                      initialWord={activeInspector.word ?? ""}
                      onClose={closeInspector}
                      glossary={currentNote?.folder ? {
                        noteId: activeInspector.id, folder: currentNote.folder, open: onNavigateMemo,
                      } : undefined}
                    />
                  ) : profile && manuscript && (
                    <WritingPanel
                      key={`${activeInspector.id}:${profile}`}
                      profile={profile}
                      manuscript={manuscript}
                      updating={reviewUpdating}
                      title={currentNote?.title || t.empty_memo}
                      noteId={activeInspector.id}
                      body={body}
                      onApplyRevision={applyWritingRevision}
                      folder={currentNote?.folder ?? ""}
                      storedTags={currentNote?.source_sha256 ? currentNote.tags.filter(isWritingTag) : []}
                      onClearStoredTags={dirty || saving ? undefined : clearStoredWritingTags}
                      onClose={closeInspector}
                      onJump={jumpToWritingLine}
                      onInsert={insertPlanning}
                      onCopilot={copilotVisible ? prepareWritingCopilot : undefined}
                    />
                  )}
                </div>
              )}
            </div>
            {memo.data && seededId === memo.data.id && (
              <div className="memo-sheet-footer flex-wrap">
                {/* AI suggestion strip: markdown notes with a saved memo only
                    (goal 2026-10-25). `w-full basis-full` keeps it its own row
                    above the dock in the wrapped footer; applies ride the
                    editor's own guarded path (editBody → debounced autosave). */}
                {memo.data.format !== "html" && (
                  <SuggestionStrip
                    className="w-full shrink-0 basis-full"
                    memoId={memo.data.id}
                    body={body}
                    dirty={dirty}
                    saving={saving}
                    copilotReady={copilotVisible}
                    autoEnabled={autoSuggest}
                    onApplyBody={applyBodyEdit}
                  />
                )}
                <ContextDock
                  noteId={memo.data.id}
                  title={memo.data.title}
                  tags={memo.data.tags}
                  aliases={aliases}
                  marginLeft={margins.left ? marginLeftEl : null}
                  marginRight={margins.right ? marginRightEl : null}
                  onNavigateMemo={onNavigateMemo}
                />
                {memo.data.path && <HistoryPanel path={memo.data.path} />}
              </div>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
