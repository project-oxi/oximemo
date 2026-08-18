/**
 * MemoDetail 전용 편집 폼 (§4.3). 본문은 atomic-editor 기반
 * `MarkdownEditor`, 추출된 `#태그`는 `TagChipRow`, 하단에 컬러 + 완료.
 */
import { Check, Image as ImageIcon } from "lucide-react";
import { type Ref, useEffect, useMemo, useRef } from "react";

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
  /** Primary action — "done" in MemoDetail. */
  onConfirm: () => void;
  confirmLabel: string;
  confirmDisabled?: boolean;
  confirmKbd?: string;
  folderPickerRef?: Ref<FolderComboboxHandle>;
  className?: string;
  immersive?: boolean;
}

export function MemoEditorForm({
  body,
  onBodyChange,
  documentId,
  folder,
  onFolderChange,
  folders,
  onConfirm,
  confirmLabel,
  confirmDisabled,
  confirmKbd,
  folderPickerRef,
  className,
  immersive,
}: MemoEditorFormProps) {
  const { t, locale } = useI18n();
  const select = useUI((s) => s.select);
  const editorHandleRef = useRef<AtomicCodeMirrorEditorHandle | null>(null);
  const viewHandleRef = useRef<ImageViewHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const linkExtensions = useMemo(
    () => [
      imagePickerKeymap(() => fileInputRef.current?.click()),
      wikiLinks(buildWikiLinksConfig({ onOpen: select, locale })),
      ...embedExtension({ onOpen: select, labels: t }),
    ],
    [select, locale, t],
  );
  useEffect(() => {
    const id = requestAnimationFrame(() => editorHandleRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [documentId]);
  useEffect(() => {
    const id = requestAnimationFrame(() => editorHandleRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [immersive]);

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
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line text-text-subtle transition-colors hover:bg-surface-muted hover:text-text"
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
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirmDisabled}
          aria-label={confirmLabel}
          title={confirmLabel}
          className="group ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-interactive-primary px-2 text-interactive-primary-foreground shadow-sm transition-all hover:bg-interactive-primary/90 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
        >
          <Check
            size={15}
            strokeWidth={2.5}
            className="transition-transform group-hover:scale-110"
          />
          {confirmKbd && (
            <kbd className="font-mono text-[10px] leading-none text-interactive-primary-foreground/60">
              {confirmKbd}
            </kbd>
          )}
        </button>
      </div>
    </div>
  );
}