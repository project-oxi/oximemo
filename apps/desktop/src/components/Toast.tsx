/**
 * Neutral toast for operational feedback (reindex done, vault healthy, path
 * copied). Errors keep their red `ErrorToast` in ErrorBoundary; this one is
 * the quiet "that worked" signal.
 */
import { useEffect } from "react";

import { useUI } from "../stores/ui";

export function Toast() {
  const toast = useUI((s) => s.toast);
  const setToast = useUI((s) => s.setToast);

  useEffect(() => {
    if (!toast) return;
    const h = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(h);
  }, [toast, setToast]);

  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-10 z-50 flex justify-center px-4">
      <div className="pointer-events-auto animate-toast-in rounded-full border border-line bg-surface-raised px-4 py-2 text-xs font-medium text-text shadow-lg backdrop-blur">
        {toast}
      </div>
    </div>
  );
}
