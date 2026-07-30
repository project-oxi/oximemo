/**
 * Body editor with inline `#tag` chips via the textarea + mirror-overlay
 * technique (§6). A transparent-text <textarea> (caret visible) sits above a
 * pointer-events:none <div> that renders the same text with `#tags` wrapped in
 * colored chips. Identical font/padding/whitespace keeps them pixel-aligned.
 * Input, IME composition, undo, paste, selection are all native textarea —
 * Korean Hangul composition never breaks because we never rewrite the textarea.
 */
import { forwardRef, useImperativeHandle, useRef, type TextareaHTMLAttributes } from "react";

import { highlightTags } from "../lib/tags";

// Shared box model: BOTH the textarea and the mirror MUST use this exact class
// so the chip layer lines up with the caret layer. Font, padding, wrapping all
// identical → pixel-perfect overlay.
const BOX = "text-sm leading-relaxed whitespace-pre-wrap break-words p-1.5";

interface Props {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  textareaProps?: Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "value" | "onChange" | "className"
  >;
}

export const MirrorTagEditor = forwardRef<HTMLTextAreaElement, Props>(
  function MirrorTagEditor({ value, onChange, className = "", textareaProps }, ref) {
    const inner = useRef<HTMLTextAreaElement>(null);
    const mirrorRef = useRef<HTMLDivElement>(null);
    useImperativeHandle(ref, () => inner.current as HTMLTextAreaElement);

    return (
      <div className={`relative ${className}`}>
        {/* Highlight layer: same box model, behind the textarea. */}
        <div
          ref={mirrorRef}
          aria-hidden
          className={`pointer-events-none absolute inset-0 overflow-hidden ${BOX} text-zinc-800 dark:text-zinc-100`}
        >
          {highlightTags(value).map((s, i) =>
            s.tag ? (
              <span
                key={i}
                className="rounded bg-[var(--tag-bg)] px-0.5 font-medium text-[var(--tag)]"
              >
                {s.text}
              </span>
            ) : (
              <span key={i}>{s.text}</span>
            ),
          )}
          {/* Trailing newline produces no visible line in a div; pad so the
              textarea's extra blank line is mirrored for height parity. */}
          {value.endsWith("\n") ? " " : ""}
        </div>
        {/* Input layer: transparent text, visible caret, on top. */}
        <textarea
          ref={inner}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={() => {
            if (mirrorRef.current && inner.current) {
              mirrorRef.current.scrollTop = inner.current.scrollTop;
              mirrorRef.current.scrollLeft = inner.current.scrollLeft;
            }
          }}
          spellCheck={false}
          {...textareaProps}
          className={`relative block w-full resize-none bg-transparent text-transparent caret-zinc-800 selection:bg-blue-500/25 placeholder:text-zinc-400 focus:outline-none dark:caret-zinc-100 dark:placeholder:text-zinc-500 ${BOX}`}
        />
      </div>
    );
  },
);
