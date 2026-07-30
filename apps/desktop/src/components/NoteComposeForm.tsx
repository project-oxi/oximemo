/**
 * Shared note compose panel. Body is a `MirrorTagEditor` (inline `#tag` chips);
 * the bottom strip is color swatches + confirm only — the tag input is gone
 * because tags are derived from the body (§4.1).
 */
import { type Ref, type TextareaHTMLAttributes } from "react";
import { Check } from "lucide-react";

import { MirrorTagEditor } from "./MirrorTagEditor";
import { ColorSwatches } from "./ColorPicker";

const cx = (...xs: (string | false | null | undefined)[]) =>
  xs.filter(Boolean).join(" ");

export interface NoteComposeFormProps {
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
  /** Primary action — "save" in capture, "done" in the editor. */
  onConfirm: () => void;
  confirmLabel: string;
  confirmDisabled?: boolean;
  /** Keyboard hint rendered left of the confirm button (e.g. "↵", "⌘⏎"). */
  confirmKbd?: string;
  className?: string;
}

export function NoteComposeForm({
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
}: NoteComposeFormProps) {
  return (
    <div className={cx("flex flex-1 flex-col gap-2.5", className)}>
      <MirrorTagEditor
        ref={bodyRef}
        value={body}
        onChange={onBodyChange}
        textareaProps={bodyProps}
        className={cx("min-h-0 flex-1", bodyClassName)}
      />
      <div className="flex flex-wrap items-center gap-2.5">
        <ColorSwatches value={color} onChange={onColorChange} />
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirmDisabled}
          aria-label={confirmLabel}
          title={confirmLabel}
          className="group inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-2 text-white shadow-sm transition-all hover:bg-zinc-800 active:scale-95 disabled:pointer-events-none disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
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
