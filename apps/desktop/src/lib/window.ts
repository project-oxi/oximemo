/**
 * Window-level helpers.
 *
 * `isRouteCapture` distinguishes the two Tauri windows by URL path:
 * `/capture` is the overlay window, everything else renders the main grid.
 * `closeCurrentWindow` hides the current Tauri window from the renderer.
 */
import {
  currentMonitor,
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";

export function isRouteCapture(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.pathname.startsWith("/capture");
}

export async function closeCurrentWindow(): Promise<void> {
  if (typeof window === "undefined") return;
  if (!("__TAURI_INTERNALS__" in window)) return;
  await getCurrentWindow().hide();
}

/** Re-show the current window. Used to restore the capture overlay after a
 *  failed save so the error and the user's text stay visible — the window is
 *  only ever parked (hidden), never destroyed. Mirrors `closeCurrentWindow`. */
export async function showCurrentWindow(): Promise<void> {
  if (typeof window === "undefined") return;
  if (!("__TAURI_INTERNALS__" in window)) return;
  const w = getCurrentWindow();
  await w.show();
  await w.setFocus();
}

/**
 * Resize the capture window to fit the composer content and re-anchor the
 * bottom edge to the monitor so the card grows upward like a chat composer.
 * No-op outside Tauri. The width is fixed (560pt) per `tauri.conf.json`.
 */
const CAPTURE_WIDTH = 560;
const CAPTURE_BOTTOM_GAP = 24;
const CAPTURE_MAX_HEIGHT = 480;
const CAPTURE_MIN_HEIGHT = 80;

export async function fitCaptureWindow(contentHeight: number): Promise<void> {
  if (typeof window === "undefined") return;
  if (!("__TAURI_INTERNALS__" in window)) return;
  const w = getCurrentWindow();
  const height = Math.min(
    CAPTURE_MAX_HEIGHT,
    Math.max(CAPTURE_MIN_HEIGHT, contentHeight),
  );
  try {
    const monitor = await currentMonitor();
    if (!monitor) return;
    const sf = monitor.scaleFactor;
    const mw = monitor.size.width / sf;
    const mh = monitor.size.height / sf;
    const mpos = monitor.position;
    const x = mpos.x / sf + mw / 2 - CAPTURE_WIDTH / 2;
    const y = mpos.y / sf + mh - height - CAPTURE_BOTTOM_GAP;
    await w.setSize(new LogicalSize(CAPTURE_WIDTH, height));
    await w.setPosition(new LogicalPosition(x, y));
  } catch {
    // best-effort: a failure here must not block the capture flow.
  }
}
