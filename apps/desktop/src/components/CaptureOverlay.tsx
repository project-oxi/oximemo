/**
 * Capture overlay (§6.3). Lives in the `capture` window: off-screen by
 * default, parked there to keep the NSWindow warm. On `capture:show` the
 * Rust side moves the window near the cursor and focuses it. The user
 * types, presses Enter to save (Shift+Enter for newline), or Esc to close.
 */
import { useEffect, useRef, useState } from "react";

import { createNote } from "../lib/api";
import { paperFor } from "../lib/color";
import { listen } from "../lib/tauri";
import { useI18n } from "../lib/i18n";
import { closeCurrentWindow, showCurrentWindow } from "../lib/window";
import { useUI } from "../stores/ui";
import { QuickCaptureForm } from "./QuickCaptureForm";
import { ErrorToast } from "./ErrorBoundary";

export function CaptureOverlay() {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [color, setColor] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const setError = useUI((s) => s.setError);
  const savingRef = useRef(false);

  useEffect(() => {
    void listen("capture:show", () => {
      setValue("");
      setColor("");
      setBusy(false);
      savingRef.current = false;
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
    if (savingRef.current) return;
    const body = value.trim();
    if (!body) return;
    savingRef.current = true;
    setBusy(true);
    try {
      // Dismiss optimistically: the capture window is parked (hidden, not
      // destroyed), so hide it the instant the user confirms and let the
      // write finish behind the curtain. The note surfaces in the grid via
      // the watcher's `notes:changed` broadcast. We deliberately do NOT
      // reset form state on success — `capture:show` owns that, which also
      // avoids wiping text if the user re-captures mid-write.
      await closeCurrentWindow();
      await createNote(body, color || null);
    } catch (e) {
      // Surface the failure (H4) and restore the window with the text
      // intact so the user can fix and retry — the write didn't land.
      setError(String(e).split("\n")[0]);
      await showCurrentWindow();
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="relative isolate flex h-screen w-full flex-col rounded-2xl border border-zinc-200 bg-white/95 p-3 shadow-2xl backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95">
      {color && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 rounded-2xl"
          style={{ backgroundColor: paperFor(color) }}
        />
      )}
      <QuickCaptureForm
        body={value}
        onBodyChange={setValue}
        bodyRef={ref}
        bodyProps={{
          placeholder: t.capture_placeholder,
          rows: 2,
          onKeyDown: onKey,
        }}
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
