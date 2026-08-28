/**
 * ⌘⇧T task quick add (spec §9, Plan E Task 3): a minimal single-line
 * spotlight over the main window, reusing the capture overlay's input
 * chrome (`QuickCaptureForm`). Enter routes through `addTask` to the
 * `[tasks] capture_target` destination (daily note for today, or the
 * fixed inbox note); the typed line splits into description + fields
 * via the taskLine mirror (`물 마시기 🔁 every day` quick-adds a task
 * whose recurrence is a real field). A recurring task landing in a
 * daily note toasts the §9 anti-pattern warning — advisory, never
 * blocking.
 *
 * Also the toast relay for the capture overlay's `/할일` path: the
 * overlay window closes itself before its `add_task` resolves, so it
 * broadcasts `task:daily-recurrence-warning` and THIS window (where
 * the user is looking) shows the toast.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { addTask, getConfig } from "../lib/api";
import { todayLocalISO } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import {
  buildQuickAddTarget,
  DAILY_RECURRENCE_WARNING_EVENT,
  lineCfgFromTasks,
  parseQuickAddInput,
  quickAddTarget,
  shouldWarnDailyRecurrence,
} from "../lib/quickAdd";
import { listen } from "../lib/tauri";
import { useUI } from "../stores/ui";
import { QuickCaptureForm } from "./QuickCaptureForm";

export function TaskQuickAdd() {
  const open = useUI((s) => s.quickAddOpen);
  const setOpen = useUI((s) => s.setQuickAddOpen);
  const setToast = useUI((s) => s.setToast);
  const setError = useUI((s) => s.setError);
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const savingRef = useRef(false);
  const qc = useQueryClient();
  const configQ = useQuery({ queryKey: ["config"], queryFn: getConfig });

  // Overlay-relayed warning (see DAILY_RECURRENCE_WARNING_EVENT). The
  // listener outlives the input: the overlay can add a task any time.
  useEffect(() => {
    let un: (() => void) | undefined;
    void listen(DAILY_RECURRENCE_WARNING_EVENT, () => {
      setToast(t.task_daily_recurrence_warning);
    }).then((u) => {
      un = u;
    });
    return () => un?.();
  }, [setToast, t]);

  // Fresh input + focus each time the spotlight opens (mirrors the
  // capture overlay's capture:show focus nudge).
  useEffect(() => {
    if (!open) return;
    setValue("");
    window.setTimeout(() => ref.current?.focus(), 30);
  }, [open]);

  if (!open) return null;

  async function submit() {
    if (savingRef.current) return;
    const body = value.trim();
    if (!body) {
      setOpen(false);
      return;
    }
    savingRef.current = true;
    try {
      const tasks = configQ.data?.tasks;
      const lineCfg = lineCfgFromTasks(tasks);
      const { text, fields } = parseQuickAddInput(body, lineCfg);
      const today = todayLocalISO();
      const target = buildQuickAddTarget(quickAddTarget(tasks), today);
      const result = await addTask(target, text, fields, today);
      // Task lists are ["base"] queries; memos:changed (Rust) covers the
      // note surfaces already.
      void qc.invalidateQueries({ queryKey: ["base"] });
      if (result.daily_recurrence_warning && shouldWarnDailyRecurrence(target, fields)) {
        setToast(t.task_daily_recurrence_warning);
      }
      setOpen(false);
    } catch (e) {
      // Keep the input open with the text intact — retry after reading
      // the error toast (same contract as the overlay's failed save).
      setError(String(e).split("\n")[0]);
    } finally {
      savingRef.current = false;
    }
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Enter") {
      // IME: Enter during composition must never submit (CJK bug; the
      // same guard CopilotComposer/CommandPalette use).
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      // Single-line by contract: Enter always submits (shift too).
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/25 pt-[18vh] backdrop-blur-[1px]"
      onPointerDown={() => setOpen(false)}
    >
      <div className="w-[560px] max-w-[calc(100vw-2rem)]" onPointerDown={(e) => e.stopPropagation()}>
        <QuickCaptureForm
          body={value}
          onBodyChange={setValue}
          bodyRef={ref}
          bodyProps={{
            placeholder: t.task_quick_add_placeholder,
            onKeyDown: onKey,
          }}
          hint={`↵ ${t.capture_save} · esc ${t.close}`}
        />
      </div>
    </div>
  );
}
