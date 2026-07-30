/**
 * CaptureOverlay 전용 빠른 캡처 폼 (§4.4). 채팅 입력창 형태 — 본문은
 * 좌측 정렬된 메시지 버블 안에 auto-grow textarea, 그 아래에 색상
 * 스왓치와 Enter 저장 액션이 한 줄로 모인다. 빈 상태에서도 카드는 1줄
 * 만큼만 작게 시작해 "스티커가 떠 있는" 정체성을 유지하고, 본문이
 * 늘어나면 카드가 같이 위로 자라며 window의 bottom edge는 그대로
 * 유지한다 (chat composer 패턴).
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
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { Check } from "lucide-react";

import { fitCaptureWindow } from "../lib/window";
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  // forward the inner ref to the caller for focus()
  const setRef = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (typeof bodyRef === "function") bodyRef(el);
    else if (bodyRef) bodyRef.current = el;
  };

  // Auto-grow: keep textarea height = its scrollHeight so content drives
  // the box, and re-fit the Tauri window to the card so the bottom edge
  // stays anchored.
  useLayoutEffect(() => {
    const ta = innerRef.current;
    if (!ta) return;
    // reset to measure natural height, then snap to content
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [body]);

  // After every paint, measure the card and ask the window to grow/shrink
  // so the bottom edge never moves. We use rAF so DOM has the final layout.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const card = rootRef.current;
      if (!card) return;
      // Add a small breathing room so the card's last line isn't flush
      // with the rounded bottom edge.
      const target = card.getBoundingClientRect().height + 8;
      void fitCaptureWindow(target);
    });
    return () => cancelAnimationFrame(id);
  }, [body]);

  return (
    <div ref={rootRef} className={cx("flex w-full flex-col gap-2", className)}>
      {/* 메시지 버블 — 색상이 선택되면 paper tint로 동일 색조. */}
      <div
        className={cx(
          "rounded-2xl border border-zinc-200/80 bg-white/70 px-3 py-2 shadow-sm backdrop-blur transition-colors",
          "dark:border-zinc-700/80 dark:bg-zinc-800/70",
        )}
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
