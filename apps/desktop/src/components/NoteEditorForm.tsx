/**
 * NoteDetail 전용 편집 폼 (§4.3). 본문은 atomic-editor 기반
 * `MarkdownEditor`, 추출된 `#태그`는 `TagChipRow`, 하단에 컬러 + 완료.
 *
 * 기존 `NoteComposeForm`에서 textarea+mirror 오버레이 분기를 떼어내고
 * 본문 영역을 atomic-editor로 교체한 형태. 두 폼이 사용 의도가 다르므로
 * (NoteDetail=본격 편집, CaptureOverlay=빠른 캡처) 공통 컴포넌트로 묶지
 * 않고 의도적으로 분리함.
 */
import { Check } from "lucide-react";

import { createCategory } from "../lib/api";
import { CategoryCombobox } from "./CategoryCombobox";
import { MarkdownEditor } from "./MarkdownEditor";
import { TagChipRow } from "./TagChipRow";
import type { CategoryDef } from "../lib/types";

const cx = (...xs: (string | false | null | undefined)[]) =>
  xs.filter(Boolean).join(" ");


export interface NoteEditorFormProps {
  body: string;
  onBodyChange: (v: string) => void;
  documentId: string;
  category: string;
  onCategoryChange: (c: string) => void;
  categories: CategoryDef[];
  /** Primary action — "done" in NoteDetail. */
  onConfirm: () => void;
  confirmLabel: string;
  confirmDisabled?: boolean;
  /** Keyboard hint rendered inside the confirm button (e.g. "⌘⏎"). */
  confirmKbd?: string;
  className?: string;
}

export function NoteEditorForm({
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
  className,
}: NoteEditorFormProps) {
  return (
    <div className={cx("flex flex-col gap-2.5", className)}>
      <MarkdownEditor
        body={body}
        onChange={onBodyChange}
        documentId={documentId}
        className="max-h-[55vh] overflow-y-auto"
      />
      <TagChipRow body={body} />
      <div className="flex flex-wrap items-center gap-2.5">
        <CategoryCombobox
          value={category || "inbox"}
          onValueChange={onCategoryChange}
          categories={categories}
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