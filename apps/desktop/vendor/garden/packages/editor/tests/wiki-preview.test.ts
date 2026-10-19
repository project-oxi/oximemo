import { expect, test } from 'bun:test';
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { gardenMarkdownConfig, parseWikiTarget } from '@garden/markdown/syntax';
import { parseWikiPreviewNodes, wikiPreview, wikiPreviewFocusEffect } from '../src/wiki-preview.js';

function stateFor(source: string): EditorState {
  return EditorState.create({
    doc: source,
    extensions: [markdown({ base: commonmarkLanguage, extensions: [...gardenMarkdownConfig] }), wikiPreview()],
  });
}

function previewCount(state: EditorState): number {
  let count = 0;
  for (const decorations of state.facet(EditorView.decorations)) {
    if (typeof decorations === 'function') continue;
    decorations.between(0, state.doc.length, (_from, _to, decoration) => {
      if (decoration.spec.widget) count += 1;
    });
  }
  return count;
}

test('shared AST previews cover wiki tokens and omit escaped, code, and embed bodies', () => {
  const source = [
    '[[Notes/one#Heading|Alias]] #garden/topic %%visible note%% $x + 1$ [^note] ^block',
    '> [!warning] Keep this title',
    '> Keep this body',
    '',
    '[^note]: footnote text',
    '',
    '`[[inline]] #inline $inline$`',
    '',
    '```md',
    '[[fenced]] #fenced $fenced$',
    '```',
    '',
    '![[asset.png|preview]]',
    '\\[[escaped]]',
  ].join('\n');
  const state = stateFor(source);
  const nodes = parseWikiPreviewNodes(source, syntaxTree(state));

  expect(nodes.map(({ name, raw }) => [name, raw])).toEqual([
    ['GardenWikiLink', '[[Notes/one#Heading|Alias]]'],
    ['GardenTag', '#garden/topic'],
    ['GardenComment', '%%visible note%%'],
    ['GardenMathInline', '$x + 1$'],
    ['GardenFootnoteReference', '[^note]'],
    ['GardenBlockId', '^block'],
    ['GardenCalloutMarker', '[!warning]'],
    ['GardenFootnoteDefinition', '[^note]: footnote text'],
  ]);
  expect(state.doc.toString()).toBe(source);
  expect(parseWikiTarget('[[Notes/one#Heading|Alias]]')).toEqual({
    target: 'Notes/one#Heading',
    alias: 'Alias',
    heading: 'Heading',
    blockId: null,
    embedded: false,
  });
  expect(parseWikiTarget('[[Notes/one#^block-id]]')?.blockId).toBe('block-id');
});

test('active source lines reveal their exact wiki syntax while other previews remain', () => {
  const source = '[[note|alias]] #tag %%comment%% $x$ [^fn]\n\n[^fn]: footnote\nAfter';
  const state = stateFor(source);
  const initialCount = previewCount(state);
  expect(initialCount).toBeGreaterThan(4);

  const focusedElsewhere = state.update({
    selection: EditorSelection.cursor(source.indexOf('After')),
    effects: [wikiPreviewFocusEffect.of(true)],
  }).state;
  expect(previewCount(focusedElsewhere)).toBe(initialCount);
  expect(focusedElsewhere.doc.toString()).toBe(source);

  const focusedOnSourceLine = focusedElsewhere.update({
    selection: EditorSelection.cursor(source.indexOf('#tag')),
  }).state;
  // The inactive definition keeps its source-adjacent backlink widget.
  expect(previewCount(focusedOnSourceLine)).toBe(1);
  expect(focusedOnSourceLine.doc.toString()).toBe(source);
});

test('math block syntax is represented as one source-preserving block preview', () => {
  const source = '$$\nx^2 + 1\n$$\n\nAfter';
  const state = stateFor(source);
  const nodes = parseWikiPreviewNodes(source, syntaxTree(state));
  expect(nodes.map(({ name, raw }) => [name, raw])).toEqual([
    ['GardenMathBlock', '$$\nx^2 + 1\n$$'],
  ]);
  expect(previewCount(state)).toBe(1);
  expect(state.doc.toString()).toBe(source);
});

test('multiline comments use one whole-block preview and protect their contents', () => {
  const source = '%%\n[[hidden]]\n\nmore #hidden\n%%\n\nAfter';
  const state = stateFor(source);
  const nodes = parseWikiPreviewNodes(source, syntaxTree(state));
  expect(nodes.map(({ name, raw }) => [name, raw])).toEqual([
    ['GardenComment', '%%\n[[hidden]]\n\nmore #hidden\n%%'],
  ]);
  expect(previewCount(state)).toBe(1);

  const focusedInside = state.update({
    selection: EditorSelection.cursor(source.indexOf('more')),
    effects: [wikiPreviewFocusEffect.of(true)],
  }).state;
  expect(previewCount(focusedInside)).toBe(0);
  expect(focusedInside.doc.toString()).toBe(source);
});
