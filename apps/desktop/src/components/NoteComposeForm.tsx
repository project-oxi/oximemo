/**
 * Shared note compose panel (§6.3 / §7.3). Both the capture overlay and the
 * note detail editor drive the SAME layout: a body textarea plus a single
 * unified bottom strip that flows tags → color swatches → confirm action on
 * one borderless line, with the OKLCH sliders (if any) expanding to full
 * width below it. Hosts own their own state + save/close semantics and pass
 * them down; only the layout is shared.
 *
 * TagInput has a `min-w` floor so that in the narrow capture window it wraps
 * onto its own full-width line rather than being squeezed by the swatches +
 * action; in the wide editor the three groups sit on a single line.
 */
import { type Ref, type TextareaHTMLAttributes } from "react";
import { Check } from "lucide-react";

import { TagInput } from "./TagInput";
import { ColorSwatches } from "./ColorPicker";

const cx = (...xs: (string | false | null | undefined)[]) =>
  xs.filter(Boolean).join(" ");

export interface NoteComposeFormProps {
  body: string;
  onBodyChange: (v: string) => void;
  /** Forwarded to the textarea (focus control, Esc/Enter handling in capture). */
  bodyRef?: Ref<HTMLTextAreaElement>;
  bodyProps?: Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "value" | "onChange"
  >;
  /** Extra textarea classes (e.g. a `min-h` floor in the editor). */
  bodyClassName?: string;
  tags: string[];
  onTagsChange: (t: string[]) => void;
  tagPlaceholder?: string;
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
  tags,
  onTagsChange,
  tagPlaceholder = "tag…",
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
      <textarea
        ref={bodyRef}
        value={body}
        onChange={(e) => onBodyChange(e.target.value)}
        {...bodyProps}
        className={cx(
          "min-h-0 flex-1 resize-none bg-transparent text-sm leading-relaxed text-zinc-800 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100",
          bodyClassName,
        )}
      />
      <div className="flex flex-wrap items-center gap-2.5">
        <TagInput
          tags={tags}
          onChange={onTagsChange}
          placeholder={tagPlaceholder}
          className="min-w-[180px] flex-1"
        />
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
