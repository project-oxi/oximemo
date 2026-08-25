/**
 * Capture overlay (§6.3). Lives in the `capture` window: off-screen by
 * default, parked there to keep the NSWindow warm. On `capture:show` the
 * Rust side anchors the window to the bottom-center of the monitor. The
 * user types, presses Enter to save (Shift+Enter for newline), or Esc to
 * close. The NSWindow is fixed at 560×200 and transparent outside the
 * rounded card, which sits at the bottom edge and tracks its content height.
 */
import { useEffect, useRef, useState } from "react";

import { createCapture } from "../lib/api";
import { listen } from "../lib/tauri";
import { useI18n } from "../lib/i18n";
import { closeCurrentWindow, showCurrentWindow } from "../lib/window";
import { useUI } from "../stores/ui";
import { QuickCaptureForm } from "./QuickCaptureForm";
import { ErrorToast } from "./ErrorBoundary";

export function CaptureOverlay() {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const setError = useUI((s) => s.setError);
  const savingRef = useRef(false);

  useEffect(() => {
    void listen("capture:show", () => {
      setValue("");
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
    try {
      await closeCurrentWindow();
      await createCapture(body);
    } catch (e) {
      setError(String(e).split("\n")[0]);
      await showCurrentWindow();
    } finally {
      savingRef.current = false;
    }
  }

  return (
    <div className="relative isolate flex h-screen w-full items-end justify-center p-2">
      <QuickCaptureForm
        body={value}
        onBodyChange={setValue}
        bodyRef={ref}
        bodyProps={{
          placeholder: t.capture_placeholder,
          onKeyDown: onKey,
        }}
        hint={`↵ ${t.capture_save} · esc ${t.close}`}
      />
      <ErrorToast />
    </div>
  );
}
