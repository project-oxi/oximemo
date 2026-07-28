/**
 * Window-level helpers.
 *
 * `isRouteCapture` distinguishes the two Tauri windows by URL path:
 * `/capture` is the overlay window, everything else renders the main grid.
 * `closeCurrentWindow` hides the current Tauri window from the renderer.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

export function isRouteCapture(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.pathname.startsWith("/capture");
}

export async function closeCurrentWindow(): Promise<void> {
  if (typeof window === "undefined") return;
  if (!("__TAURI_INTERNALS__" in window)) return;
  await getCurrentWindow().hide();
}
