/**
 * Shared panel resize handle — one pointer + keyboard mechanism for the two
 * resizable workspace panels: the left navigation sidebar and the right memo
 * writing/word-lookup inspector.
 *
 * The handle is a vertical `role="separator"` living on the panel's inner
 * edge. Pointer drag (pointer capture, rAF-coalesced) and Arrow keys
 * (Shift = coarse, Home/End = bounds) both clamp to [min, max], optionally
 * tightened by `measureMax` — a viewport/container ceiling that keeps the
 * main content usable. Consumers own the width state and persistence
 * (`readPanelWidth` / `writePanelWidth`).
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import "./panel-resize.css";

/** Arrow-key step; Shift+Arrow uses the coarse one. */
const FINE_STEP = 8;
const COARSE_STEP = 32;

export const SIDEBAR_WIDTH_KEY = "oximemo.sidebarWidth.v1";
export const WRITING_PANEL_WIDTH_KEY = "oximemo.writingPanelWidth.v1";

/** Read a persisted panel width, clamped — corrupt/blocked storage falls
 * back to `fallback`. */
export function readPanelWidth(key: string, min: number, max: number, fallback: number): number {
  try {
    const v = Number.parseInt(window.localStorage.getItem(key) ?? "", 10);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
  } catch {
    return fallback;
  }
}

/** Persist a panel width; a blocked quota store just loses the preference. */
export function writePanelWidth(key: string, width: number): void {
  try {
    window.localStorage.setItem(key, String(width));
  } catch {
    // The width still applies for this session.
  }
}

export interface PanelResizeHandleProps {
  /** Panel edge: "start" = panel hugs the left edge (handle on its right
   * border, drag right / ArrowRight to widen); "end" = mirrored. */
  side: "start" | "end";
  value: number;
  min: number;
  max: number;
  /** Live ceiling (viewport or container width minus reserved main-content
   * space), re-read at each drag start / keyboard step. */
  measureMax?: () => number;
  /** Live width during a drag (rAF-coalesced) and on each keyboard step. */
  onResize: (width: number) => void;
  /** Drag end / keyboard step — persist here. */
  onResizeCommit?: (width: number) => void;
  /** Drag lifecycle (pointer only) — consumers freeze entry animations. */
  onDragStart?: () => void;
  onDragEnd?: () => void;
  label: string;
  /** id of the resizable panel element (aria-controls). */
  controls: string;
  className?: string;
}

export function PanelResizeHandle({
  side,
  value,
  min,
  max,
  measureMax,
  onResize,
  onResizeCommit,
  onDragStart,
  onDragEnd,
  label,
  controls,
  className,
}: PanelResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const active = useRef(false);
  const drag = useRef({ startX: 0, startWidth: 0 });
  const moved = useRef(false);
  const latest = useRef(value);
  const frame = useRef(0);
  if (!active.current) latest.current = value;

  useEffect(
    () =>
      () => {
        cancelAnimationFrame(frame.current);
        delete document.documentElement.dataset.panelResizing;
      },
    [],
  );

  const effectiveMax = useCallback(() => {
    if (!measureMax) return max;
    try {
      return Math.min(max, Math.max(min, measureMax()));
    } catch {
      return max;
    }
  }, [measureMax, min, max]);

  const apply = useCallback(
    (width: number) => {
      const clamped = Math.round(Math.min(effectiveMax(), Math.max(min, width)));
      latest.current = clamped;
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        onResize(clamped);
      });
    },
    [effectiveMax, min, onResize],
  );

  const endDrag = useCallback(
    (commit: boolean) => {
      if (!active.current) return;
      active.current = false;
      setDragging(false);
      delete document.documentElement.dataset.panelResizing;
      cancelAnimationFrame(frame.current);
      onDragEnd?.();
      if (commit && moved.current) {
        onResize(latest.current);
        onResizeCommit?.(latest.current);
      }
    },
    [onDragEnd, onResize, onResizeCommit],
  );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    active.current = true;
    drag.current = { startX: event.clientX, startWidth: latest.current };
    moved.current = false;
    setDragging(true);
    document.documentElement.dataset.panelResizing = "true";
    onDragStart?.();
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!active.current) return;
    const delta = side === "start" ? event.clientX - drag.current.startX : drag.current.startX - event.clientX;
    if (delta !== 0) moved.current = true;
    apply(drag.current.startWidth + delta);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const widen = side === "start" ? "ArrowRight" : "ArrowLeft";
    const narrow = side === "start" ? "ArrowLeft" : "ArrowRight";
    const stepWidth = event.shiftKey ? COARSE_STEP : FINE_STEP;
    let next: number;
    if (event.key === widen) next = latest.current + stepWidth;
    else if (event.key === narrow) next = latest.current - stepWidth;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = effectiveMax();
    else return;
    event.preventDefault();
    event.stopPropagation();
    apply(next);
    onResizeCommit?.(Math.round(Math.min(effectiveMax(), Math.max(min, next))));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={effectiveMax()}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)}px`}
      tabIndex={0}
      data-side={side}
      data-dragging={dragging}
      className={className ? `panel-resize-handle ${className}` : "panel-resize-handle"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => endDrag(true)}
      onPointerCancel={() => endDrag(false)}
      onLostPointerCapture={() => endDrag(false)}
      onKeyDown={onKeyDown}
    />
  );
}
