/**
 * Capture overlay (§6.3). Lives in the `capture` window: off-screen by
 * default, parked there to keep the NSWindow warm. On `capture:show` the
 * Rust side moves the window near the cursor and focuses it. The user
 * types, presses Enter to save (Shift+Enter for newline), or Esc to close.
 */
import { useEffect, useRef, useState } from "react";

import { createNote } from "../lib/api";
import { listen } from "../lib/tauri";
import { useI18n } from "../lib/i18n";
import { closeCurrentWindow } from "../lib/window";

export function CaptureOverlay() {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void listen("capture:show", () => {
      setValue("");
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
      await createNote(body, [], null);
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
        rows={3}
        className="w-full flex-1 resize-none bg-transparent text-sm leading-relaxed text-zinc-800 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100"
      />
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
