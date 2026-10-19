import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorSelection, StateEffect, StateField } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

type MarkdownTree = ReturnType<typeof syntaxTree>;
type SyntaxNode = MarkdownTree['topNode'];

export type TableAlignment = 'left' | 'center' | 'right' | null;
export type TableInlineMark = 'code' | 'emphasis' | 'strong' | 'strike';

export interface TableInlineRun {
  text: string;
  marks: readonly TableInlineMark[];
}

export interface TablePreviewCell {
  text: string;
  runs: readonly TableInlineRun[];
}

export interface MarkdownTablePreview {
  from: number;
  to: number;
  header: readonly TablePreviewCell[];
  rows: readonly (readonly TablePreviewCell[])[];
  alignments: readonly TableAlignment[];
}

const nodeMark: Record<string, TableInlineMark> = {
  Emphasis: 'emphasis',
  StrongEmphasis: 'strong',
  Strikethrough: 'strike',
};

function pushRun(runs: TableInlineRun[], text: string, marks: readonly TableInlineMark[]) {
  if (!text) return;
  const previous = runs[runs.length - 1];
  if (previous && previous.marks.join('|') === marks.join('|')) {
    runs[runs.length - 1] = { text: previous.text + text, marks };
  } else {
    runs.push({ text, marks });
  }
}

function codeSpanText(raw: string): string {
  const opening = raw.match(/^`+/)?.[0];
  if (!opening || !raw.endsWith(opening) || raw.length < opening.length * 2) return raw;
  let content = raw.slice(opening.length, -opening.length).replace(/[\r\n]/g, ' ');
  if (/^ .* $/.test(content) && !/^ +$/.test(content)) content = content.slice(1, -1);
  return content;
}

function collectInlineRuns(
  source: string,
  node: SyntaxNode,
  marks: readonly TableInlineMark[],
  runs: TableInlineRun[],
): void {
  if (node.name === 'Escape') {
    pushRun(runs, source.slice(node.from + 1, node.to), marks);
    return;
  }
  if (node.name === 'InlineCode') {
    pushRun(runs, codeSpanText(source.slice(node.from, node.to)), [...marks, 'code']);
    return;
  }
  if (node.name.endsWith('Mark')) return;

  const mark = nodeMark[node.name];
  const childMarks = mark ? [...marks, mark] : marks;
  if (!node.firstChild) {
    // Unknown inline syntax remains visible as literal text in this safe preview.
    pushRun(runs, source.slice(node.from, node.to), childMarks);
    return;
  }

  let position = node.from;
  let child: SyntaxNode | null = node.firstChild;
  while (child) {
    if (position < child.from) pushRun(runs, source.slice(position, child.from), childMarks);
    collectInlineRuns(source, child, childMarks, runs);
    position = child.to;
    child = child.nextSibling;
  }
  if (position < node.to) pushRun(runs, source.slice(position, node.to), childMarks);
}

function cellRuns(source: string, from: number, to: number, syntax: SyntaxNode | undefined): TableInlineRun[] {
  const runs: TableInlineRun[] = [];
  if (syntax) {
    collectInlineRuns(source, syntax, [], runs);
  } else {
    pushRun(runs, source.slice(from, to), []);
  }
  return runs;
}

function trimmedRange(source: string, from: number, to: number): [number, number] {
  const raw = source.slice(from, to);
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  return [from + leading, Math.max(from + leading, to - trailing)];
}

function rowCells(source: string, row: SyntaxNode): TablePreviewCell[] {
  const separators: Array<[number, number]> = [];
  const syntaxCells: SyntaxNode[] = [];
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableDelimiter') separators.push([child.from, child.to]);
    if (child.name === 'TableCell') syntaxCells.push(child);
  }

  const cells: Array<[number, number]> = [];
  let start = row.from;
  for (const [from, to] of separators) {
    cells.push(trimmedRange(source, start, from));
    start = to;
  }
  cells.push(trimmedRange(source, start, row.to));

  // A leading/trailing pipe creates an empty edge segment, not an extra cell.
  if (separators[0]?.[0] === row.from) cells.shift();
  if (separators.at(-1)?.[1] === row.to) cells.pop();

  return cells.map(([from, to]) => {
    const syntax = syntaxCells.find((candidate) => candidate.from === from && candidate.to === to);
    const runs = cellRuns(source, from, to, syntax);
    return { text: runs.map((run) => run.text).join(''), runs };
  });
}

function delimiterCells(source: string, delimiter: SyntaxNode): string[] {
  let line = source.slice(delimiter.from, delimiter.to).trim();
  if (line.startsWith('|')) line = line.slice(1);
  if (line.endsWith('|')) line = line.slice(0, -1);
  return line.split('|').map((cell) => cell.trim());
}

function parseAlignments(source: string, delimiter: SyntaxNode, count: number): TableAlignment[] {
  const cells = delimiterCells(source, delimiter);
  return Array.from({ length: count }, (_, index): TableAlignment => {
    const cell = cells[index] ?? '';
    const match = cell.match(/^(:)?-+(:)?$/);
    if (!match) return null;
    if (match[1] && match[2]) return 'center';
    if (match[1]) return 'left';
    if (match[2]) return 'right';
    return null;
  });
}

function parseTable(source: string, table: SyntaxNode): MarkdownTablePreview | null {
  let headerNode: SyntaxNode | undefined;
  let delimiterNode: SyntaxNode | undefined;
  const rowNodes: SyntaxNode[] = [];
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableHeader') headerNode = child;
    else if (child.name === 'TableRow') rowNodes.push(child);
    else if (child.name === 'TableDelimiter') delimiterNode = child;
  }
  if (!headerNode || !delimiterNode) return null;

  const header = rowCells(source, headerNode);
  if (!header.length) return null;
  const rows = rowNodes.map((row) => {
    const cells = rowCells(source, row);
    return Array.from({ length: header.length }, (_, index) => cells[index] ?? { text: '', runs: [] });
  });
  return {
    from: table.from,
    to: table.to,
    header,
    rows,
    alignments: parseAlignments(source, delimiterNode, header.length),
  };
}

/** Reads table rows from Lezer's GFM table nodes without changing their source. */
export function parseMarkdownTables(source: string, tree: MarkdownTree): MarkdownTablePreview[] {
  const tables: MarkdownTablePreview[] = [];
  tree.iterate({
    enter(node) {
      if (node.name !== 'Table') return;
      const table = parseTable(source, node.node);
      if (table) tables.push(table);
      return false;
    },
  });
  return tables;
}

function selectionReveals(table: MarkdownTablePreview, selection: EditorSelection): boolean {
  return selection.ranges.some((range) =>
    range.empty
      ? range.head >= table.from && range.head <= table.to
      : range.from <= table.to && range.to >= table.from,
  );
}

function appendRuns(document: Document, parent: HTMLElement, runs: readonly TableInlineRun[]) {
  const tags: Record<TableInlineMark, string> = {
    code: 'code',
    emphasis: 'em',
    strong: 'strong',
    strike: 'del',
  };
  for (const run of runs) {
    let target = parent;
    for (const mark of run.marks) {
      const element = document.createElement(tags[mark]);
      target.appendChild(element);
      target = element;
    }
    target.appendChild(document.createTextNode(run.text));
  }
}

function appendCell(
  document: Document,
  row: HTMLTableRowElement,
  cell: TablePreviewCell,
  alignment: TableAlignment,
  header: boolean,
) {
  const element = document.createElement(header ? 'th' : 'td');
  if (header) element.scope = 'col';
  if (alignment) element.style.textAlign = alignment;
  appendRuns(document, element, cell.runs);
  row.appendChild(element);
}

class TablePreviewWidget extends WidgetType {
  constructor(private readonly table: MarkdownTablePreview, private readonly label?: string) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof TablePreviewWidget && other.table === this.table && other.label === this.label;
  }

  toDOM(view: EditorView): HTMLElement {
    const document = view.dom.ownerDocument;
    const wrapper = document.createElement('div');
    wrapper.className = 'garden-markdown-table-preview';
    const fallbackLabel = this.table.header.map((cell) => cell.text).join(', ');

    const table = document.createElement('table');
    table.tabIndex = 0;
    table.setAttribute('aria-keyshortcuts', 'Enter Space');
    if (this.label) table.setAttribute('aria-label', this.label);
    else if (fallbackLabel) table.setAttribute('aria-label', fallbackLabel);
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    this.table.header.forEach((cell, index) => appendCell(document, headRow, cell, this.table.alignments[index] ?? null, true));
    head.appendChild(headRow);
    table.appendChild(head);

    const body = document.createElement('tbody');
    for (const cells of this.table.rows) {
      const row = document.createElement('tr');
      cells.forEach((cell, index) => appendCell(document, row, cell, this.table.alignments[index] ?? null, false));
      body.appendChild(row);
    }
    table.appendChild(body);
    wrapper.appendChild(table);

    const revealSource = () => {
      view.dispatch({ selection: EditorSelection.cursor(this.table.from) });
      view.focus();
    };
    table.addEventListener('mousedown', (event) => event.preventDefault());
    table.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      revealSource();
    });
    table.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      revealSource();
    });
    return wrapper;
  }
}

interface TablePreviewState {
  tables: MarkdownTablePreview[];
  decorations: ReturnType<typeof Decoration.set>;
  focused: boolean;
}

export const tablePreviewFocusEffect = StateEffect.define<boolean>();

function buildTablePreviewState(
  state: import('@codemirror/state').EditorState,
  label: string | undefined,
  focused: boolean,
): TablePreviewState {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const source = state.doc.toString();
  const tables = parseMarkdownTables(source, tree);
  const ranges = tables
    .filter((table) => !focused || !selectionReveals(table, state.selection))
    .flatMap((table) => {
      const firstLine = state.doc.lineAt(table.from);
      const lastLine = state.doc.lineAt(table.to);
      // Whole-line widgets would otherwise hide list or quote markers outside the parsed table.
      if (firstLine.from !== table.from || lastLine.to !== table.to) return [];
      return [Decoration.replace({ widget: new TablePreviewWidget(table, label), block: true }).range(firstLine.from, lastLine.to)];
    });
  return { tables, decorations: Decoration.set(ranges, true), focused };
}

/** Replaces unselected, top-level GFM tables with safe, keyboard-accessible previews. */
export function tablePreview(label?: string): Extension {
  const field = StateField.define<TablePreviewState>({
    create: (state) => buildTablePreviewState(state, label, false),
    update(value, transaction) {
      const focusEffect = transaction.effects.find((effect) => effect.is(tablePreviewFocusEffect));
      const focused = focusEffect ? focusEffect.value : value.focused;
      if (transaction.docChanged || focused !== value.focused) return buildTablePreviewState(transaction.state, label, focused);
      if (transaction.startState.selection.eq(transaction.state.selection)) return value;
      const changedTableVisibility = value.tables.some((table) =>
        selectionReveals(table, transaction.startState.selection) !== selectionReveals(table, transaction.state.selection),
      );
      return value.focused && changedTableVisibility ? buildTablePreviewState(transaction.state, label, focused) : value;
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });
  const focusHandlers = EditorView.domEventHandlers({
    focusin(_event, view) {
      view.dispatch({ effects: tablePreviewFocusEffect.of(true) });
      return false;
    },
    focusout(event, view) {
      const nextTarget = event.relatedTarget as Node | null;
      if (nextTarget && view.dom.contains(nextTarget)) return false;
      view.dispatch({ effects: tablePreviewFocusEffect.of(false) });
      return false;
    },
  });
  return [field, focusHandlers];
}
