import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from "@codemirror/view";
import { highlightTags } from "./tags";

const tagMark = Decoration.mark({ class: "ox-inline-tag" });
const literalNodes: Record<string, true> = {
  InlineCode: true, FencedCode: true, CodeBlock: true, Link: true, Image: true,
  Autolink: true, HTMLTag: true, HTMLBlock: true, Escape: true,
};

/** Style the existing source, never replace it with a chip/widget. */
export function inlineTagDecorations(state: EditorState, from = 0, to = state.doc.length): DecorationSet {
  const marks: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  for (let pos = state.doc.lineAt(from).from; pos <= to;) {
    const line = state.doc.lineAt(pos);
    let offset = line.from;
    for (const segment of highlightTags(line.text)) {
      const end = offset + segment.text.length;
      if (segment.tag && end > from && offset < to) {
        let node = tree.resolveInner(offset, 1);
        let literal = false;
        for (;;) {
          if (literalNodes[node.name]) { literal = true; break; }
          if (!node.parent) break;
          node = node.parent;
        }
        if (!literal) marks.push(tagMark.range(offset, end));
      }
      offset = end;
    }
    if (line.to >= state.doc.length) break;
    pos = line.to + 1;
  }
  return Decoration.set(marks);
}

export const inlineTagsExtension: Extension = [
  ViewPlugin.define((view) => {
    const build = () => Decoration.set(view.visibleRanges.flatMap(({ from, to }) => {
      const marks: Range<Decoration>[] = [];
      inlineTagDecorations(view.state, from, to).between(from, to, (start, end, mark) => {
        marks.push(mark.range(start, end));
      });
      return marks;
    }), true);
    return {
      decorations: build(),
      update(update) {
        if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
          this.decorations = build();
        }
      },
    };
  }, { decorations: (plugin) => plugin.decorations }),
  EditorView.baseTheme({
    ".ox-inline-tag": {
      color: "var(--color-text-muted)",
      backgroundColor: "var(--color-surface-muted)",
      borderRadius: "var(--tag-radius, 4px)",
      padding: "0.08em 0.22em",
      boxDecorationBreak: "clone",
    },
  }),
];
