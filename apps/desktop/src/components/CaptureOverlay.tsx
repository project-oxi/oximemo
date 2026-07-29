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
import { useUI } from "../stores/ui";
import { NoteComposeForm } from "./NoteComposeForm";
import { ErrorToast } from "./ErrorBoundary";

export function CaptureOverlay() {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [color, setColor] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const setError = useUI((s) => s.setError);

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
    } catch (e) {
      // Keep the text so the user can retry; surface the failure (H4).
      setError(String(e).split("\n")[0]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative isolate flex h-screen w-full flex-col rounded-2xl border border-zinc-200 bg-white/95 p-3 shadow-2xl backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95">
      {color && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 rounded-2xl opacity-25 dark:opacity-35"
          style={{ background: color }}
        />
      )}
      <NoteComposeForm
        body={value}
        onBodyChange={setValue}
        bodyRef={ref}
        bodyProps={{
          placeholder: t.capture_placeholder,
          rows: 2,
          onKeyDown: onKey,
        }}
        tags={tags}
        onTagsChange={setTags}
        color={color}
        onColorChange={setColor}
        onConfirm={save}
        confirmLabel={t.capture_save}
        confirmDisabled={busy || value.trim().length === 0}
        confirmKbd="↵"
      />
      <ErrorToast />
    </div>
  );
}
