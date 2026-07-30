/**
 * CaptureOverlay 전용 빠른 캡처 폼 (§4.4). 본문은 plain textarea 그대로
 * 유지 — CM6 mount 비용은 캡처 윈도우의 즉시성을 깎는다. 색상 + 저장만.
 *
 * `NoteComposeForm`에서 textarea 분기만 남긴 형태. `MirrorTagEditor` 미러
 * 오버레이는 빠짐 — 빠른 캡처의 본문은 거의 한 줄이라 시각적 칩 강조의
 * 가치가 작고, 본문 자체를 항상 plain text로 보여주는 편이 빠른 입력에
 * 더 적합. 태그는 `extractTags`로 저장 시 파생되므로 입력 중 표시 안 해도
 * 무방.
 */
import { type Ref, type TextareaHTMLAttributes } from "react";
import { Check } from "lucide-react";

import { ColorSwatches } from "./ColorPicker";

const cx = (...xs: (string | false | null | undefined)[]) =>
  xs.filter(Boolean).join(" ");

export interface QuickCaptureFormProps {
  body: string;
  onBodyChange: (v: string) => void;
  bodyRef?: Ref<HTMLTextAreaElement>;
  bodyProps?: Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "value" | "onChange" | "className"
  >;
  bodyClassName?: string;
  color: string;
  onColorChange: (oklch: string) => void;
  /** Primary action — "save" in CaptureOverlay. */
  onConfirm: () => void;
  confirmLabel: string;
  confirmDisabled?: boolean;
  /** Keyboard hint rendered inside the confirm button (e.g. "↵"). */
  confirmKbd?: string;
  className?: string;
}

export function QuickCaptureForm({
  body,
  onBodyChange,
  bodyRef,
  bodyProps,
  bodyClassName,
  color,
  onColorChange,
  onConfirm,
  confirmLabel,
  confirmDisabled,
  confirmKbd,
  className,
}: QuickCaptureFormProps) {
  return (
    <div className={cx("flex flex-1 flex-col gap-2.5", className)}>
      <textarea
        ref={bodyRef}
        value={body}
        onChange={(e) => onBodyChange(e.target.value)}
        spellCheck={false}
        {...bodyProps}
        className={cx(
          "min-h-0 flex-1 resize-none rounded-md border border-transparent bg-transparent p-1.5 text-sm leading-relaxed text-zinc-800 placeholder:text-zinc-400 focus:border-zinc-300 focus:outline-none dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-zinc-700",
          bodyClassName,
        )}
      />
      <div className="flex flex-wrap items-center gap-2.5">
        <ColorSwatches value={color} onChange={onColorChange} />
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