import { gardenMarkdownConfig } from '@garden/markdown/syntax';
import { expect, test } from 'bun:test';
import { markdown, commonmarkLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { embedPreview, embedPreviewFocusEffect, embedPreviewRefreshEffect, parseMarkdownEmbeds } from '../src/embed-preview.js';
import { envelopeSyntax } from '../src/envelope-syntax.js';

function stateFor(source: string) {
  return EditorState.create({
    doc: source,
    extensions: [markdown({ base: commonmarkLanguage, extensions: [envelopeSyntax, gardenMarkdownConfig] })],
  });
}

function hasPreviewDecoration(state: EditorState): boolean {
  let found = false;
  for (const decorations of state.facet(EditorView.decorations)) {
    if (typeof decorations === 'function') continue;
    decorations.between(0, state.doc.length, () => { found = true; });
  }
  return found;
}

test('only standalone top-level image, wiki embed, and HTML blocks become previews', () => {
  const source = [
    '---',
    'format: pdc-document/2',
    '---',
    '',
    '![Photo](images/photo.png "Cover")',
    '',
    '![[notes/child.md|Child note]]',
    '',
    '> ![[quoted.png]]',
    '',
    '- ![[listed.png]]',
    '',
    '`![[inline.png]]`',
    '',
    '```md',
    '![[fenced.png]]',
    '```',
    '',
    '<section><strong>Safe</strong></section>',
    '',
    'Inline ![image](not-standalone.png)',
  ].join('\n');
  const state = stateFor(source);
  const blocks = parseMarkdownEmbeds(source, syntaxTree(state));

  expect(blocks.map(({ kind, ref, title }) => ({ kind, ref, title }))).toEqual([
    { kind: 'image', ref: 'images/photo.png', title: 'Cover' },
    { kind: 'wiki', ref: 'notes/child.md', title: 'Child note' },
    { kind: 'html', ref: undefined, title: undefined },
  ]);
  expect(blocks.map((block) => block.raw)).toEqual([
    '![Photo](images/photo.png "Cover")',
    '![[notes/child.md|Child note]]',
    '<section><strong>Safe</strong></section>',
  ]);
});

test('embed preview preserves source, resolves synchronously, and reveals only the selected block', () => {
  const source = '![[notes/child.md]]\n\nAfter';
  let resolveCount = 0;
  const state = EditorState.create({
    doc: source,
    extensions: [
      markdown({ base: commonmarkLanguage, extensions: [gardenMarkdownConfig] }),
      embedPreview({ resolve: (ref) => {
        resolveCount++;
        expect(ref).toBe('notes/child.md');
        return { kind: 'markdown', title: 'Child', source: '**embedded**' };
      } }),
    ],
  });
  expect(resolveCount).toBe(1);
  expect(hasPreviewDecoration(state)).toBe(true);
  expect(state.doc.toString()).toBe(source);

  const focusedOutside = state.update({
    selection: EditorSelection.cursor(source.indexOf('After')),
    effects: [embedPreviewFocusEffect.of(true)],
  }).state;
  expect(hasPreviewDecoration(focusedOutside)).toBe(true);

  const focusedInside = focusedOutside.update({
    selection: EditorSelection.cursor(source.indexOf('child')),
  }).state;
  expect(hasPreviewDecoration(focusedInside)).toBe(false);
  expect(focusedInside.doc.toString()).toBe(source);

  const beforeRefresh = resolveCount;
  const refreshed = focusedInside.update({ effects: [embedPreviewRefreshEffect.of(null)] }).state;
  expect(hasPreviewDecoration(refreshed)).toBe(false);
  expect(resolveCount).toBe(beforeRefresh + 1);
});
