/**
 * Error boundary (H3) + transient error toast (H4).
 *
 * The boundary stops a render-time throw from white-screening the whole app
 * and offers a retry. The toast surfaces failed mutations (save/delete/update)
 * so the user knows a capture didn't land — previously these rejections were
 * silently swallowed.
 */
import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";

import { useUI } from "../stores/ui";

interface BoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("oxinot render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen w-full flex-col items-center justify-center gap-3 bg-white px-6 text-center dark:bg-zinc-950">
          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            oxinot hit an unexpected error.
          </p>
          <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">
            {String(this.state.error.message || this.state.error)}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-1 rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Auto-dismissing toast bound to the shared `error` UI state. */
export function ErrorToast() {
  const error = useUI((s) => s.error);
  const setError = useUI((s) => s.setError);

  useEffect(() => {
    if (!error) return;
    const h = window.setTimeout(() => setError(null), 4000);
    return () => window.clearTimeout(h);
  }, [error, setError]);

  if (!error) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-md items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2 text-xs text-red-700 shadow-lg dark:border-red-900/60 dark:bg-red-950/80 dark:text-red-300">
        <span className="font-medium">⚠</span>
        <span className="flex-1">{error}</span>
        <button
          type="button"
          onClick={() => setError(null)}
          className="shrink-0 text-red-400 hover:text-red-600 dark:hover:text-red-200"
          aria-label="dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
