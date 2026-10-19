import { syntaxTree } from "@codemirror/language";
import { Prec, type EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isComposingKey, isSaveAndCloseChord, isSaveAndCloseKey } from "./editorKeys";

/** Only step through a parsed closing emphasis mark, never literal syntax. */
export function emphasisClosingPosition(state: EditorState, from: number, to: number, text: string): number | null {
  if ((text !== "*" && text !== "_") || from !== to
    || state.selection.ranges.length !== 1 || !state.selection.main.empty
    || state.sliceDoc(from, from + 1) !== text) return null;

  let node = syntaxTree(state).resolveInner(from, -1);
  for (;;) {
    if (node.name === "StrongEmphasis" || node.name === "Emphasis") {
      const closer = node.lastChild;
      if (closer?.name === "EmphasisMark" && from >= closer.from && from < closer.to) {
        return from + 1;
      }
    }
    if (!node.parent) return null;
    node = node.parent;
  }
}

export function markdownTypingExtension(onSaveAndClose?: () => void): Extension {
  // Atomic extends *|* into **|**, but the additional closer isn't tracked
  // by CM's bracket state. Consume typed closing marks before either
  // auto-pair handler can create another pair.
  const emphasis = Prec.highest(EditorView.inputHandler.of((view, from, to, text) => {
    if (view.composing || view.state.readOnly) return false;
    const next = emphasisClosingPosition(view.state, from, to, text);
    if (next === null) return false;
    view.dispatch({ selection: { anchor: next }, userEvent: "input.type", scrollIntoView: true });
    return true;
  }));
  if (!onSaveAndClose) return emphasis;
  return [emphasis, Prec.highest(EditorView.domEventHandlers({
    keydown(event, view) {
      if (!isSaveAndCloseChord(event) || view.composing || isComposingKey(event)) return false;
      // CM's default Mod-Enter adds a blank line. Consume the chord here
      // before that keymap and before the dialog's window listener.
      const finish = isSaveAndCloseKey(event);
      event.preventDefault();
      if (finish) onSaveAndClose();
      return true;
    },
  }))];
}
