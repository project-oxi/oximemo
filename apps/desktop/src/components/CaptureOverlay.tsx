/**
 * Capture overlay (§6.3). Lives in the `capture` window: off-screen by
 * default, parked there to keep the NSWindow warm. On `capture:show` the
 * Rust side anchors the window to the bottom-center of the monitor. The
 * user types, presses Enter to save (Shift+Enter for newline), or Esc to
 * close. The NSWindow is fixed at 560×200 and transparent outside the
 * rounded card, which sits at the bottom edge and tracks its content height.
 */
import { useEffect, useRef, useState } from "react";

import { addTask, createCapture, getConfig } from "../lib/api";
import { todayLocalISO } from "../lib/dates";
import {
  buildQuickAddTarget,
  DAILY_RECURRENCE_WARNING_EVENT,
  lineCfgFromTasks,
  overlaySlashRoute,
  parseQuickAddInput,
  quickAddTarget,
  shouldWarnDailyRecurrence,
} from "../lib/quickAdd";
import { emit, listen } from "../lib/tauri";
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
      // `/할일 …` routes through the same quick-add path as ⌘⇧T (spec
      // §9): target = `[tasks] capture_target`, structured fields from
      // the taskLine mirror. Everything else stays an inbox capture.
      const routed = overlaySlashRoute(body);
      if (routed) {
        // Bare `/할일` with no text: nothing to add — the window is
        // already hidden; `finally` releases the save lock.
        if (!routed.rest) return;
        const tasks = (await getConfig()).tasks;
        const { text, fields } = parseQuickAddInput(routed.rest, lineCfgFromTasks(tasks));
        const today = todayLocalISO();
        const target = buildQuickAddTarget(quickAddTarget(tasks), today);
        const result = await addTask(target, text, fields, today);
        if (result.daily_recurrence_warning && shouldWarnDailyRecurrence(target, fields)) {
          // This window is already hidden — relay the §9 warning toast
          // to the main window, which owns the visible toast surface.
          await emit(DAILY_RECURRENCE_WARNING_EVENT);
        }
      } else {
        await createCapture(body);
      }
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
