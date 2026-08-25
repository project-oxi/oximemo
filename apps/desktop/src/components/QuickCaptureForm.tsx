/**
 * Fast capture shell. A neutral, keyboard-first input keeps the captured
 * thought primary; the destination is fixed by the host overlay.
 */
import {
  type Ref,
  type TextareaHTMLAttributes,
  useLayoutEffect,
  useRef,
} from "react";
import { TextCtxMenu } from "./TextCtxMenu";

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
  hint: string;
  className?: string;
}

export function QuickCaptureForm({
  body,
  onBodyChange,
  bodyRef,
  bodyProps,
  bodyClassName,
  hint,
  className,
}: QuickCaptureFormProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const setRef = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (typeof bodyRef === "function") bodyRef(el);
    else if (bodyRef) bodyRef.current = el;
  };

  useLayoutEffect(() => {
    const ta = innerRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [body]);


  return (
    <div className={cx("flex w-full flex-col", className)}>
      <div className="relative rounded-[var(--popover-radius)] bg-surface-raised px-3 py-2.5 shadow-[var(--input-shadow)] transition-shadow duration-150 focus-within:shadow-[var(--input-shadow-focus)]">
        <div className="relative">
          <TextCtxMenu
            render={
              <textarea
                ref={setRef}
                onChange={(e) => onBodyChange(e.target.value)}
                spellCheck={false}
                rows={1}
                {...bodyProps}
                className={cx(
                  "block w-full resize-none border-0 bg-transparent p-0 text-[0.9375rem] leading-relaxed text-text placeholder:text-text-subtle focus:outline-none",
                  "min-h-[1.5rem] max-h-[7.5rem] overflow-y-auto",
                  bodyClassName,
                )}
              />
            }
          />
        </div>
        <div className="mt-1 flex items-center justify-end">
          <span className="font-mono text-[10px] tracking-tight text-text-subtle">
            {hint}
          </span>
        </div>
      </div>
    </div>
  );
}