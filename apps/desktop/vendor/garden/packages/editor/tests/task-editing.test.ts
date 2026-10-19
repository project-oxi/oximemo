import { expect, test } from 'bun:test';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { gardenMarkdownConfig } from '@garden/markdown/syntax';
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { envelopeSyntax } from '../src/envelope-syntax.js';
import { continueTaskOnEnter, removeTaskPrefixOnBackspace, toggleOrCreateTask } from '../src/task-editing.js';

function state(
  doc: string,
  selection: number | EditorSelection = 0,
  lineSeparator: '\n' | '\r\n' = '\n',
  readOnly = false,
): EditorState {
  const result = EditorState.create({
    doc,
    selection: typeof selection === 'number' ? EditorSelection.cursor(selection) : selection,
    extensions: [
      EditorState.lineSeparator.of(lineSeparator),
      EditorState.allowMultipleSelections.of(true),
      EditorState.readOnly.of(readOnly),
      markdown({ base: markdownLanguage, extensions: [gardenMarkdownConfig, envelopeSyntax] }),
    ],
  });
  ensureSyntaxTree(result, result.doc.length, 1000);
  return result;
}

function expectReversible(before: EditorState, transaction: Transaction): void {
  expect(transaction.annotation(Transaction.addToHistory)).not.toBe(false);
  expect(transaction.changes.invert(before.doc).apply(transaction.newDoc).eq(before.doc)).toBe(true);
}

test('Enter splits task content and starts the next item unchecked', () => {
  const source = '- [x] first second';
  const before = state(source, source.indexOf('first') + 'first'.length);
  const transaction = continueTaskOnEnter(before);

  expect(transaction?.newDoc.toString()).toBe('- [x] first\n- [ ] second');
  expect(transaction?.newSelection.main.head).toBe('- [x] first\n- [ ] '.length);
  if (transaction) expectReversible(before, transaction);
});

test('Enter at the content cursor continues a task, including CRLF documents', () => {
  const source = '- [ ] ready';
  const before = state(source, source.length, '\r\n');
  const transaction = continueTaskOnEnter(before);

  expect(transaction?.newDoc.toString()).toBe('- [ ] ready\n- [ ] ');
  expect(transaction?.newDoc.length).toBe('- [ ] ready\n- [ ] '.length);
  expect(transaction?.newSelection.main.head).toBe('- [ ] ready\n- [ ] '.length);
  expect(transaction?.state.sliceDoc()).toBe('- [ ] ready\r\n- [ ] ');
  if (transaction) expectReversible(before, transaction);
});

test('Enter on an empty task exits it and outdents a nested task to its parent item level', () => {
  const top = state('before\n- [ ] \nafter', 'before\n- [ ] '.length);
  const exited = continueTaskOnEnter(top);
  expect(exited?.newDoc.toString()).toBe('before\n\nafter');

  const nestedSource = '100. parent\n     - [ ] ';
  const nested = state(nestedSource, nestedSource.length);
  const outdented = continueTaskOnEnter(nested);
  expect(outdented?.newDoc.toString()).toBe('100. parent\n- [ ] ');
  if (outdented) expectReversible(nested, outdented);
});

test('Backspace removes the whole task prefix and keeps its content and caret', () => {
  const source = '- [ ] Keep this text';
  const before = state(source, source.indexOf('Keep'));
  const transaction = removeTaskPrefixOnBackspace(before);

  expect(transaction?.newDoc.toString()).toBe('Keep this text');
  expect(transaction?.newSelection.main.head).toBe(0);
  if (transaction) expectReversible(before, transaction);
});

test('Backspace on an empty task removes indentation and leaves a clean blank line', () => {
  const source = '  - [ ]   ';
  const before = state(source, source.length);
  const transaction = removeTaskPrefixOnBackspace(before);

  expect(transaction?.newDoc.toString()).toBe('');
  expect(transaction?.newSelection.main.head).toBe(0);
});

test('task Enter and Backspace preserve every cursor in a multi-selection', () => {
  const source = '- [ ] first\n- [x] second';
  const startFirst = source.indexOf('first');
  const startSecond = source.indexOf('second');
  const selection = EditorSelection.create([
    EditorSelection.cursor(startFirst + 'first'.length),
    EditorSelection.cursor(startSecond + 'second'.length),
  ], 1);
  const before = state(source, selection);
  const continued = continueTaskOnEnter(before);

  expect(continued?.newDoc.toString()).toBe('- [ ] first\n- [ ] \n- [x] second\n- [ ] ');
  expect(continued?.newSelection.ranges).toHaveLength(2);
  if (continued) expectReversible(before, continued);

  const backspaceSelection = EditorSelection.create([
    EditorSelection.cursor(startFirst),
    EditorSelection.cursor(startSecond),
  ], 1);
  const beforeBackspace = state(source, backspaceSelection);
  const removed = removeTaskPrefixOnBackspace(beforeBackspace);
  expect(removed?.newDoc.toString()).toBe('first\nsecond');
  expect(removed?.newSelection.ranges).toHaveLength(2);
  expect(removed?.newSelection.ranges.map((range) => range.head)).toEqual([0, 6]);
});

test('task shortcuts are syntax-aware and leave ordinary lists, fences, and the envelope alone', () => {
  const source = [
    '---',
    'title: A note',
    'tasks:',
    '  - [ ] envelope value',
    '---',
    '- ordinary list',
    '',
    '```md',
    '- [ ] fenced task',
    '```',
  ].join('\n');
  for (const content of ['envelope value', 'fenced task']) {
    const marker = content === 'envelope value' ? '- [ ] envelope value' : '- [ ] fenced task';
    const position = source.indexOf(content) + content.length;
    const insideMarker = state(source, source.indexOf(marker) + marker.indexOf('[ ]') + 1);
    const inContext = state(source, position);
    expect(continueTaskOnEnter(inContext)).toBeNull();
    expect(removeTaskPrefixOnBackspace(inContext)).toBeNull();
    expect(continueTaskOnEnter(insideMarker)).toBeNull();
  }
  const ordinaryPosition = source.indexOf('ordinary list') + 'ordinary list'.length;
  const ordinary = state(source, ordinaryPosition);
  expect(continueTaskOnEnter(ordinary)).toBeNull();
  expect(removeTaskPrefixOnBackspace(state(source, ordinaryPosition - 'ordinary list'.length))).toBeNull();
});

test('read-only states do not dispatch task source edits', () => {
  const source = '- [ ] text';
  const before = state(source, source.length, '\n', true);
  expect(continueTaskOnEnter(before)).toBeNull();
  expect(removeTaskPrefixOnBackspace(state(source, source.indexOf('text'), '\n', true))).toBeNull();
  expect(toggleOrCreateTask(state('plain text', 'plain text'.length, '\n', true))).toBeNull();
});

test('Mod-Enter creates task markers in paragraphs and ordinary list items', () => {
  const paragraph = state('A task idea', 'A task idea'.length);
  const paragraphTask = toggleOrCreateTask(paragraph);
  expect(paragraphTask?.newDoc.toString()).toBe('- [ ] A task idea');
  if (paragraphTask) expectReversible(paragraph, paragraphTask);

  const bullet = state('- ordinary item', '- ordinary item'.length);
  expect(toggleOrCreateTask(bullet)?.newDoc.toString()).toBe('- [ ] ordinary item');

  const ordered = state('12. ordinary item', '12. ordinary item'.length);
  expect(toggleOrCreateTask(ordered)?.newDoc.toString()).toBe('12. [ ] ordinary item');

  const quotedParagraph = state('> quoted thought', '> quoted thought'.length);
  expect(toggleOrCreateTask(quotedParagraph)?.newDoc.toString()).toBe('> - [ ] quoted thought');

  const quotedList = state('> - ordinary item', '> - ordinary item'.length);
  expect(toggleOrCreateTask(quotedList)?.newDoc.toString()).toBe('> - [ ] ordinary item');
});

test('Mod-Enter toggles only the GFM open and completed markers', () => {
  const open = state('- [ ] keep the source text', '- [ ] keep the source text'.length);
  const completed = toggleOrCreateTask(open);
  expect(completed?.newDoc.toString()).toBe('- [x] keep the source text');
  if (completed) expectReversible(open, completed);

  const done = state('- [X] keep the source text', '- [X] keep the source text'.length);
  expect(toggleOrCreateTask(done)?.newDoc.toString()).toBe('- [ ] keep the source text');

  const metadataSource = '- [ ] review [priority:: HIGH] [due:: 2026-10-01]';
  const metadata = state(metadataSource, metadataSource.length);
  const metadataToggle = toggleOrCreateTask(metadata);
  expect(metadataToggle?.newDoc.toString()).toBe('- [x] review [priority:: HIGH] [due:: 2026-10-01]');
  if (metadataToggle) expectReversible(metadata, metadataToggle);
});

test('Mod-Enter preserves a CRLF document separator while creating a task', () => {
  const before = state('first\r\n\r\nsecond', 'first\n\nsecond'.length, '\r\n');
  const transaction = toggleOrCreateTask(before);
  expect(transaction?.newDoc.toString()).toBe('first\n\n- [ ] second');
  expect(transaction?.state.sliceDoc()).toBe('first\r\n\r\n- [ ] second');
  if (transaction) expectReversible(before, transaction);
});

test('Mod-Enter does not create or toggle tasks in headings, code, envelopes, raw HTML, or tables', () => {
  const source = [
    '---',
    'title: Header',
    'body: - [ ] envelope value',
    '---',
    '# Heading text',
    '',
    '```md',
    '- [ ] fenced task',
    '```',
    '',
    'Raw <span>HTML</span> text',
    'Code `snippet` text',
    '- item <span>HTML</span>',
    '',
    '| task |',
    '| --- |',
    '| [ ] |',
    '',
    '<div>',
    'plain HTML content',
    '</div>',
  ].join('\n');
  for (const text of ['envelope value', 'Heading text', 'fenced task', 'HTML', '[ ]']) {
    const position = source.indexOf(text) + text.length;
    expect(toggleOrCreateTask(state(source, position))).toBeNull();
  }
  const codeText = source.indexOf('snippet') + 2;
  expect(toggleOrCreateTask(state(source, codeText))).toBeNull();
  const htmlList = source.indexOf('- item <span>HTML</span>') + '- item'.length;
  expect(toggleOrCreateTask(state(source, htmlList))).toBeNull();
  const htmlContent = source.indexOf('plain HTML content') + 4;
  expect(toggleOrCreateTask(state(source, htmlContent))).toBeNull();
});

test('task shortcuts do not edit task-looking source inside shared math, comment, or footnote nodes', () => {
  const contexts = [
    { node: 'GardenMathBlock', source: '$$\n- [ ] math block task\n$$' },
    { node: 'GardenMathInline', source: '$- [ ] inline math task$' },
    { node: 'GardenComment', source: '%%- [ ] comment task%%' },
    { node: 'GardenFootnoteDefinition', source: '[^note]: - [ ] footnote task' },
  ];

  for (const context of contexts) {
    const document = state(context.source);
    const parsedNames = new Set<string>();
    syntaxTree(document).iterate({ enter: (cursor) => { parsedNames.add(cursor.name); } });
    expect(parsedNames.has(context.node), `${context.node} is parsed by the shared grammar`).toBe(true);

    const taskMarker = context.source.indexOf('- [ ]');
    const contentStart = taskMarker + '- [ ] '.length;
    const contentEnd = context.source.length;
    expect(continueTaskOnEnter(state(context.source, contentEnd)), context.node).toBeNull();
    expect(removeTaskPrefixOnBackspace(state(context.source, contentStart)), context.node).toBeNull();
    expect(toggleOrCreateTask(state(context.source, contentEnd)), context.node).toBeNull();
  }
});

test('ordinary task lines can still contain shared wiki links and tags', () => {
  const source = '- [ ] Review [[Team/Note|read more]] #garden/tag';
  const contentStart = '- [ ] '.length;
  const document = state(source, source.length);
  const parsedNames = new Set<string>();
  syntaxTree(document).iterate({ enter: (cursor) => { parsedNames.add(cursor.name); } });
  expect(parsedNames.has('GardenWikiLink')).toBe(true);
  expect(parsedNames.has('GardenTag')).toBe(true);

  const continued = continueTaskOnEnter(document);
  expect(continued?.newDoc.toString()).toBe(`${source}\n- [ ] `);

  const removed = removeTaskPrefixOnBackspace(state(source, contentStart));
  expect(removed?.newDoc.toString()).toBe('Review [[Team/Note|read more]] #garden/tag');

  const toggled = toggleOrCreateTask(document);
  expect(toggled?.newDoc.toString()).toBe('- [x] Review [[Team/Note|read more]] #garden/tag');
});
