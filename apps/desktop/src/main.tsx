/** Renderer entry: mounts <App> inside providers. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./components/App";
import { I18nProvider } from "./lib/i18n";
import "./app.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
