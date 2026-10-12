import { expect, test } from 'bun:test';
import {
  CompletionContext,
  type Completion,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { envelopeSyntax } from '../src/envelope-syntax.js';
import {
  slashCommandSource,
  type SlashCommandId,
  type SlashCommandLabels,
} from '../src/slash-commands.js';

function state(
  doc: string,
  selection?: number | EditorSelection,
  lineSeparator: '\n' | '\r\n' = '\n',
  readOnly = false,
): EditorState {
  const logicalLength = doc.replace(/\r\n/g, '\n').length;
  const result = EditorState.create({
    doc,
    selection: typeof selection === 'number'
      ? EditorSelection.cursor(selection)
      : selection ?? EditorSelection.cursor(logicalLength),
    extensions: [
      EditorState.lineSeparator.of(lineSeparator),
      EditorState.allowMultipleSelections.of(true),
      EditorState.readOnly.of(readOnly),
      markdown({ base: markdownLanguage, extensions: [envelopeSyntax] }),
    ],
  });
  ensureSyntaxTree(result, result.doc.length, 1000);
  return result;
}

async function resultAt(
  editorState: EditorState,
  labels?: SlashCommandLabels,
): Promise<CompletionResult | null> {
  const position = editorState.selection.main.head;
  const result = await slashCommandSource(labels)(new CompletionContext(editorState, position, false));
  return result;
}

function applyCompletion(
  editorState: EditorState,
  result: CompletionResult,
  completion: Completion,
): Transaction | null {
  let transaction: Transaction | null = null;
  const view = {
    state: editorState,
    dispatch(value: Transaction) { transaction = value; },
  } as unknown as EditorView;
  if (typeof completion.apply === 'function') completion.apply(view, completion, result.from, result.to ?? editorState.selection.main.head);
  return transaction;
}

function expectReversible(before: EditorState, transaction: Transaction): void {
  expect(transaction.annotation(Transaction.addToHistory)).not.toBe(false);
  expect(transaction.changes.invert(before.doc).apply(transaction.newDoc).eq(before.doc)).toBe(true);
}

test('slash menu filters Korean labels, English labels, and aliases', async () => {
  const headings = await resultAt(state('/heading'));
  expect(headings?.options.map((option) => (option as Completion & { commandId: SlashCommandId }).commandId))
    .toEqual(['heading1', 'heading2', 'heading3']);

  const alias = await resultAt(state('/h2'));
  expect(alias?.options.map((option) => (option as Completion & { commandId: SlashCommandId }).commandId))
    .toEqual(['heading2']);

  const labels: SlashCommandLabels = {
    heading1: { label: '제목 1', description: '큰 제목을 삽입합니다' },
    heading2: { label: '제목 2', description: '중간 제목을 삽입합니다' },
  };
  const korean = await resultAt(state('/제목 1'), labels);
  expect(korean?.options.map((option) => (option as Completion & { commandId: SlashCommandId }).commandId))
    .toEqual(['heading1']);
});

test('slash menu updates its filtered options as the typed query changes', async () => {
  const firstState = state('/heading');
  const first = await resultAt(firstState);
  expect(first?.options).toHaveLength(3);
  const nextState = state('/heading 3');
  const next = first?.update?.(first, first.from, first.to ?? firstState.doc.length,
    new CompletionContext(nextState, nextState.doc.length, false));
  expect(next?.options.map((option) => (option as Completion & { commandId: SlashCommandId }).commandId))
    .toEqual(['heading3']);
});

test('slash completion requires a matching command at the end of one editable paragraph line', async () => {
  for (const source of [
    'plain /task',
    '/Users/name',
    '//task',
    '/not-a-command',
    '    /task',
    '/task trailing',
  ]) {
    expect(await resultAt(state(source))).toBeNull();
  }

  const cursorNotAtEnd = state('/task!', '/task'.length);
  expect(await resultAt(cursorNotAtEnd)).toBeNull();

  const multi = state('/task', EditorSelection.create([
    EditorSelection.cursor('/task'.length),
    EditorSelection.cursor(1),
  ]));
  expect(await resultAt(multi)).toBeNull();
  expect(await resultAt(state('/task', '/task'.length, '\n', true))).toBeNull();

  const indented = await resultAt(state('   /task'));
  expect(indented?.options.length).toBeGreaterThan(0);
});

test('slash completion stays out of fences, envelopes, HTML, tables, lists, and quotes', async () => {
  const contexts = [
    '```md\n/task\n```',
    '---\n/task\n---\n\n',
    '<div>\n/task\n</div>',
    '- outer item\n  /task',
    '> quoted paragraph\n/task',
    '| name | value |\n| --- | --- |\n| /task',
  ];
  for (const source of contexts) {
    const currentLineStart = source.lastIndexOf('/task');
    const position = currentLineStart < 0 ? source.length : currentLineStart + '/task'.length;
    expect(await resultAt(state(source, position))).toBeNull();
  }
});

test('picking each command inserts Markdown and places the caret or selection in its placeholder', async () => {
  const examples: Array<{
    id: SlashCommandId;
    query: string;
    expected: string;
    selection: [number, number];
  }> = [
    { id: 'task', query: '/task', expected: '- [ ] ', selection: [6, 6] },
    { id: 'heading1', query: '/heading1', expected: '# ', selection: [2, 2] },
    { id: 'heading2', query: '/heading2', expected: '## ', selection: [3, 3] },
    { id: 'heading3', query: '/heading3', expected: '### ', selection: [4, 4] },
    { id: 'bulletList', query: '/bullet', expected: '- ', selection: [2, 2] },
    { id: 'numberedList', query: '/numbered', expected: '1. ', selection: [3, 3] },
    { id: 'quote', query: '/quote', expected: '> ', selection: [2, 2] },
    { id: 'codeFence', query: '/code', expected: '```\n\n```', selection: [4, 4] },
    { id: 'table', query: '/table', expected: '| Header 1 | Header 2 |\n| --- | --- |\n|  |  |', selection: [2, 10] },
    { id: 'divider', query: '/divider', expected: '***\n', selection: [4, 4] },
    { id: 'link', query: '/link', expected: '[link text](url)', selection: [1, 10] },
    { id: 'image', query: '/image', expected: '![alt text](path/to/image)', selection: [2, 10] },
    { id: 'wikiEmbed', query: '/embed', expected: '![[Note]]', selection: [3, 7] },
    { id: 'wikiLink', query: '/wiki link', expected: '[[Note|Label]]', selection: [2, 6] },
    { id: 'callout', query: '/callout', expected: '> [!note]\n> ', selection: [12, 12] },
    { id: 'highlight', query: '/highlight', expected: '==text==', selection: [2, 6] },
    { id: 'comment', query: '/comment', expected: '%%comment%%', selection: [2, 9] },
    { id: 'footnote', query: '/footnote', expected: '[^1]\n\n[^1]: \n', selection: [12, 12] },
    { id: 'inlineMath', query: '/inline math', expected: '$x$', selection: [1, 2] },
    { id: 'displayMath', query: '/display math', expected: '$$\n\n$$', selection: [3, 3] },
    { id: 'tag', query: '/tag', expected: '#tag', selection: [1, 4] },
    { id: 'blockId', query: '/block id', expected: '^block-1', selection: [1, 8] },
  ];

  for (const example of examples) {
    const before = state(example.query);
    const result = await resultAt(before);
    const completion = result?.options.find((option) =>
      (option as Completion & { commandId: SlashCommandId }).commandId === example.id);
    expect(completion, `completion for ${example.id}`).toBeDefined();
    const transaction = applyCompletion(before, result!, completion!);
    expect(transaction?.newDoc.toString(), example.id).toBe(example.expected);
    expect([transaction?.newSelection.main.anchor, transaction?.newSelection.main.head], example.id)
      .toEqual(example.selection);
    if (transaction) expectReversible(before, transaction);
  }
});

test('block commands separate from a preceding paragraph and preserve CRLF in one undoable edit', async () => {
  const source = 'Previous paragraph\r\n/heading1';
  const before = state(source, source.replace(/\r\n/g, '\n').length, '\r\n');
  const result = await resultAt(before);
  const completion = result?.options.find((option) =>
    (option as Completion & { commandId: SlashCommandId }).commandId === 'heading1');
  const transaction = applyCompletion(before, result!, completion!);

  expect(transaction?.newDoc.toString()).toBe('Previous paragraph\n\n# ');
  expect(transaction?.state.sliceDoc()).toBe('Previous paragraph\r\n\r\n# ');
  expect(transaction?.newSelection.main.head).toBe('Previous paragraph\n\n# '.length);
  if (transaction) expectReversible(before, transaction);
});

test('multiline code, table, and divider templates use the document CRLF separator', async () => {
  const examples = [
    { id: 'codeFence' as const, query: '/code', inserted: '```\n\n```' },
    { id: 'table' as const, query: '/table', inserted: '| Header 1 | Header 2 |\n| --- | --- |\n|  |  |' },
    { id: 'divider' as const, query: '/divider', inserted: '***\n' },
  ];
  for (const example of examples) {
    const source = `Previous paragraph\r\n${example.query}`;
    const before = state(source, undefined, '\r\n');
    const result = await resultAt(before);
    const completion = result?.options.find((option) =>
      (option as Completion & { commandId: SlashCommandId }).commandId === example.id);
    const transaction = applyCompletion(before, result!, completion!);
    const expected = `Previous paragraph\n\n${example.inserted}`;
    expect(transaction?.newDoc.toString(), example.id).toBe(expected);
    expect(transaction?.state.sliceDoc(), example.id).toBe(expected.replace(/\n/g, '\r\n'));
    if (transaction) expectReversible(before, transaction);
  }
});

test('footnote and block ID commands choose deterministic unused numeric IDs', async () => {
  const prefix = 'Refs [^1] and [^3]: existing text with ^block-1 and ^block-3';

  const footnoteSource = `${prefix}\n/footnote`;
  const beforeFootnote = state(footnoteSource);
  const footnoteResult = await resultAt(beforeFootnote);
  const footnote = footnoteResult?.options.find((option) =>
    (option as Completion & { commandId: SlashCommandId }).commandId === 'footnote');
  const footnoteTransaction = applyCompletion(beforeFootnote, footnoteResult!, footnote!);
  expect(footnoteTransaction?.newDoc.toString()).toBe(`${prefix}\n\n[^2]\n\n[^2]: \n`);
  expect(footnoteTransaction?.newSelection.main.head).toBe(`${prefix}\n\n[^2]\n\n[^2]: `.length);

  const blockIdSource = `${prefix}\n/block id`;
  const beforeBlockId = state(blockIdSource);
  const blockIdResult = await resultAt(beforeBlockId);
  const blockId = blockIdResult?.options.find((option) =>
    (option as Completion & { commandId: SlashCommandId }).commandId === 'blockId');
  const blockIdTransaction = applyCompletion(beforeBlockId, blockIdResult!, blockId!);
  expect(blockIdTransaction?.newDoc.toString()).toBe(`${prefix}\n\n^block-2`);
  expect(blockIdTransaction?.newSelection.main.anchor).toBe(`${prefix}\n\n^`.length);
  expect(blockIdTransaction?.newSelection.main.head).toBe(`${prefix}\n\n^block-2`.length);
});

test('picked completions revalidate read-only state, cursor range, and the current query', async () => {
  const sourceState = state('/task');
  const result = await resultAt(sourceState);
  const task = result?.options.find((option) =>
    (option as Completion & { commandId: SlashCommandId }).commandId === 'task');

  expect(applyCompletion(state('/task', undefined, '\n', true), result!, task!)).toBeNull();
  expect(applyCompletion(state('/tast'), result!, task!)).toBeNull();
  expect(applyCompletion(state('/task', 2), result!, task!)).toBeNull();
});

test('slash completion waits until IME composition has ended', async () => {
  const editorState = state('/task');
  const position = editorState.selection.main.head;
  for (const view of [
    { state: editorState, composing: true, compositionStarted: true },
    { state: editorState, composing: false, compositionStarted: true },
  ]) {
    const result = await slashCommandSource()(new CompletionContext(editorState, position, false, view as EditorView));
    expect(result).toBeNull();
  }
  expect(await resultAt(editorState)).not.toBeNull();
});

test('divider uses a thematic break marker rather than the envelope delimiter', async () => {
  const result = await resultAt(state('/divider'));
  const divider = result?.options.find((option) =>
    (option as Completion & { commandId: SlashCommandId }).commandId === 'divider');
  const transaction = applyCompletion(state('/divider'), result!, divider!);
  expect(transaction?.newDoc.toString()).toBe('***\n');
  expect(transaction?.newSelection.main.head).toBe(4);
});
