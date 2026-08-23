/**
 * MemoDetail 전용 편집 폼. 본문은 atomic-editor 기반 `MarkdownEditor`,
 * 추출된 `#태그`와 폴더·이미지 보조 제어만 제공한다.
 */
import { Image as ImageIcon } from "lucide-react";
import { type Ref, useEffect, useMemo, useRef } from "react";
import { EditorView } from "@codemirror/view";

import { createFolder } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { FolderCombobox, type FolderComboboxHandle } from "./FolderCombobox";
import { MarkdownEditor } from "./MarkdownEditor";
import { TagChipRow } from "./TagChipRow";
import { imagePickerKeymap, insertImagesAt, type ImageViewHandle } from "../lib/cm6Images";
import { wikiLinks, type AtomicCodeMirrorEditorHandle } from "@atomic-editor/editor";
import type { FolderEntry } from "../lib/types";
import { buildWikiLinksConfig } from "../lib/memoLinks";
import { embedExtension } from "../lib/embeds";
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
}: MemoEditorFormProps) {
  const { t, locale } = useI18n();
  const select = useUI((s) => s.select);
  const setCopilotSelection = useUI((s) => s.setCopilotSelection);
  const editorHandleRef = useRef<AtomicCodeMirrorEditorHandle | null>(null);
  const viewHandleRef = useRef<ImageViewHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const linkExtensions = useMemo(
    () => [
      imagePickerKeymap(() => fileInputRef.current?.click()),
      wikiLinks(buildWikiLinksConfig({ onOpen: select, locale })),
      ...embedExtension({ onOpen: select, labels: t }),
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
    [select, locale, t, documentId, setCopilotSelection],
  );
  useEffect(
    () => () => setCopilotSelection(null),
    [setCopilotSelection],
  );
  useEffect(() => {
    const id = requestAnimationFrame(() => editorHandleRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [documentId]);

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
    </div>
  );
}