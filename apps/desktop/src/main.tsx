/** Renderer entry: mounts <App> inside providers. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./components/App";
import { isRouteCapture } from "./lib/window";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { I18nProvider } from "./lib/i18n";
import { applyTheme, loadTheme } from "./lib/theme";
import "./app.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Both main and capture windows share this entry. Shell's effect only fires
// for the main window (App early-returns for capture), so sync the class
// here — before first paint — to keep the capture overlay theme-aware.
applyTheme(loadTheme());
// The capture window is `transparent: true` (tauri.conf.json), but the shared
// <body class="bg-white dark:bg-zinc-950"> paints an opaque rectangle over
// the full 560×200 window — leaving a solid block above the bottom-anchored
// input card. Strip it for the capture route so only the input card shows;
// the dead space above stays see-through. Inline style overrides the class.
if (isRouteCapture()) {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
}
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <I18nProvider>
        <App />
      </I18nProvider>
    </ErrorBoundary>
  </StrictMode>,
);
