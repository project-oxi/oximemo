import { expect, test } from 'bun:test';
import { parseMarkdownDocument } from '@garden/markdown';
import { parseDocumentSource, patchDocumentBody, patchDocumentProperty } from '../src/document-model.js';

const previous = '2026-09-27T00:00:00.000Z';

function canonical(separator: '\n' | '\r\n' = '\n'): string {
  return [
    '---',
    'format: pdc-document/2',
    'body: pdc-markdown/1',
    'id: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db',
    'created: 2026-09-27T00:00:00.000Z',
    `updated: ${previous}`,
    'title: Original',
    '---',
    '# Original body',
    '',
  ].join(separator);
}

test('property no-ops keep bytes and real edits advance updated beyond the previous timestamp', () => {
  const source = canonical();
  expect(patchDocumentProperty(source, 'title', 'Original', new Date('2099-01-01T00:00:00.000Z'))).toBe(source);

  const changed = patchDocumentProperty(source, 'title', 'Changed', new Date(previous));
  const parsed = parseMarkdownDocument(changed);
  expect(parsed.kind).toBe('markdown');
  if (parsed.kind === 'markdown') expect(parsed.envelope.updated).toBe('2026-09-27T00:00:00.001Z');
});

test('body edits preserve CRLF and reject mixed endings or active HTML', () => {
  const lf = canonical('\n');
  const crlf = canonical('\r\n');

  const changed = patchDocumentBody(crlf, '# Revised\r\n', new Date(previous));
  expect(changed.endsWith('# Revised\r\n')).toBe(true);
  expect(parseDocumentSource(changed).editable).toBe(true);

  expect(() => patchDocumentBody(lf, '# Revised\r\n', new Date(previous))).toThrow(/mixed line endings/i);
  expect(() => patchDocumentBody(lf, '<script>alert(1)</script>\n', new Date(previous))).toThrow(/active HTML/i);
  const original = parseMarkdownDocument(lf);
  expect(original.kind).toBe('markdown');
  if (original.kind === 'markdown') expect(original.body).toBe('# Original body\n');
});
