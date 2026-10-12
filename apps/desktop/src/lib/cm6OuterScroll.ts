/**
 * Document-flow editor scrolling. When the memo editor runs with `height:
 * auto` inside the note dialog's single scroll container (properties +
 * content scroll as one — the Obsidian/Notion model), CM's own scrollDOM has
 * no overflow, so its built-in "keep the caret visible" machinery becomes a
 * no-op. This extension takes over that job: after a selection move, focus
 * change, or doc edit it scrolls the nearest `[data-memo-scroll]` ancestor
 * just enough to keep the caret head inside the viewport. Pointer selections
 * keep the clicked position; keyboard movement gets a small comfort margin.
 */
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

const EDGE_PAD = 24;

type VerticalBounds = { top: number; bottom: number };

/** Scroll only the obscured edge, with a margin that also fits short windows. */
export function caretScrollDelta(caret: VerticalBounds, viewport: VerticalBounds): number {
  const height = viewport.bottom - viewport.top;
  if (height <= 0) return 0;
  const pad = Math.min(EDGE_PAD, Math.max(0, (height - (caret.bottom - caret.top)) / 4));
  if (caret.top < viewport.top + pad) return caret.top - viewport.top - pad;
  if (caret.bottom > viewport.bottom - pad) return caret.bottom - viewport.bottom + pad;
  return 0;
}

export function outerScrollExtension(): Extension {
  return ViewPlugin.fromClass(class {
    private pointerSelection = false;
    private measure = {
      read: (view: EditorView) => {
        if (!view.hasFocus || this.pointerSelection) return null;
        const scroller = view.scrollDOM.closest<HTMLElement>("[data-memo-scroll]");
        const caret = view.coordsAtPos(view.state.selection.main.head);
        if (!scroller || !caret) return null;
        return { scroller, delta: caretScrollDelta(caret, scroller.getBoundingClientRect()) };
      },
      write: (result: { scroller: HTMLElement; delta: number } | null, view: EditorView) => {
        if (result && view.hasFocus && !this.pointerSelection && result.delta) {
          result.scroller.scrollTop += result.delta;
        }
      },
    };

    update(update: ViewUpdate) {
      if (!update.selectionSet && !update.docChanged && !update.focusChanged && !update.geometryChanged) return;
      if (update.selectionSet || update.docChanged || update.focusChanged) {
        this.pointerSelection = !update.docChanged && update.transactions.some(
          (transaction) => transaction.isUserEvent("select.pointer"),
        );
      }
      if (!update.view.hasFocus || this.pointerSelection) return;
      // Measure after live-preview decorations and wrapping have settled.
      // CM coalesces this request, so rapid typing never reads/writes layout
      // synchronously for each transaction or scrolls to an old cursor.
      update.view.requestMeasure(this.measure);
    }
  });
}
