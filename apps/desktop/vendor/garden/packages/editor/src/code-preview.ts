import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorSelection, StateEffect, StateField } from '@codemirror/state';
import type { Extension, EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

type MarkdownTree = ReturnType<typeof syntaxTree>;
type SyntaxNode = MarkdownTree['topNode'];

export interface MarkdownCodeBlockPreview {
  /** Full source line range replaced by the preview widget. */
  from: number;
  to: number;
  /** Fence start, used to put the caret back in the original source. */
  sourceFrom: number;
  codeFrom: number;
  codeTo: number;
  language: string;
  code: string;
}

export interface CodePreviewLabels {
  copy: string;
  copied: string;
  edit: string;
}

/** Reads only closed, top-level fenced blocks. Nested and incomplete fences stay in source view. */
export function parseMarkdownCodeBlocks(source: string, tree: MarkdownTree): MarkdownCodeBlockPreview[] {
  const blocks: MarkdownCodeBlockPreview[] = [];
  tree.iterate({
    enter(node) {
      if (node.name !== 'FencedCode' || node.node.parent?.name !== 'Document') return;

      let codeMarks = 0;
      let info = '';
      let code = '';
      let codeFrom = node.node.to;
      let codeTo = node.node.to;
      for (let child = node.node.firstChild; child; child = child.nextSibling) {
        if (child.name === 'CodeMark') codeMarks += 1;
        else if (child.name === 'CodeInfo') info = source.slice(child.from, child.to).trim();
        else if (child.name === 'CodeText') {
          codeFrom = child.from;
          codeTo = child.to;
          code = source.slice(child.from, child.to);
        }
      }
      // An incomplete fence is still being authored; keep all of its markers visible.
      if (codeMarks < 2) return;

      const lineStart = source.lastIndexOf('\n', node.node.from - 1) + 1;
      const nextLineBreak = source.indexOf('\n', node.node.to);
      const lineEnd = nextLineBreak < 0 ? source.length : nextLineBreak;
      const prefix = source.slice(lineStart, node.node.from);
      const suffix = source.slice(node.node.to, lineEnd);
      // Include only a valid top-level fence's indentation and trailing whitespace in the replacement.
      if (!/^ {0,3}$/.test(prefix) || !/^[ \t]*$/.test(suffix)) return;

      const language = info.split(/\s+/, 1)[0] ?? '';
      blocks.push({
        from: lineStart,
        to: lineEnd,
        sourceFrom: node.node.from,
        codeFrom,
        codeTo,
        language,
        code,
      });
      return false;
    },
  });
  return blocks;
}

function selectionReveals(block: MarkdownCodeBlockPreview, selection: EditorSelection): boolean {
  return selection.ranges.some((range) =>
    range.empty
      ? range.head >= block.from && range.head <= block.to
      : range.from <= block.to && range.to >= block.from,
  );
}

function createIcon(document: Document, checked = false): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', checked ? '3' : '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  if (checked) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M20 6 9 17l-5-5');
    svg.appendChild(path);
  } else {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '9');
    rect.setAttribute('y', '9');
    rect.setAttribute('width', '12');
    rect.setAttribute('height', '12');
    rect.setAttribute('rx', '2.5');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');
    svg.append(rect, path);
  }
  return svg;
}

class CodePreviewWidget extends WidgetType {
  constructor(private readonly block: MarkdownCodeBlockPreview, private readonly labels: CodePreviewLabels) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof CodePreviewWidget
      && other.block.from === this.block.from
      && other.block.to === this.block.to
      && other.block.sourceFrom === this.block.sourceFrom
      && other.block.codeFrom === this.block.codeFrom
      && other.block.codeTo === this.block.codeTo
      && other.block.language === this.block.language
      && other.block.code === this.block.code
      && other.labels.copy === this.labels.copy
      && other.labels.copied === this.labels.copied
      && other.labels.edit === this.labels.edit;
  }

  toDOM(view: EditorView): HTMLElement {
    const document = view.dom.ownerDocument;
    const wrapper = document.createElement('div');
    wrapper.className = 'garden-markdown-code-preview';
    if (this.block.language) wrapper.dataset.language = this.block.language;

    const header = document.createElement('div');
    header.className = 'garden-markdown-code-preview__header';

    if (this.block.language) {
      const language = document.createElement('span');
      language.className = 'garden-markdown-code-preview__language';
      language.textContent = this.block.language;
      header.appendChild(language);
    }

    const actions = document.createElement('div');
    actions.className = 'garden-markdown-code-preview__actions';

    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'garden-markdown-code-preview__edit';
    editButton.textContent = this.labels.edit;
    editButton.addEventListener('mousedown', (event) => event.preventDefault());

    const revealSource = () => {
      view.dispatch({
        selection: EditorSelection.cursor(this.block.sourceFrom),
        scrollIntoView: true,
      });
      view.focus();
    };
    editButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      revealSource();
    });

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'garden-markdown-code-preview__copy';
    copyButton.setAttribute('aria-label', this.labels.copy);
    copyButton.setAttribute('aria-live', 'polite');
    copyButton.append(createIcon(document));
    copyButton.addEventListener('mousedown', (event) => event.preventDefault());
    const copyText = document.createElement('span');
    copyText.textContent = this.labels.copy;
    copyButton.appendChild(copyText);
    copyButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const clipboard = document.defaultView?.navigator.clipboard;
      if (!clipboard?.writeText) return;
      void clipboard.writeText(this.block.code).then(() => {
        copyButton.setAttribute('aria-label', this.labels.copied);
        copyButton.replaceChildren(createIcon(document, true), copyText);
        copyText.textContent = this.labels.copied;
      }).catch(() => undefined);
    });

    actions.append(editButton, copyButton);
    header.appendChild(actions);

    const pre = document.createElement('pre');
    pre.className = 'garden-markdown-code-preview__body';
    const code = document.createElement('code');
    code.className = 'garden-markdown-code-preview__code';
    // Keep display text inert and preserve the exact source separately for copy.
    const lines = this.block.code.split(/\r\n|\r|\n/);
    if (this.block.code.endsWith('\n') || this.block.code.endsWith('\r')) lines.pop();
    lines.forEach((text, index) => {
      const line = document.createElement('span');
      line.className = 'garden-markdown-code-preview__line';

      const number = document.createElement('span');
      number.className = 'garden-markdown-code-preview__number';
      number.setAttribute('aria-hidden', 'true');
      number.textContent = String(index + 1);

      const content = document.createElement('span');
      content.className = 'garden-markdown-code-preview__line-content';
      content.textContent = text;
      line.append(number, content);
      code.appendChild(line);
    });
    // Let the browser select code for copying without CodeMirror mapping a click to the source.
    code.addEventListener('mousedown', (event) => event.stopPropagation());
    pre.appendChild(code);

    wrapper.append(header, pre);
    return wrapper;
  }
}

interface CodePreviewState {
  blocks: MarkdownCodeBlockPreview[];
  decorations: ReturnType<typeof Decoration.set>;
  focused: boolean;
}

export const codePreviewFocusEffect = StateEffect.define<boolean>();

function buildCodePreviewState(state: EditorState, labels: CodePreviewLabels, focused: boolean): CodePreviewState {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const source = state.doc.toString();
  const blocks = parseMarkdownCodeBlocks(source, tree).map((block) => ({
    ...block,
    // CodeMirror stores normalized newlines internally; copy uses the editor's configured line separator.
    code: state.sliceDoc(block.codeFrom, block.codeTo),
  }));
  const ranges = blocks
    .filter((block) => !focused || !selectionReveals(block, state.selection))
    .flatMap((block) => {
      const firstLine = state.doc.lineAt(block.from);
      const lastLine = state.doc.lineAt(block.to);
      // Replacing partial lines can hide list, quote, or other source markers.
      if (firstLine.from !== block.from || lastLine.to !== block.to) return [];
      return [Decoration.replace({ widget: new CodePreviewWidget(block, labels), block: true }).range(firstLine.from, lastLine.to)];
    });
  return { blocks, decorations: Decoration.set(ranges, true), focused };
}

/** Replaces closed, top-level fenced blocks with source-preserving, safe code previews. */
export function codePreview(labels: CodePreviewLabels): Extension {
  const field = StateField.define<CodePreviewState>({
    create: (state) => buildCodePreviewState(state, labels, false),
    update(value, transaction) {
      const focusEffect = transaction.effects.find((effect) => effect.is(codePreviewFocusEffect));
      const focused = focusEffect ? focusEffect.value : value.focused;
      if (transaction.docChanged || focused !== value.focused) return buildCodePreviewState(transaction.state, labels, focused);
      if (transaction.startState.selection.eq(transaction.state.selection)) return value;
      const changedVisibility = value.blocks.some((block) =>
        selectionReveals(block, transaction.startState.selection) !== selectionReveals(block, transaction.state.selection),
      );
      return value.focused && changedVisibility ? buildCodePreviewState(transaction.state, labels, focused) : value;
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });

  const focusHandlers = EditorView.domEventHandlers({
    focusin(_event, view) {
      view.dispatch({ effects: [codePreviewFocusEffect.of(true)] });
      return false;
    },
    focusout(event, view) {
      const nextTarget = event.relatedTarget as Node | null;
      if (nextTarget && view.dom.contains(nextTarget)) return false;
      view.dispatch({ effects: [codePreviewFocusEffect.of(false)] });
      return false;
    },
  });
  return [field, focusHandlers];
}
