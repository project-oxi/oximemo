/** App entry: provider chain + the main window shell. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { isRouteCapture } from "../lib/window";

import { CardGrid } from "./CardGrid";
import { CaptureOverlay } from "./CaptureOverlay";
import { ErrorToast } from "./ErrorBoundary";
import { useUI } from "../stores/ui";
import { applyTheme, loadTheme, saveTheme } from "../lib/theme";

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false } },
});

export function App() {
  useEffect(() => {
    const t = loadTheme();
    useUI.getState().setTheme(t);
    applyTheme(t);
  }, []);

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
      <ErrorToast />
    </>
  );
}
