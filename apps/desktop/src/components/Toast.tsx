/**
 * Neutral toast for operational feedback (reindex done, vault healthy, path
 * copied). Errors keep their red `ErrorToast` in ErrorBoundary; this one is
 * the quiet "that worked" signal. An optional inline `action` (e.g. the
 * 실행 취소 undo after a folder delete) renders as a text button right of
 * the message and extends the auto-dismiss window so it is clickable.
 */
import { useEffect } from "react";

import { useUI } from "../stores/ui";

const DISMISS_MS = 2600;
/** Undo-sized window: enough time to read the message and click. */
const ACTION_DISMISS_MS = 8000;

export function Toast() {
  const toast = useUI((s) => s.toast);
  const setToast = useUI((s) => s.setToast);

  useEffect(() => {
    if (!toast) return;
    const h = window.setTimeout(
      () => setToast(null),
      toast.action ? ACTION_DISMISS_MS : DISMISS_MS,
    );
    return () => window.clearTimeout(h);
  }, [toast, setToast]);

  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-10 z-50 flex justify-center px-4">
      <div className="pointer-events-auto animate-toast-in flex items-center gap-2 rounded-full border border-line bg-surface-raised px-4 py-2 text-xs font-medium text-text shadow-lg backdrop-blur">
        <span>{toast.msg}</span>
        {toast.action && (
          <button
            type="button"
            className="text-hue-blue hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              setToast(null);
              toast.action?.onClick();
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
    </div>
  );
}
