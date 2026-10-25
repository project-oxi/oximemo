/**
 * Neutral toast for operational feedback (reindex done, vault healthy, path
 * copied). Errors keep their red `ErrorToast` in ErrorBoundary; this one is
 * the quiet "that worked" signal. An optional inline `action` (e.g. the
 * 실행 취소 undo after a folder delete) renders as a text button right of
 * the message and extends the auto-dismiss window so it is clickable.
 */
import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";

import { useWorkspaceMotion } from "../lib/workspaceMotion";
import { useUI } from "../stores/ui";

const DISMISS_MS = 2600;
/** Undo-sized window: enough time to read the message and click. */
const ACTION_DISMISS_MS = 8000;

export function Toast() {
  const toast = useUI((s) => s.toast);
  const setToast = useUI((s) => s.setToast);
  const timing = useWorkspaceMotion();

  useEffect(() => {
    if (!toast) return;
    const h = window.setTimeout(
      () => setToast(null),
      toast.action ? ACTION_DISMISS_MS : DISMISS_MS,
    );
    return () => window.clearTimeout(h);
  }, [toast, setToast]);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-10 z-[85] flex justify-center px-4">
      {/* App mount ≠ toast mount; every toast appearance animates in. */}
      <AnimatePresence>
        {toast && (
          <motion.div
            role="status"
            initial={{ opacity: 0, y: timing.reduce ? 0 : 8 }}
            animate={{ opacity: 1, y: 0, transition: timing.enter }}
            exit={{ opacity: 0, y: timing.reduce ? 0 : 4, transition: timing.exit }}
            className="glass-toast pointer-events-auto flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-text"
          >
            <span>{toast.msg}</span>
            {toast.action && (
              <button
                type="button"
                className="rounded-sm text-hue-blue hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                onClick={(e) => {
                  e.stopPropagation();
                  setToast(null);
                  toast.action?.onClick();
                }}
              >
                {toast.action.label}
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
