/** App entry: provider chain + the main window shell. */

import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTodayKey } from "../lib/relativeDay";
import { Bot, Terminal, X } from "lucide-react";
import { isRouteCapture } from "../lib/window";
import { listFolders, getConfig, setFolderPinned } from "../lib/api";
import { useSchemaInfo } from "../lib/folders";
import { COLLECTION_CATALOG } from "../lib/collectionCatalog";

import { CardGrid } from "./CardGrid";
import { CopilotPanel } from "./CopilotPanel";
import { CaptureOverlay } from "./CaptureOverlay";
import { ErrorToast } from "./ErrorBoundary";
import { TaskQuickAdd } from "./TaskQuickAdd";
import { Toast } from "./Toast";
import { useUI } from "../stores/ui";
import { applyTheme, saveTheme } from "../lib/theme";
import { useI18n } from "../lib/i18n";
import { cliStatus, copilotStatus, installCli } from "../lib/api";
import { checkForUpdate } from "../lib/updater";

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
  const copilotOpen = useUI((s) => s.copilotOpen);
  const theme = useUI((s) => s.theme);
  const setUpdateAvailable = useUI((s) => s.setUpdateAvailable);
  const setToast = useUI((s) => s.setToast);
  const { t } = useI18n();

  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

  // Auto-check for updates on launch (Tauri shell only). Badges the settings
  // gear and toasts once per new version.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const DISMISS_KEY = "oximemo.updateToast";
    void checkForUpdate().then((u) => {
      if (!u) return;
      setUpdateAvailable(u.version);
      if (window.localStorage.getItem(DISMISS_KEY) !== u.version) {
        window.localStorage.setItem(DISMISS_KEY, u.version);
        setToast(t.update_toast.replace("{v}", u.version));
      }
    });
  }, [setUpdateAvailable, setToast, t]);
  return (
    <>
      <CardGrid />
      {copilotOpen && <CopilotPanel />}
      <CopilotFab />
      <CollectionAutopin />
      <MidnightRefresh />
      <CliNudge />
      <ErrorToast />
      <TaskQuickAdd />
      <Toast />
    </>
  );
}

/**
 * Midnight refresh (tasks spec §7.0 consumer; Plan E Task 4): when the
 * local-midnight store rolls the day key, base views (task lists, the
 * daily query fence's server-side relative math) and the open note —
 * typically today's daily — refetch, so the app crosses days without a
 * restart. The mount pass only records the baseline: refreshing at
 * launch is what the query cache's staleness already does.
 */
function MidnightRefresh() {
  const todayKey = useTodayKey();
  const qc = useQueryClient();
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (seen.current === null) {
      seen.current = todayKey;
      return;
    }
    if (seen.current === todayKey) return;
    seen.current = todayKey;
    void qc.invalidateQueries({ queryKey: ["base"] });
    void qc.invalidateQueries({ queryKey: ["memo"] });
  }, [todayKey, qc]);
  return null;
}

/**
 * Bottom-right floating action button (Notion-style) — the copilot's
 * always-visible entry point. Sits ABOVE the note dialog (z-[70] vs the
 * dialog's z-50) so the copilot stays reachable while a note is open;
 * hidden while the window is open, and entirely when no agent is
 * activated (spec §6.5: no nudge, no dead buttons).
 */
function CopilotFab() {
  const { t } = useI18n();
  const copilotOpen = useUI((s) => s.copilotOpen);
  const setCopilotOpen = useUI((s) => s.setCopilotOpen);
  const status = useQuery({ queryKey: ["copilot-status"], queryFn: copilotStatus });
  const visible = (status.data?.enabled ?? false) && (status.data?.activated ?? false);
  if (!visible || copilotOpen) return null;
  return (
    <button
      type="button"
      aria-label={t.copilot_fab}
      title={t.copilot_fab}
      onClick={() => setCopilotOpen(true)}
      className="fixed bottom-6 right-6 z-[70] flex h-11 w-11 items-center justify-center rounded-full border border-line bg-interactive-primary text-interactive-primary-foreground shadow-lg transition-transform duration-150 hover:scale-105 active:scale-95"
    >
      <Bot size={18} />
    </button>
  );
}


/**
 * One-shot migration (2026-08-23): collections installed before install-time
 * auto-pinning landed (user report — installed collections never showed in
 * the sidebar's 즐겨찾기 section) get pinned once. Runs after every folder schema
 * settles, pins unpinned collection presets, then marks itself done; a later
 * deliberate unpin is respected forever after.
 */
function CollectionAutopin() {
  const qc = useQueryClient();
  const foldersQ = useQuery({ queryKey: ["folders"], queryFn: listFolders });
  const configQ = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const schemas = useSchemaInfo((foldersQ.data ?? []).map((f) => f.path));

  useEffect(() => {
    const MKEY = "oximemo.collectionAutopin.v1";
    if (window.localStorage.getItem(MKEY)) return;
    const folders = foldersQ.data;
    const config = configQ.data;
    if (!folders || !config) return;
    // useSchemaInfo yields {} until every per-folder query settles — wait so
    // this single pass sees all installed collections at once.
    if (folders.length > 0 && Object.keys(schemas).length < folders.length) return;
    const ids = new Set(COLLECTION_CATALOG.map((c) => c.id));
    const pinned = new Set(
      (config.folders ?? []).filter((f) => f.pinned).map((f) => f.path),
    );
    const targets = folders.filter(
      (f) => ids.has(schemas[f.path]?.meta?.preset ?? "") && !pinned.has(f.path),
    );
    window.localStorage.setItem(MKEY, "1");
    if (targets.length === 0) return;
    void Promise.all(targets.map((f) => setFolderPinned(f.path, true)))
      .then(() => qc.invalidateQueries({ queryKey: ["config"] }))
      .catch(() => {
        // Pinning is presentation-only; a failure just leaves the
        // pre-migration sidebar (the user can pin manually).
      });
  }, [foldersQ.data, configQ.data, schemas, qc]);
  return null;
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
