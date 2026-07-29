/** Renderer entry: mounts <App> inside providers. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./components/App";
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
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <I18nProvider>
        <App />
      </I18nProvider>
    </ErrorBoundary>
  </StrictMode>,
);
