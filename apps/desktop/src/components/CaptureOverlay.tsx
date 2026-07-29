/**
 * Capture overlay (§6.3). Lives in the `capture` window: off-screen by
 * default, parked there to keep the NSWindow warm. On `capture:show` the
 * Rust side moves the window near the cursor and focuses it. The user
 * types, presses Enter to save (Shift+Enter for newline), or Esc to close.
 */
import { useEffect, useRef, useState } from "react";

import { createNote } from "../lib/api";
import { COLOR_PRESETS, presetToString } from "../lib/color";
import { listen } from "../lib/tauri";
import { useI18n } from "../lib/i18n";
import { closeCurrentWindow } from "../lib/window";
import { TagInput } from "./TagInput";

export function CaptureOverlay() {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [color, setColor] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void listen("capture:show", () => {
      setValue("");
      setTags([]);
      setColor("");
      setBusy(false);
      // Focus the textarea after the window is brought forward.
      window.setTimeout(() => ref.current?.focus(), 30);
    });
  }, []);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      void closeCurrentWindow();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void save();
    }
  };

  async function save() {
    const body = value.trim();
    if (!body) return;
    setBusy(true);
    try {
      await createNote(body, tags, color || null);
      await closeCurrentWindow();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen w-full flex-col rounded-2xl border border-zinc-200 bg-white/95 p-3 shadow-2xl backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        placeholder={t.capture_placeholder}
        rows={2}
        className="w-full flex-1 resize-none bg-transparent text-sm leading-relaxed text-zinc-800 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100"
      />
      <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-400">
        <div className="min-w-0 flex-1">
          <TagInput
            tags={tags}
            onChange={setTags}
            placeholder="tag…"
          />
        </div>
        <button
          type="button"
          aria-label="no color"
          onClick={() => setColor("")}
          className={`grid h-5 w-5 place-items-center rounded-full border text-zinc-400 ${
            color === ""
              ? "border-zinc-500 ring-2 ring-zinc-400 dark:border-zinc-400"
              : "border-dashed border-zinc-300 dark:border-zinc-600"
          }`}
          title="—"
        >
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
            <line x1="2" y1="10" x2="10" y2="2" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        {COLOR_PRESETS.map((p) => {
          const s = presetToString(p);
          const active = color === s;
          return (
            <button
              key={p.id}
              type="button"
              aria-label={p.id}
              onClick={() => setColor(s)}
              style={{ background: s }}
              className={`h-5 w-5 rounded-full border border-black/10 dark:border-white/10 ${
                active ? "ring-2 ring-zinc-400" : ""
              }`}
            />
          );
        })}
      </div>
      <div className="mt-1 flex items-center justify-end gap-2 text-[10px] text-zinc-400">
        <span>Enter = {t.capture_save}</span>
        <span>·</span>
        <span>Esc = {t.capture_cancel}</span>
        <button
          type="button"
          onClick={save}
          disabled={busy || value.trim().length === 0}
          className="ml-2 rounded-full bg-zinc-900 px-3 py-1 text-[10px] font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {t.capture_save}
        </button>
      </div>
    </div>
  );
}
