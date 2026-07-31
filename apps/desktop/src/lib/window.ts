/**
 * Window-level helpers.
 *
 * `isRouteCapture` distinguishes the two Tauri windows by window label in
 * Tauri mode (the capture window's label is "capture"), falling back to the
 * URL path in browser/dev mode. `closeCurrentWindow` hides the current Tauri
 * window from the renderer.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

export function isRouteCapture(): boolean {
  if (typeof window === "undefined") return false;
  if ("__TAURI_INTERNALS__" in window) {
    // Label is the robust signal: the capture window's label is "capture"
    // regardless of the loaded URL (the window config sets no `url`, so it
    // loads "/", which would defeat a pathname-only check).
    return getCurrentWindow().label === "capture";
  }
  // Browser/dev mode: no window labels, fall back to the route.
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
