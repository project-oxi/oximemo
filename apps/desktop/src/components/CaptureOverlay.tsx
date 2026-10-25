/**
 * Capture overlay (§6.3). Lives in the `capture` window: off-screen by
 * default, parked there to keep the NSWindow warm. On `capture:show` the
 * Rust side anchors the window to the bottom-center of the monitor. The
 * user types, presses Enter to save (Shift+Enter for newline), or Esc to
 * close. Saving replaces the composer with a receipt; only its Open action
 * brings the saved note to the main window.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@garden/ui";
import { X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

import { addTask, createCapture, getConfig } from "../lib/api";
import { todayLocalISO } from "../lib/dates";
import { isComposingKey } from "../lib/editorKeys";
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
import { completeCapture, dismissCapture, finishCaptureDismissal, holdCaptureReceipt, isNativeWindow, openCapturedNote } from "../lib/window";
import { useUI } from "../stores/ui";
import { QuickCaptureForm } from "./QuickCaptureForm";
import { ErrorToast } from "./ErrorBoundary";

export function CaptureOverlay() {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const setError = useUI((s) => s.setError);
  const savingRef = useRef(false);
  const generation = useRef(0);
  const [receipt, setReceipt] = useState<{ id: string; shortcut: boolean } | null>(null);
  const [hidden, setHidden] = useState(false);
  const [closing, setClosing] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);
  const closingGeneration = useRef<number | null>(null);
  const reduceMotion = useReducedMotion();
  const [holding, setHolding] = useState(false);
  const interaction = useRef({ pointer: false, focus: false });

  function holdReceipt(kind: "pointer" | "focus", active: boolean) {
    interaction.current[kind] = active;
    const hold = interaction.current.pointer || interaction.current.focus;
    setHolding(hold);
    void holdCaptureReceipt(generation.current, hold);
  }

  useEffect(() => {
    const show = listen<number>("capture:show", (session) => {
      generation.current = session;
      closingGeneration.current = null;
      setSessionKey(session);
      setClosing(false);
      setHidden(false);
      setReceipt(null);
      setHolding(false);
      interaction.current = { pointer: false, focus: false };
      setError(null);
      setValue("");
      // Focus the textarea after the window is brought forward.
      window.setTimeout(() => ref.current?.focus(), 30);
    });
    const close = listen<number>("capture:closing", (session) => {
      generation.current = session;
      closingGeneration.current = session;
      setClosing(true);
    });
    const hide = listen("capture:hide", () => {
      generation.current += 1;
      setHidden(true);
      setReceipt(null);
    });
    return () => {
      void show.then((unlisten) => unlisten());
      void close.then((unlisten) => unlisten());
      void hide.then((unlisten) => unlisten());
    };
  }, [setError]);

  useEffect(() => {
    if (!receipt || closing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isComposingKey(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        void dismissCapture(generation.current);
      } else if (event.key === "Enter" && event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey) {
        event.preventDefault();
        void openCapturedNote(receipt.id, generation.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [receipt, closing]);

  useEffect(() => {
    if (reduceMotion && closing && closingGeneration.current !== null) {
      void finishCaptureDismissal(closingGeneration.current);
    }
  }, [reduceMotion, closing]);

  // Browser preview has no native receipt timer or global shortcut host.
  useEffect(() => {
    if (isNativeWindow() || !receipt || holding || closing) return;
    const timer = window.setTimeout(() => void dismissCapture(generation.current), 5000);
    return () => window.clearTimeout(timer);
  }, [receipt, holding, closing]);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (closing || e.defaultPrevented || isComposingKey(e.nativeEvent)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      void dismissCapture(generation.current);
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
    const session = generation.current;
    let capturedId: string;
    try {
      // `/할일 …` routes through the same quick-add path as ⌘⇧T (spec
      // §9): target = `[tasks] capture_target`, structured fields from
      // the taskLine mirror. Everything else stays an inbox capture.
      const routed = overlaySlashRoute(body);
      if (routed) {
        // Bare `/할일` stays editable; there is no task to save yet.
        if (!routed.rest) return;
        const tasks = (await getConfig()).tasks;
        const { text, fields } = parseQuickAddInput(routed.rest, lineCfgFromTasks(tasks));
        const today = todayLocalISO();
        const target = buildQuickAddTarget(quickAddTarget(tasks), today);
        const result = await addTask(target, text, fields, today);
        capturedId = result.task.task_ref.memo_id;
        if (result.daily_recurrence_warning && shouldWarnDailyRecurrence(target, fields)) {
          void emit(DAILY_RECURRENCE_WARNING_EVENT).catch(console.error);
        }
      } else {
        capturedId = (await createCapture(body)).id;
      }
    } catch (e) {
      if (generation.current === session) setError(String(e).split("\n")[0]);
      return;
    } finally {
      savingRef.current = false;
    }
    if (generation.current !== session) return;
    setError(null);
    setReceipt({ id: capturedId, shortcut: false });
    // A feedback/shortcut failure must never turn a saved note into a retry
    // of the write. Keep the receipt's mouse action usable.
    try {
      const shortcut = await completeCapture(capturedId, session);
      if (generation.current === session) {
        setReceipt({ id: capturedId, shortcut });
        if (interaction.current.pointer || interaction.current.focus) {
          void holdCaptureReceipt(session, true);
        }
      }
    } catch (error) {
      console.error("capture feedback failed", error);
    }
  }

  if (hidden) return null;

  // Shared motion tokens: --dur-base / --dur-fast / --dur-exit and the
  // --ease-enter / --ease-exit curves. Keep the bottom edge anchored.
  const enter = {
    duration: reduceMotion ? 0 : 0.2,
    ease: [0.19, 1, 0.22, 1] as [number, number, number, number],
  };
  const leave = {
    duration: reduceMotion ? 0 : 0.1,
    ease: [0.8, 0, 0.4, 1] as [number, number, number, number],
  };

  return (
    <div className="relative isolate flex h-screen w-full items-end justify-center p-2">
      <motion.div
        key={sessionKey}
        layout={!reduceMotion}
        className="glass-capture capture-panel"
        data-state={closing ? "closing" : receipt ? "saved" : "composing"}
        style={{ width: receipt ? 360 : "100%", maxWidth: "100%", originX: 0.5, originY: 1 }}
        initial={{ opacity: 0, y: reduceMotion ? 0 : 12 }}
        animate={{ opacity: closing ? 0 : 1, y: closing && !reduceMotion ? 8 : 0 }}
        transition={{ ...(closing ? leave : enter), layout: enter }}
        onAnimationComplete={() => {
          if (closing && closingGeneration.current !== null) {
            void finishCaptureDismissal(closingGeneration.current);
          }
        }}
        inert={closing}
      >
        {receipt ? (
          <motion.div
            key="receipt"
            layout={reduceMotion ? false : "position"}
            initial={{ opacity: 0, y: reduceMotion ? 0 : 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...enter, duration: reduceMotion ? 0 : 0.15, delay: reduceMotion ? 0 : 0.04 }}
            role="status"
            className="capture-receipt flex w-full items-center gap-3 px-4 py-3 text-sm text-text"
            onPointerEnter={() => holdReceipt("pointer", true)}
            onPointerLeave={() => holdReceipt("pointer", false)}
            onFocus={() => holdReceipt("focus", true)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                holdReceipt("focus", false);
              }
            }}
          >
            <motion.span
              className="capture-success-mark"
              initial={{ scale: reduceMotion ? 1 : 0.9 }}
              animate={{ scale: 1 }}
              transition={enter}
              aria-hidden="true"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <motion.path d="m5 12 4 4 10-10" initial={{ pathLength: reduceMotion ? 1 : 0 }} animate={{ pathLength: 1 }} transition={enter} />
              </svg>
            </motion.span>
            <span className="flex-1">{t.capture_done}</span>
            <Button variant="ghost" aria-keyshortcuts={receipt.shortcut ? "Meta+Enter" : undefined} onClick={() => void openCapturedNote(receipt.id, generation.current)}>
              {t.capture_open}
              {receipt.shortcut && <kbd className="font-mono text-xs text-text-subtle">⌘↵</kbd>}
            </Button>
            <Button variant="ghost" size="icon" aria-label={t.close} onClick={() => void dismissCapture(generation.current)}>
              <X size={14} aria-hidden="true" />
            </Button>
          </motion.div>
        ) : (
          <motion.div
            key="composer"
            layout={reduceMotion ? false : "position"}
            className="w-full"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={enter}
          >
            <QuickCaptureForm
              embedded
              className="capture-form"
              body={value}
              onBodyChange={setValue}
              bodyRef={ref}
              bodyProps={{
                placeholder: t.capture_placeholder,
                "aria-label": t.capture_placeholder,
                onKeyDown: onKey,
              }}
              hint={`↵ ${t.capture_save} · esc ${t.close}`}
            />
          </motion.div>
        )}
      </motion.div>
      <ErrorToast />
    </div>
  );
}
