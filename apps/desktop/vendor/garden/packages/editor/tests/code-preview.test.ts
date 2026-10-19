import { expect, test } from 'bun:test';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  codePreview,
  codePreviewFocusEffect,
  parseMarkdownCodeBlocks,
} from '../src/code-preview.js';

const labels = { copy: 'Copy code', copied: 'Copied', edit: 'Edit source' };

function stateFor(source: string) {
  const lineSeparator = source.includes('\r\n') ? EditorState.lineSeparator.of('\r\n') : [];
  return EditorState.create({ doc: source, extensions: [lineSeparator, markdown({ base: markdownLanguage })] });
}

function parse(source: string) {
  const state = stateFor(source);
  return parseMarkdownCodeBlocks(state.doc.toString(), syntaxTree(state));
}

function hasPreviewDecoration(state: EditorState): boolean {
  let found = false;
  for (const decorations of state.facet(EditorView.decorations)) {
    if (typeof decorations === 'function') continue;
    decorations.between(0, state.doc.length, () => {
      found = true;
    });
  }
  return found;
}

test('closed top-level fences preview their exact code and language without changing source', () => {
  const source = 'Before\r\n```ts title=sample\r\nconst markup = "<b>safe</b>";\r\n```\r\nAfter\r\n';
  const before = source;
  const state = stateFor(source);
  const [block] = parseMarkdownCodeBlocks(state.doc.toString(), syntaxTree(state));

  expect(block).toBeDefined();
  expect(block?.language).toBe('ts');
  expect(block?.code).toBe('const markup = "<b>safe</b>";');
  expect(state.sliceDoc(block?.codeFrom, block?.codeTo)).toBe('const markup = "<b>safe</b>";');
  expect(state.sliceDoc()).toBe(before);
  expect(source).toBe(before);
});

test('nested and incomplete fences remain in Markdown source', () => {
  const source = [
    '> ```js',
    '> alert(1)',
    '> ```',
    '',
    '- ```json',
    '  {"value":1}',
    '  ```',
    '',
    '~~~ts',
    'const unfinished = true;',
  ].join('\n');

  expect(parse(source)).toEqual([]);
});

test('valid top-level fence indentation and closing whitespace stay inside the replaceable source range', () => {
  const source = '  ```sh\nprintf \'ok\'\n  ``` \t\n';
  const normalized = stateFor(source);
  const [block] = parseMarkdownCodeBlocks(normalized.doc.toString(), syntaxTree(normalized));

  expect(block).toBeDefined();
  expect(block?.from).toBe(0);
  expect(block?.to).toBe(normalized.doc.line(3).to);
  expect(block?.language).toBe('sh');
});

test('preview hides only while selection is outside the code block and always preserves source', () => {
  const source = 'Before\n```js\nconst value = 1;\n```\nAfter\n';
  const original = source;
  const outside = source.indexOf('After');
  const initial = EditorState.create({
    doc: source,
    selection: EditorSelection.cursor(outside),
    extensions: [markdown({ base: markdownLanguage }), codePreview(labels)],
  });
  expect(hasPreviewDecoration(initial)).toBe(true);

  const focusedOutside = initial.update({ effects: [codePreviewFocusEffect.of(true)] }).state;
  expect(hasPreviewDecoration(focusedOutside)).toBe(true);

  const editingBlock = focusedOutside.update({
    selection: EditorSelection.cursor(source.indexOf('value')),
  }).state;
  expect(hasPreviewDecoration(editingBlock)).toBe(false);
  expect(editingBlock.doc.toString()).toBe(original);

  const editingAfter = editingBlock.update({
    selection: EditorSelection.cursor(outside),
  }).state;
  expect(hasPreviewDecoration(editingAfter)).toBe(true);

  const blurred = editingAfter.update({ effects: [codePreviewFocusEffect.of(false)] }).state;
  expect(hasPreviewDecoration(blurred)).toBe(true);
  expect(blurred.doc.toString()).toBe(original);
});
