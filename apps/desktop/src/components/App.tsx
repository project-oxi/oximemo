/** App entry: provider chain + the main window shell. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Terminal, X } from "lucide-react";
import { isRouteCapture } from "../lib/window";

import { CardGrid } from "./CardGrid";
import { CaptureOverlay } from "./CaptureOverlay";
import { ErrorToast } from "./ErrorBoundary";
import { Toast } from "./Toast";
import { useUI } from "../stores/ui";
import { applyTheme, saveTheme } from "../lib/theme";
import { useI18n } from "../lib/i18n";
import { cliStatus, installCli } from "../lib/api";

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false } },
});

export function App() {
  if (isRouteCapture()) {
    return <CaptureOverlay />;
  }


  return (
    <QueryClientProvider client={qc}>
      <Shell />
    </QueryClientProvider>
  );
}

function Shell() {
  const theme = useUI((s) => s.theme);
  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);
  return (
    <>
      <CardGrid />
      <CliNudge />
      <ErrorToast />
      <Toast />
    </>
  );
}

/**
 * One-time banner nudging the user to expose the bundled `oximemo` CLI on
 * PATH. Hidden once dismissed (localStorage) or once installed. Only in the
 * real Tauri shell — never in browser/dev mode.
 */
function CliNudge() {
  const { t } = useI18n();
  const setToast = useUI((s) => s.setToast);
  const setError = useUI((s) => s.setError);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  const inTauri = "__TAURI_INTERNALS__" in window;
  const DISMISS_KEY = "oximemo.cliNudgeDismissed";

  useEffect(() => {
    if (!inTauri) return;
    if (window.localStorage.getItem(DISMISS_KEY) === "1") return;
    cliStatus()
      .then((s) => setShow(s !== "installed"))
      .catch(() => {});
  }, [inTauri]);

  const install = () => {
    setBusy(true);
    installCli()
      .then(() => {
        setShow(false);
        setToast(t.cli_install_done);
      })
      .catch(() => setError(t.cli_install_failed))
      .finally(() => setBusy(false));
  };

  const dismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, "1");
    setShow(false);
  };

  if (!show) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-30 flex justify-center px-4">
      <div className="pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-2.5 shadow-lg">
        <Terminal size={15} className="mt-0.5 shrink-0 text-text-muted" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-text">{t.cli_nudge_title}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-text-subtle">
            {t.cli_nudge_body}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={install}
            disabled={busy}
            className="rounded-lg bg-interactive-primary px-2.5 py-1 text-xs font-medium text-interactive-primary-foreground transition-colors hover:bg-interactive-primary/90 disabled:opacity-50"
          >
            {busy ? "…" : t.cli_nudge_install}
          </button>
          <button
            type="button"
            onClick={dismiss}
            aria-label={t.cli_nudge_dismiss}
            className="rounded-lg p-1 text-text-subtle transition-colors hover:bg-surface-muted hover:text-text-muted"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
