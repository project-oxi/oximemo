/**
 * MemoDetail 전용 편집 폼 (§4.3). 본문은 atomic-editor 기반
 * `MarkdownEditor`, 추출된 `#태그`는 `TagChipRow`, 하단에 컬러 + 완료.
 *
 * 기존 `MemoComposeForm`에서 textarea+mirror 오버레이 분기를 떼어내고
 * 본문 영역을 atomic-editor로 교체한 형태. 두 폼이 사용 의도가 다르므로
 * (MemoDetail=본격 편집, CaptureOverlay=빠른 캡처) 공통 컴포넌트로 묶지
 * 않고 의도적으로 분리함.
 */
import { Check, Image as ImageIcon } from "lucide-react";
import { type Ref, useEffect, useMemo, useRef } from "react";

import { createCategory } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { CategoryCombobox, type CategoryComboboxHandle } from "./CategoryCombobox";
import { MarkdownEditor } from "./MarkdownEditor";
import { TagChipRow } from "./TagChipRow";
import { insertImagesAt, type ImageViewHandle } from "../lib/cm6Images";
import { wikiLinks, type AtomicCodeMirrorEditorHandle } from "@atomic-editor/editor";
import type { CategoryDef } from "../lib/types";
import { buildWikiLinksConfig } from "../lib/memoLinks";
import { embedExtension } from "../lib/embeds";
import { useUI } from "../stores/ui";

const cx = (...xs: (string | false | null | undefined)[]) =>
  xs.filter(Boolean).join(" ");


export interface MemoEditorFormProps {
  body: string;
  onBodyChange: (v: string) => void;
  documentId: string;
  category: string;
  onCategoryChange: (c: string) => void;
  categories: CategoryDef[];
  /** Primary action — "done" in MemoDetail. */
  onConfirm: () => void;
  confirmLabel: string;
  confirmDisabled?: boolean;
  /** Keyboard hint rendered inside the confirm button (e.g. "⌘⏎"). */
  confirmKbd?: string;
  /** Optional ref to the category picker so a parent shortcut (⌘L) can
   *  open it imperatively. */
  categoryPickerRef?: Ref<CategoryComboboxHandle>;
  className?: string;
  /** Immersive (long-form) mode: grow the editor to fill available height. */
  immersive?: boolean;
}

export function MemoEditorForm({
  body,
  onBodyChange,
  documentId,
  category,
  onCategoryChange,
  categories,
  onConfirm,
  confirmLabel,
  confirmDisabled,
  confirmKbd,
  categoryPickerRef,
  className,
  immersive,
}: MemoEditorFormProps) {
  const { t } = useI18n();
  const select = useUI((s) => s.select);
  // Wiki-links ([[memo-id]]) + embeds (![[memo-id]]) layered into the editor.
  const linkExtensions = useMemo(
    () => [wikiLinks(buildWikiLinksConfig({ onOpen: select })), ...embedExtension({ onOpen: select })],
    [select],
  );
  const editorHandleRef = useRef<AtomicCodeMirrorEditorHandle | null>(null);
  const viewHandleRef = useRef<ImageViewHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Autofocus the body when the editor mounts (or swaps documents) so input
  // works immediately without an extra click.
  useEffect(() => {
    const id = requestAnimationFrame(() => editorHandleRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [documentId]);

  // Insert image files picked from the native chooser (or dragged, pasted) at
  // the editor cursor. Shared by the toolbar button, ⌘I, and the hidden input.
  const insertPicked = (list: FileList | null) => {
    const view = viewHandleRef.current?.view;
    if (!view || !list?.length) return;
    void insertImagesAt(Array.from(list), view.state.selection.main.from, view);
  };

  return (
    <div
      className={cx("flex flex-col gap-2.5", immersive && "flex-1 min-h-0", className)}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "i") {
          e.preventDefault();
          fileInputRef.current?.click();
        }
      }}
    >
      <MarkdownEditor
        body={body}
        onChange={onBodyChange}
        documentId={documentId}
        editorHandleRef={editorHandleRef}
        viewHandleRef={viewHandleRef}
        className={immersive ? "flex-1 min-h-0 overflow-y-auto" : "max-h-[55vh] overflow-y-auto"}
        extensions={linkExtensions}
      />
      <TagChipRow body={body} />
      <div className="flex flex-wrap items-center gap-2.5">
        <CategoryCombobox
          ref={categoryPickerRef}
          value={category || "inbox"}
          onValueChange={onCategoryChange}
          categories={categories}
          triggerAriaLabel={t.set_category}
          onClose={() => editorHandleRef.current?.focus()}
          onCreate={async (id) => {
            try {
              const def = await createCategory(id, null);
              onCategoryChange(def.id);
            } catch {
              // Rejected (e.g. duplicate id) — leave selection unchanged.
            }
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          aria-label={t.insert_image}
          title={`${t.insert_image} (⌘I)`}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
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
          className="group ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-2 text-white shadow-sm transition-all hover:bg-zinc-800 active:scale-95 disabled:pointer-events-none disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          <Check
            size={15}
            strokeWidth={2.5}
            className="transition-transform group-hover:scale-110"
          />
          {confirmKbd && (
            <kbd className="font-mono text-[10px] leading-none text-white/60 dark:text-zinc-500">
              {confirmKbd}
            </kbd>
          )}
        </button>
      </div>
    </div>
  );
}
