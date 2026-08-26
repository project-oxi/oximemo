/**
 * Error boundary (H3) + transient error toast (H4).
 *
 * The boundary stops a render-time throw from white-screening the whole app
 * and offers a retry. The toast surfaces failed mutations (save/delete/update)
 * so the user knows a capture didn't land — previously these rejections were
 * silently swallowed.
 */
import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert, X } from "lucide-react";

import { useUI } from "../stores/ui";

interface BoundaryState {
  error: Error | null;
  stack: string | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error, stack: null };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("oximemo render error:", error, info.componentStack);
    this.setState({ stack: info.componentStack ?? null });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen w-full flex-col items-center justify-center gap-3 bg-surface px-6 text-center">
          <p className="text-sm font-medium text-text">
            oximemo hit an unexpected error.
          </p>
          <p className="max-w-md text-xs text-text-muted">
            {String(this.state.error.message || this.state.error)}
          </p>
          {this.state.stack && (
            <pre className="max-h-48 max-w-2xl overflow-auto rounded-lg bg-surface-muted p-2 text-left text-[10px] leading-tight text-text-subtle">
              {this.state.stack}
            </pre>
          )}
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-1 rounded-full bg-interactive-primary px-4 py-1.5 text-xs font-medium text-interactive-primary-foreground transition-colors hover:bg-interactive-primary/90"
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
      <div className="pointer-events-auto flex max-w-md items-center gap-2 rounded-xl border border-status-error bg-status-error-subtle px-3.5 py-2 text-xs text-status-error-on-subtle shadow-lg">
        <TriangleAlert size={14} className="shrink-0" />
        <span className="flex-1">{error}</span>
        <button
          type="button"
          onClick={() => setError(null)}
          className="inline-flex shrink-0 items-center rounded-md p-0.5 text-status-error hover:opacity-70"
          aria-label="dismiss"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
