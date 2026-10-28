/**
 * Windows caption buttons (minimize · maximize/restore · close). The main
 * window is undecorated on Windows (lib.rs) so the app's own title bar can
 * run edge to edge like the macOS overlay; these buttons replace the native
 * frame's. They float above every overlay (memo sheet, settings) the way the
 * macOS traffic lights do, and each surface's header reserves their width
 * (liquid-glass.css «Window chrome»). Close goes through `CloseRequested`,
 * which hides the window instead of destroying it — same as the tray.
 */
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useI18n } from "../lib/i18n";

export function WindowControls() {
  const { t } = useI18n();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let alive = true;
    const sync = () => void win.isMaximized().then((m) => { if (alive) setMaximized(m); });
    sync();
    // Snap, double-click on a drag region and Win+↑ all maximize without
    // passing through these buttons; resize is the one event they share.
    const unlisten = win.onResized(sync);
    return () => {
      alive = false;
      void unlisten.then((off) => off());
    };
  }, []);

  const win = getCurrentWindow();
  return (
    <div className="window-controls" data-tauri-drag-region={false}>
      <button type="button" tabIndex={-1} aria-label={t.window_minimize} title={t.window_minimize} onClick={() => void win.minimize()}>
        <svg viewBox="0 0 10 10" aria-hidden><path d="M0 5.5h10" /></svg>
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label={maximized ? t.window_restore : t.window_maximize}
        title={maximized ? t.window_restore : t.window_maximize}
        onClick={() => void win.toggleMaximize()}
      >
        {maximized ? (
          <svg viewBox="0 0 10 10" aria-hidden><path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" /><rect x="0.5" y="2.5" width="7" height="7" rx="1" /></svg>
        ) : (
          <svg viewBox="0 0 10 10" aria-hidden><rect x="0.5" y="0.5" width="9" height="9" rx="1" /></svg>
        )}
      </button>
      <button type="button" tabIndex={-1} className="window-control-close" aria-label={t.close} title={t.close} onClick={() => void win.close()}>
        <svg viewBox="0 0 10 10" aria-hidden><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></svg>
      </button>
    </div>
  );
}
