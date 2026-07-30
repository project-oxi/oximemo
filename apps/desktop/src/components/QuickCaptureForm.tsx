/**
 * 캡처 입력창 형태 — 본문은 메시지 버블 안에 auto-grow textarea,
 * 그 아래에 색상 스왓치와 Enter 저장 액션이 한 줄로 모인다. 윈도우는
 * 200pt 고정이고 카드만 콘텐츠 높이를 따라가며, 짧은 카드 위의 빈
 * 공간은 투명한 윈도우 배경으로 보이지 않는다.
 *
 * 본문은 plain textarea 그대로 유지 — CM6 mount 비용은 캡처 윈도우의
 * 즉시성을 깎는다. `MirrorTagEditor` 미러 오버레이는 빠짐 — 빠른
 * 캡처의 본문은 거의 한 줄이라 시각적 칩 강조의 가치가 작고, 본문
 * 자체를 항상 plain text로 보여주는 편이 빠른 입력에 더 적합. 태그는
 * `extractTags`로 저장 시 파싱되므로 입력 중 표시 안 해도 무방.
 */
import {
  type Ref,
  type TextareaHTMLAttributes,
  useLayoutEffect,
  useRef,
} from "react";
import { Check } from "lucide-react";

import { paperFor } from "../lib/color";
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
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  // forward the inner ref to the caller for focus()
  const setRef = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (typeof bodyRef === "function") bodyRef(el);
    else if (bodyRef) bodyRef.current = el;
  };

  // Auto-grow: snap textarea height to its scrollHeight so the card tracks
  // content. The window stays fixed (200pt); dead space above a short card
  // is the transparent window background.
  useLayoutEffect(() => {
    const ta = innerRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [body]);

  return (
    <div className={cx("flex w-full flex-col gap-2", className)}>
      {/* 메시지 버블 — 색상이 선택되면 paper tint로 동일 색조. */}
      <div
        className={cx(
          "rounded-2xl border px-3 py-2 shadow-sm backdrop-blur transition-colors",
          color
            ? "border-black/5"
            : "border-zinc-200/80 bg-white/70 dark:border-zinc-700/80 dark:bg-zinc-800/70",
        )}
        style={color ? { backgroundColor: paperFor(color) } : undefined}
      >
        <textarea
          ref={setRef}
          value={body}
          onChange={(e) => onBodyChange(e.target.value)}
          spellCheck={false}
          rows={1}
          {...bodyProps}
          className={cx(
            "block w-full resize-none border-0 bg-transparent p-0 text-sm leading-relaxed text-zinc-800 placeholder:text-zinc-400 focus:outline-none focus:ring-0 dark:text-zinc-100 dark:placeholder:text-zinc-500",
            // 한 줄 기본, max 8줄. 그 이상은 내부 스크롤로 흡수.
            "min-h-[1.625rem] max-h-[13rem] overflow-y-auto",
            bodyClassName,
          )}
        />
      </div>

      {/* 액션 행 — 색상 7개 + Enter 저장. 한 줄로 압축. */}
      <div className="flex items-center gap-2 px-1">
        <ColorSwatches value={color} onChange={onColorChange} />
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirmDisabled}
          aria-label={confirmLabel}
          title={confirmLabel}
          className="group ml-auto inline-flex h-7 items-center gap-1.5 rounded-md bg-zinc-900 px-2 text-white shadow-sm transition-all hover:bg-zinc-800 active:scale-95 disabled:pointer-events-none disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          <Check
            size={14}
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
