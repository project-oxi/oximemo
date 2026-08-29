/**
 * MemoDetail 전용 편집 폼. 본문은 atomic-editor 기반 `MarkdownEditor`,
 * 추출된 `#태그`와 폴더·이미지 보조 제어만 제공한다.
 */
import { Image as ImageIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { type Ref, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";

import { createFolder, folderTemplate, getConfig, transformTaskDraft } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { FolderCombobox, type FolderComboboxHandle } from "./FolderCombobox";
import { MarkdownEditor } from "./MarkdownEditor";
import { TagChipRow } from "./TagChipRow";
import { TaskEditPopover, type TaskEditInitial, type VirtualAnchor } from "./TaskEditPopover";
import { imagePickerKeymap, insertImagesAt, type ImageViewHandle } from "../lib/cm6Images";
import { wikiLinks, type AtomicCodeMirrorEditorHandle } from "@atomic-editor/editor";
import type { FolderEntry, TaskDraftTransform, TaskEdit } from "../lib/types";
import { buildWikiLinksConfig } from "../lib/memoLinks";
import { embedExtension } from "../lib/embeds";
import { queryEmbedExtension } from "../lib/queryEmbeds";
import { taskCheckboxExtension } from "../lib/taskCheckboxes";
import { taskSuggestExtension } from "../lib/taskSuggest";
import { RecencyLog } from "../lib/paletteCommands";
import { slashCompletionSource } from "../lib/slashExtension";
import type { SlashDeps } from "../lib/slashCommands";
import { cfgFromJson, parseTaskLine, type TaskLineChange, type TaskLineCfg } from "../lib/taskLine";
import { initialFromLine } from "../lib/taskPopoverSeed";
import { dayTone, relativeDayLabel, useTodayKey } from "../lib/relativeDay";
import { todayLocalISO } from "../lib/dates";
import { useUI } from "../stores/ui";
const cx = (...xs: (string | false | null | undefined)[]) =>
  xs.filter(Boolean).join(" ");

export interface MemoEditorFormProps {
  body: string;
  onBodyChange: (v: string) => void;
  documentId: string;
  folder: string;
  onFolderChange: (f: string) => void;
  folders: FolderEntry[];
  folderPickerRef?: Ref<FolderComboboxHandle>;
  className?: string;
  /** Fires with the captured CM6 EditorView once the editor has mounted for
   *  this documentId. The previous view (if any) is reported as `null`
   *  when the effect tears down — either for a documentId swap or for
   *  an unmount. MemoDetail uses this to dispatch scroll+selection
   *  once a queued `pendingTaskAnchor` arrives. */
  onEditorView?: (view: EditorView | null) => void;
}

/** Map kernel line changes to CM6 offsets against `doc` (the same doc
 *  the transform ran on). `delete_lines: 0` is a pure insertion anchored
 *  at the start of `start_line`. Same mapping as taskCheckboxes'
 *  internal `changeSpecs` — the popover's commit path needs the
 *  RETURNED geometry to re-resolve the target line between sequenced
 *  edits, which `applyTaskTransform` (dispatches internally) hides. */
function lineChangeSpecs(doc: Text, changes: TaskLineChange[]) {
  return changes.map((c) => {
    const from = doc.line(c.start_line + 1).from;
    const to = c.delete_lines > 0 ? doc.line(c.start_line + c.delete_lines).to : from;
    return { from, to, insert: c.insert_lines.join("\n") };
  });
}

export function MemoEditorForm({
  body,
  onBodyChange,
  documentId,
  folder,
  onFolderChange,
  folders,
  folderPickerRef,
  className,
  onEditorView,
}: MemoEditorFormProps) {
  const { t, locale } = useI18n();
  const select = useUI((s) => s.select);
  const setCopilotSelection = useUI((s) => s.setCopilotSelection);
  const editorHandleRef = useRef<AtomicCodeMirrorEditorHandle | null>(null);
  const viewHandleRef = useRef<ImageViewHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Tasks (spec §7.1): the widget cfg mirrors the vault's [tasks]
  // table. Shared ["config"] query cache (MemoDetail uses the same
  // key); until it resolves the editor mounts no task widgets.
  const configQ = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const taskCfg = useMemo<TaskLineCfg | null>(
    () => (configQ.data?.tasks ? cfgFromJson(configQ.data.tasks) : null),
    [configQ.data],
  );
  // Date chips re-render on day rollover (§7.0): the extension array
  // rebuilds when the shared local-midnight key flips.
  const todayKey = useTodayKey();
  // Slash menu (spec §8): pick recency outlives extension-array
  // rebuilds (cfg/locale/day flips), so it lives in a ref restored
  // once per mount; the source persists it under its own key on
  // every pick (the CommandPalette RecencyLog convention).
  const slashRecencyRef = useRef(new RecencyLog());
  useEffect(() => {
    try {
      slashRecencyRef.current.load(JSON.parse(localStorage.getItem("oximemo.editorSlashRecency") ?? "[]"));
    } catch {
      slashRecencyRef.current.load([]);
    }
  }, []);
  // Slash 템플릿 group (Plan D): the folder's TEMPLATE.md body arrives
  // async; until it resolves — or permanently in browser mode — the
  // 폴더 템플릿 삽입 command hides (never a silent no-op).
  const templateQ = useQuery({
    queryKey: ["folder_template", folder],
    queryFn: () => folderTemplate(folder),
  });
  const templateBody = templateQ.data ?? null;
  const slashDeps = useMemo<SlashDeps>(
    () => ({
      cfg: taskCfg,
      locale,
      recency: slashRecencyRef.current,
      todayISO: todayKey,
      templateBody: () => templateBody,
    }),
    [taskCfg, locale, todayKey, templateBody],
  );
  // Task edit popover (spec §7.2): open + initial field snapshot +
  // the 0-based line index in the editor's doc. We seed the
  // popover's draft from the line's parsed fields when ⌘⇧E / a
  // right-click on a CM6 widget opens it; the commit path re-resolves
  // the line after each kernel round-trip (see commitTaskEdits).
  const [taskEdit, setTaskEdit] = useState<{
    open: boolean;
    line: number;
    initial: TaskEditInitial;
  } | null>(null);
  const setError = useUI((s) => s.setError);

  const openTaskPopover = useCallback((line: number) => {
    const view = viewHandleRef.current?.view;
    if (!view || !taskCfg) return;
    if (line < 0 || line >= view.state.doc.lines) return;
    const raw = view.state.doc.line(line + 1).text;
    const parsed = parseTaskLine(raw, taskCfg);
    if (!parsed) return;
    setTaskEdit({ open: true, line, initial: initialFromLine(parsed, raw) });
  }, [taskCfg]);

  const closeTaskPopover = useCallback(
    () => setTaskEdit((s) => (s ? { ...s, open: false } : s)),
    [],
  );

  // Caret-line geometry for the popover anchor, resolved once per
  // open from the live CM6 view via `coordsAtPos`.
  const anchorCoords = useMemo(() => {
    if (!taskEdit) return null;
    const view = viewHandleRef.current?.view;
    if (!view) return null;
    const line = view.state.doc.line(Math.min(taskEdit.line + 1, view.state.doc.lines));
    return view.coordsAtPos(line.from);
  }, [taskEdit]);

  // Virtual anchor for the popover: a position-only rect over the
  // target line's text, fed straight to Base UI's `Positioner anchor`.
  // No DOM span is rendered — a hidden trigger measuring the caret
  // was both stale-on-mount (ref null until a re-render) and the
  // source of the (0, 0) anchoring bug.
  const taskAnchor = useMemo<VirtualAnchor | null>(() => {
    if (!anchorCoords) return null;
    const { left, top, right, bottom } = anchorCoords;
    return {
      getBoundingClientRect: () =>
        new DOMRect(left, top, Math.max(right - left, 1), Math.max(bottom - top, 1)),
    };
  }, [anchorCoords]);

  const commitTaskEdits = useCallback(
    async (edits: TaskEdit[]) => {
      if (edits.length === 0) return;
      const view = viewHandleRef.current?.view;
      let line = taskEdit?.line ?? 0;
      if (!view || !taskCfg) return;
      for (const edit of edits) {
        // Same guarded pattern as applyTaskTransform (doc snapshot →
        // kernel round-trip → drift check → ONE dispatch), but inline:
        // the returned geometry re-resolves the target line for the
        // remaining edits.
        const before = view.state.doc;
        let out: TaskDraftTransform;
        try {
          out = await transformTaskDraft(before.toString(), line, edit, todayLocalISO());
        } catch {
          setError(t.task_conflict_reload);
          return;
        }
        if (view.state.doc !== before || out.changes.length === 0) {
          setError(t.task_conflict_reload);
          return;
        }
        view.dispatch({ changes: lineChangeSpecs(before, out.changes) });
        // A terminal status + recurrence spawns the new occurrence
        // ABOVE the completed line (spec §6), shifting the just-edited
        // task down one row — the same primary_line rule vault.rs
        // `patch_task` applies to its returned TaskDto.
        if (out.spawned_line_hint === line) line += 1;
      }
      editorHandleRef.current?.focus();
    },
    [taskCfg, t, taskEdit?.line, setError],
  );

  // Wiki-links completion config, hoisted so BOTH surfaces share one
  // object: the wikiLinks() widgets below and the merged completion
  // source inside taskSuggestExtension (spec §7.3).
  const wikiCfg = useMemo(
    () => buildWikiLinksConfig({ onOpen: select, locale }),
    [select, locale],
  );

  const linkExtensions = useMemo(
    () => [
      imagePickerKeymap(() => fileInputRef.current?.click()),
      // Wiki-links widgets/resolve/click paths stay here, but the
      // internal autocompletion is suppressed: CM6 allows exactly ONE
      // autocompletion({override}) (a second one with a different
      // array throws a config-merge conflict, and any override
      // disables languageData sources). taskSuggestExtension below
      // mounts the single merged override — the wiki `[[` completer
      // (a faithful replica reading this same config) plus the §7.3
      // task-field suggest.
      wikiLinks({ ...wikiCfg, suggest: undefined }),
      ...embedExtension({ onOpen: select, labels: t }),
      // Inline query embeds (query views spec §6): ![[query:…]] markers
      // and ```query fences resolve live in the note; thisId pins the
      // embedding note so per-note scopes never cross.
      ...queryEmbedExtension({
        thisId: documentId,
        labels: {
          results_n: t.query_embed_results_n,
          open_full: t.query_embed_open,
          loading: t.query_embed_loading,
          error: t.query_embed_error,
          ambiguous: t.query_embed_ambiguous,
        },
      }),
      // Task-line live preview (spec §7.1): checkbox + field-chip
      // widgets over the draft; ⌘⇧Enter toggles the caret's line. The
      // cfg flows from the vault's [tasks] config; label closures
      // carry the locale and the shared midnight-updating today key so
      // date chips follow the §7.0 never-raw-ISO rule.
      ...(taskCfg
        ? taskCheckboxExtension({
            cfg: taskCfg,
            labels: {
              status: {
                TODO: t.task_status_todo,
                IN_PROGRESS: t.task_status_in_progress,
                ON_HOLD: t.task_status_on_hold,
                DONE: t.task_status_done,
                CANCELLED: t.task_status_cancelled,
                NON_TASK: t.task_status_non_task,
              },
              dayLabel: (iso) => relativeDayLabel(iso, todayKey, locale),
              dayTone: (iso) => dayTone(iso, todayKey),
            },
            // Popover hooks (spec §7.2): right-click on a CM6 widget
            // AND ⌘⇧E on a task line both open the edit popover.
            // Both fire the same callback so the host wires one path
            // for both surfaces.
            onPopoverRequest: openTaskPopover,
          })
        : []),
      // Task field auto-suggest (spec §7.3): the single merged
      // completion source (wiki `[[` + absent task fields). Fires on
      // recognized task lines only, stays silent in fenced/inline
      // code and during IME composition, and writes real ISO tokens
      // in the vault's write format — the §7.1 widget decorates the
      // inserted token on the same doc change. Before taskCfg
      // resolves only the wiki source is active. todayKey rides along
      // so today/tomorrow options follow the shared midnight rollover.
      // The §8 slash menu (Plan D) merges into the same override —
      // CM6 allows exactly one autocompletion({override}); its
      // "/query" trigger is disjoint from the task-line tokens, so
      // both surfaces coexist on one source list.
      ...taskSuggestExtension({
        cfg: taskCfg,
        labels: t,
        wiki: wikiCfg,
        todayISO: todayKey,
        extraSources: [slashCompletionSource(slashDeps)],
      }),
      // Selection → copilot context (Claude-desktop style): the panel
      // folds whatever is highlighted into the next turn. Authoritative
      // CM6 state, not DOM selection — synced on every selection/doc
      // change; cleared when the editor unmounts (dialog close).
      EditorView.updateListener.of((u) => {
        if (!u.selectionSet && !u.docChanged) return;
        const sel = u.state.selection.main;
        if (sel.empty) {
          setCopilotSelection(null);
          return;
        }
        const text = u.state.sliceDoc(sel.from, sel.to);
        setCopilotSelection(text.trim() ? { memoId: documentId, text } : null);
      }),
    ],
    [select, locale, t, documentId, setCopilotSelection, slashDeps, taskCfg, todayKey, wikiCfg],
  );
  useEffect(
    () => () => setCopilotSelection(null),
    [setCopilotSelection],
  );
  useEffect(() => {
    const id = requestAnimationFrame(() => editorHandleRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [documentId]);
  // Publish the captured CM6 EditorView to the parent (MemoDetail) once
  // the editor's ViewPlugin constructor has run. The plugin runs
  // synchronously on mount, so by the time this effect's rAF fires
  // `viewHandleRef.current.view` is already set; we still re-poll for
  // a frame in case the parent's intent arrived a tick late (defensive
  // against the effect running before the plugin).
  useEffect(() => {
    if (!onEditorView) return;
    let raf = 0;
    const publish = () => {
      const view = viewHandleRef.current?.view ?? null;
      if (view) onEditorView(view);
      else raf = requestAnimationFrame(publish);
    };
    raf = requestAnimationFrame(publish);
    return () => {
      cancelAnimationFrame(raf);
      onEditorView(null);
    };
  }, [documentId, onEditorView]);

  const insertPicked = (list: FileList | null) => {
    const view = viewHandleRef.current?.view;
    if (!view || !list?.length) return;
    void insertImagesAt(Array.from(list), view.state.selection.main.from, view);
  };

  return (
    <div className={cx("flex flex-1 min-h-0 flex-col gap-2.5", className)}>
      <MarkdownEditor
        body={body}
        onChange={onBodyChange}
        documentId={documentId}
        editorHandleRef={editorHandleRef}
        viewHandleRef={viewHandleRef}
        className="flex-1 min-h-0 overflow-y-auto"
        extensions={linkExtensions}
      />
      <TagChipRow body={body} />
      <div className="flex flex-wrap items-center gap-2.5">
        <FolderCombobox
          ref={folderPickerRef}
          value={folder}
          onValueChange={onFolderChange}
          folders={folders}
          triggerAriaLabel={t.set_folder ?? "Set folder"}
          onClose={() => editorHandleRef.current?.focus()}
          onCreate={async (path) => {
            try {
              await createFolder(path);
              onFolderChange(path);
            } catch {
              // Rejected (e.g. duplicate path) — leave selection unchanged.
            }
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          aria-label={t.insert_image}
          title={`${t.insert_image} (⌘I)`}
          className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--button-radius)] text-text-subtle shadow-[var(--input-shadow)] transition-colors duration-150 hover:bg-surface-muted hover:text-text focus-visible:outline-none focus-visible:shadow-[var(--input-shadow-focus)]"
        >
          <ImageIcon size={15} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            insertPicked(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {taskCfg && taskEdit && taskAnchor && (
        <TaskEditPopover
          open={taskEdit.open}
          onOpenChange={(o) => {
            if (!o) {
              closeTaskPopover();
              // Esc / outside dismissal hands focus back to the
              // editor (the commit path focuses after its
              // round-trips land).
              editorHandleRef.current?.focus();
            } else {
              setTaskEdit((s) => (s ? { ...s, open: true } : s));
            }
          }}
          anchor={taskAnchor}
          initial={taskEdit.initial}
          cfg={taskCfg}
          todayISO={todayKey}
          onCommit={(edits) => void commitTaskEdits(edits)}
        />
      )}
    </div>
  );
}