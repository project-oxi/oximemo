/**
 * Document-flow editor scrolling. When the memo editor runs with `height:
 * auto` inside the note dialog's single scroll container (properties +
 * content scroll as one — the Obsidian/Notion model), CM's own scrollDOM has
 * no overflow, so its built-in "keep the caret visible" machinery becomes a
 * no-op. This extension takes over that job: after a selection move, focus
 * change, or doc edit it scrolls the nearest `[data-memo-scroll]` ancestor
 * just enough to keep the caret head inside the viewport with a comfort pad.
 */
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/** Distance kept between the caret and the scroller edge (px). */
const EDGE_PAD = 56;

export function outerScrollExtension(): Extension {
  return EditorView.updateListener.of((u) => {
    if (!u.view.hasFocus) return;
    if (!u.selectionSet && !u.docChanged && !u.focusChanged) return;
    const view = u.view;
    const scroller = view.scrollDOM.closest<HTMLElement>("[data-memo-scroll]");
    if (!scroller) return;
    const coords = view.coordsAtPos(view.state.selection.main.head);
    if (!coords) return;
    const box = scroller.getBoundingClientRect();
    if (coords.top < box.top + EDGE_PAD) {
      scroller.scrollTop += coords.top - box.top - EDGE_PAD;
    } else if (coords.bottom > box.bottom - EDGE_PAD) {
      scroller.scrollTop += coords.bottom - box.bottom + EDGE_PAD;
    }
  });
}
