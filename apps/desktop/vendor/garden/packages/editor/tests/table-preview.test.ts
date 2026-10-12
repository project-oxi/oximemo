import { expect, test } from 'bun:test';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  parseMarkdownTables,
  tablePreview,
  tablePreviewFocusEffect,
} from '../src/table-preview.js';

function tablesFor(source: string) {
  const state = EditorState.create({ doc: source, extensions: [markdown({ base: markdownLanguage })] });
  return parseMarkdownTables(state.doc.toString(), syntaxTree(state));
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

test('Lezer GFM tables retain escaped pipes and inline code while reading alignment from delimiter cells', () => {
  const source = [
    '| Name | Center | Right |',
    '| :--- | :----: | ----: |',
    '| alpha\\|beta | `code` | **bold** |',
    '',
  ].join('\n');
  const before = source;
  const [table] = tablesFor(source);

  expect(table).toBeDefined();
  expect(table?.header.map((cell) => cell.text)).toEqual(['Name', 'Center', 'Right']);
  expect(table?.alignments).toEqual(['left', 'center', 'right']);
  expect(table?.rows.map((row) => row.map((cell) => cell.text))).toEqual([['alpha|beta', 'code', 'bold']]);
  expect(table?.rows[0]?.[1]?.runs).toEqual([{ text: 'code', marks: ['code'] }]);
  expect(table?.rows[0]?.[2]?.runs).toEqual([{ text: 'bold', marks: ['strong'] }]);
  expect(source).toBe(before);
});

test('GFM empty cells stay in their original columns', () => {
  const source = '| A |  | C |\n| --- | --- | --- |\n| x || z |\n';
  const [table] = tablesFor(source);

  expect(table?.header.map((cell) => cell.text)).toEqual(['A', '', 'C']);
  expect(table?.rows.map((row) => row.map((cell) => cell.text))).toEqual([['x', '', 'z']]);
});

test('body rows with fewer or extra cells follow GFM column count', () => {
  const source = '| A | B |\n| --- | --- |\n| short |\n| x | y | ignored |\n';
  const [table] = tablesFor(source);

  expect(table?.rows.map((row) => row.map((cell) => cell.text))).toEqual([
    ['short', ''],
    ['x', 'y'],
  ]);
});

test('a table at the initial cursor previews while unfocused, reveals source on focus, and preserves source bytes', () => {
  const source = '| A | B |\n| --- | --- |\n| x | y |\n\nAfter\n';
  const original = source;
  const initial = EditorState.create({
    doc: source,
    extensions: [markdown({ base: markdownLanguage }), tablePreview('Edit table source')],
  });
  expect(hasPreviewDecoration(initial)).toBe(true);
  expect(initial.doc.toString()).toBe(original);

  const focused = initial.update({ effects: [tablePreviewFocusEffect.of(true)] }).state;
  expect(hasPreviewDecoration(focused)).toBe(false);
  expect(focused.doc.toString()).toBe(original);

  const movedOutsideTable = focused.update({
    selection: EditorSelection.cursor(source.indexOf('After')),
  }).state;
  expect(hasPreviewDecoration(movedOutsideTable)).toBe(true);
  expect(movedOutsideTable.doc.toString()).toBe(original);

  const blurred = movedOutsideTable.update({ effects: [tablePreviewFocusEffect.of(false)] }).state;
  expect(hasPreviewDecoration(blurred)).toBe(true);
  expect(blurred.doc.toString()).toBe(original);
});
