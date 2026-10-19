import { expect, test } from 'bun:test';
import { parseMarkdownDocument } from '@garden/markdown';
import {
  convertDocumentProperty,
  documentPropertyKind,
  editableDocumentPropertyKind,
  initialDocumentPropertyValue,
  parseDocumentSource,
  patchDocumentBody,
  patchDocumentProperty,
  removeDocumentProperty,
} from '../src/document-model.js';

const updated = '2026-09-27T11:22:33.444Z';
const originalUpdated = '2026-09-27T11:22:00.000Z';

function canonicalDocument(newline: '\n' | '\r\n' = '\n', body = '# Original\n'): string {
  return [
    '---',
    'format: pdc-document/2',
    'body: pdc-markdown/1',
    'id: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db',
    'created: 2026-09-27T11:00:00.000Z',
    `updated: ${originalUpdated}`,
    'title: Original',
    'tags: [garden, "two words"]',
    'custom: { owner: Garden, revision: 4 } # keep this comment',
    '---',
    body.replace(/\r?\n/g, newline),
  ].join(newline);
}

test('body edits preserve the complete envelope prefix except for updated and do nothing on a no-op', () => {
  const source = canonicalDocument('\r\n', '# Original\r\n');
  const model = parseDocumentSource(source);
  expect(model.editable).toBe(true);
  if (!model.editable) throw new Error('expected an editable document');
  expect(model.lineSeparator).toBe('\r\n');
  expect(model.document.body).toBe('# Original\r\n');
  expect(patchDocumentBody(source, model.document.body, new Date(updated))).toBe(source);

  const nextBody = '# Revised\r\n\r\nBody text.\r\n';
  const next = patchDocumentBody(source, nextBody, new Date(updated));
  const oldPrefix = source.slice(0, source.length - model.document.body.length);
  const expectedPrefix = oldPrefix.replace(`updated: ${originalUpdated}\r\n`, `updated: ${updated}\r\n`);
  expect(next).toBe(`${expectedPrefix}${nextBody}`);
  const parsed = parseMarkdownDocument(next);
  expect(parsed.kind).toBe('markdown');
  if (parsed.kind === 'markdown') expect(parsed.body).toBe(nextBody);
});

test('metadata edits update the value while preserving comments, unknown nested properties, and body bytes', () => {
  const source = canonicalDocument('\n', '# Body stays exact\n\nText.\n');
  const result = patchDocumentProperty(source, 'title', 'Changed title', new Date(updated));
  const parsed = parseMarkdownDocument(result);
  expect(parsed.kind).toBe('markdown');
  if (parsed.kind !== 'markdown') return;
  expect(parsed.envelope.title).toBe('Changed title');
  expect(parsed.envelope.updated).toBe(updated);
  expect(parsed.body).toBe('# Body stays exact\n\nText.\n');
  expect(result).toContain('custom: { owner: Garden, revision: 4 } # keep this comment');
});

test('string-array properties can be patched without flattening their type or changing the body', () => {
  const source = canonicalDocument('\n', '# Body stays exact\n');
  const withTags = patchDocumentProperty(source, 'tags', ['garden', 'review'], new Date(updated));
  const withAliases = patchDocumentProperty(withTags, 'aliases', ['Old title'], new Date(updated));
  const parsed = parseMarkdownDocument(withAliases);
  expect(parsed.kind).toBe('markdown');
  if (parsed.kind !== 'markdown') return;
  expect(parsed.envelope.tags).toEqual(['garden', 'review']);
  expect(parsed.envelope.aliases).toEqual(['Old title']);
  expect(parsed.body).toBe('# Body stays exact\n');
  expect(withAliases).toContain('custom: { owner: Garden, revision: 4 } # keep this comment');
});

test('mixed line endings and legacy source stay read-only, while unknown structured properties have a JSON fallback', () => {
  const mixed = canonicalDocument('\n').replace('title: Original\n', 'title: Original\r\n');
  const mixedModel = parseDocumentSource(mixed);
  expect(mixedModel.editable).toBe(false);
  if (!mixedModel.editable) expect(mixedModel.diagnostic.code).toBe('invalid_transport');

  const legacy = parseDocumentSource('# Plain Markdown\n');
  expect(legacy.editable).toBe(false);
  if (!legacy.editable) expect(legacy.result.kind).toBe('legacy');

  expect(documentPropertyKind({ owner: 'Garden', revision: 4 })).toBe('json');
  expect(documentPropertyKind(['garden', 'ui'])).toBe('string-list');
});

test('new scalar and string-list properties retain their selected PDC types and leave body bytes unchanged', () => {
  const source = canonicalDocument('\r\n', '# Exact body\r\n\r\nText.\r\n');
  const withText = patchDocumentProperty(source, 'status', 'in progress', new Date(updated));
  const withNumber = patchDocumentProperty(withText, 'priority', 3, new Date(updated));
  const withBoolean = patchDocumentProperty(withNumber, 'reviewed', false, new Date(updated));
  const withList = patchDocumentProperty(withBoolean, 'owners', ['Ada', 'Lin'], new Date(updated));
  const parsed = parseMarkdownDocument(withList);

  expect(parsed.kind).toBe('markdown');
  if (parsed.kind !== 'markdown') return;
  expect(parsed.envelope.status).toBe('in progress');
  expect(parsed.envelope.priority).toBe(3);
  expect(parsed.envelope.reviewed).toBe(false);
  expect(parsed.envelope.owners).toEqual(['Ada', 'Lin']);
  expect(parsed.envelope.updated).toBe('2026-09-27T11:22:33.447Z');
  expect(parsed.body).toBe('# Exact body\r\n\r\nText.\r\n');
  expect(withList).toContain('custom: { owner: Garden, revision: 4 } # keep this comment');
});

test('property type conversions are explicit and preserve reversible scalar or list values', () => {
  expect(editableDocumentPropertyKind('in progress')).toBe('text');
  expect(editableDocumentPropertyKind(2.5)).toBe('number');
  expect(editableDocumentPropertyKind(true)).toBe('boolean');
  expect(editableDocumentPropertyKind(['one', 'two'])).toBe('list');
  expect(editableDocumentPropertyKind(null)).toBe(null);
  expect(editableDocumentPropertyKind({ owner: 'Garden' })).toBe(null);
  expect(editableDocumentPropertyKind(['one', 2])).toBe(null);

  expect(convertDocumentProperty('2.5', 'number')).toBe(2.5);
  expect(convertDocumentProperty(2.5, 'text')).toBe('2.5');
  expect(convertDocumentProperty('true', 'boolean')).toBe(true);
  expect(convertDocumentProperty(true, 'text')).toBe('true');
  expect(convertDocumentProperty('owner', 'list')).toEqual(['owner']);
  expect(convertDocumentProperty(['owner'], 'text')).toBe('owner');

  expect(() => convertDocumentProperty('02', 'number')).toThrow();
  expect(() => convertDocumentProperty('yes', 'boolean')).toThrow();
  expect(() => convertDocumentProperty(['one', 'two'], 'text')).toThrow();
  expect(() => convertDocumentProperty(null, 'text')).toThrow();
  expect(() => convertDocumentProperty({ owner: 'Garden' }, 'list')).toThrow();
  expect(() => convertDocumentProperty(-0, 'text')).toThrow();

  expect(initialDocumentPropertyValue('text')).toBe('');
  expect(initialDocumentPropertyValue('number')).toBe(0);
  expect(initialDocumentPropertyValue('boolean')).toBe(false);
  expect(initialDocumentPropertyValue('list')).toEqual([]);
});

test('a type edit rejected by the PDC patcher leaves source, type, and timestamp unchanged', () => {
  const source = canonicalDocument();
  const added = patchDocumentProperty(source, 'customText', '1', new Date(updated));

  expect(() => patchDocumentProperty(added, 'custom', 'flat value', new Date(updated))).toThrow();
  const parsed = parseMarkdownDocument(added);
  expect(parsed.kind).toBe('markdown');
  if (parsed.kind !== 'markdown') return;
  expect(parsed.envelope.custom).toEqual({ owner: 'Garden', revision: 4 });
  expect(parsed.envelope.updated).toBe(updated);
});

test('removing an editable scalar property updates metadata while preserving comments and body', () => {
  const source = patchDocumentProperty(canonicalDocument('\n', '# Body remains\n'), 'obsolete', 'old', new Date(updated));
  const removed = removeDocumentProperty(source, 'obsolete', new Date('2026-09-27T11:23:00.000Z'));
  const parsed = parseMarkdownDocument(removed);

  expect(parsed.kind).toBe('markdown');
  if (parsed.kind !== 'markdown') return;
  expect(Object.hasOwn(parsed.envelope, 'obsolete')).toBe(false);
  expect(parsed.envelope.updated).toBe('2026-09-27T11:23:00.000Z');
  expect(parsed.body).toBe('# Body remains\n');
  expect(removed).toContain('custom: { owner: Garden, revision: 4 } # keep this comment');
});

test('removing a flow string list preserves neighboring source and CRLF body', () => {
  const source = patchDocumentProperty(canonicalDocument('\r\n', '# Keep\r\n'), 'topics', ['alpha', 'two words'], new Date(updated));
  const removed = removeDocumentProperty(source, 'topics', new Date('2026-09-27T11:23:00.000Z'));
  const parsed = parseMarkdownDocument(removed);
  expect(parsed.kind).toBe('markdown');
  if (parsed.kind !== 'markdown') throw new Error('expected Markdown');
  expect(Object.hasOwn(parsed.envelope, 'topics')).toBe(false);
  expect(parsed.body).toBe('# Keep\r\n');
  expect(removed).toContain('custom: { owner: Garden, revision: 4 } # keep this comment\r\n');
  expect(removed.replace(/\r\n/g, '')).not.toContain('\n');
});

test('list removal refuses comments, multiline collections and structured values', () => {
  for (const property of ['topics: [alpha] # keep', 'topics: [\n  alpha\n]', 'topics:\n  - alpha', 'topics: [{ nested: true }]']) {
    const source = canonicalDocument().replace('title: Original', `title: Original\n${property}`);
    expect(() => removeDocumentProperty(source, 'topics', new Date(updated))).toThrow();
  }
});
