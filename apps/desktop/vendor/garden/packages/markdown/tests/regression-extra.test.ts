import { expect, test } from 'bun:test';
import { createMarkdownDocument, parseMarkdownDocument, patchMarkdownEnvelope } from '../src/index.js';

const source = createMarkdownDocument({
  title: 'Original',
  id: '01998ce5-1200-7000-8000-000000000001',
  created: '2026-09-27T00:00:00.000Z',
  body: '# Body stays exact\n',
});

function patched(sourceText: string, patch: Record<string, unknown>) {
  const output = patchMarkdownEnvelope(sourceText, patch);
  const result = parseMarkdownDocument(output);
  expect(result.kind).toBe('markdown');
  if (result.kind !== 'markdown') throw new Error('metadata patch produced an unreadable document');
  return { output, envelope: result.envelope, body: result.body };
}

test('metadata patches encode multiline strings in a mapping value without changing their JSON value', () => {
  const value = 'first line\nsecond line\n';

  const updatedTitle = patched(source, { title: value });
  expect(updatedTitle.envelope.title).toBe(value);
  expect(updatedTitle.body).toBe('# Body stays exact\n');

  const addedProperty = patched(source, { custom: value });
  expect(addedProperty.envelope.custom).toBe(value);
  expect(addedProperty.body).toBe('# Body stays exact\n');
});

test('metadata patches encode YAML-sensitive scalar strings without changing their type or spelling', () => {
  for (const value of ['', 'true', '# heading', 'a: b', 'quote "inside"', ' leading space']) {
    const result = patched(source, { title: value });
    expect(result.envelope.title).toBe(value);
  }
});

test('updating a flow array retains its trailing comment and body bytes', () => {
  const withFlowArray = source.replace('title: Original\n', 'title: Original\ncustom: [old, "two words"] # retain this comment\n');
  const result = patched(withFlowArray, { custom: ['new: value', 'true', '한글'] });

  expect(result.envelope.custom).toEqual(['new: value', 'true', '한글']);
  expect(result.output).toContain('custom: ["new: value","true","한글"] # retain this comment');
  expect(result.body).toBe('# Body stays exact\n');
});

test('metadata insertion preserves CRLF envelope and body bytes', () => {
  const crlfSource = source.replaceAll('\n', '\r\n');
  const result = patched(crlfSource, { custom: 'new value' });

  expect(result.output.includes('\r\ncustom: new value\r\n')).toBe(true);
  expect(result.output.replaceAll('\r\n', '').includes('\n')).toBe(false);
  expect(result.body).toBe('# Body stays exact\r\n');
});

test('metadata insertion quotes a nonempty user-property key containing a line break', () => {
  const key = 'line\nbreak';
  const result = patched(source, { [key]: 'value' });

  expect(result.envelope[key]).toBe('value');
  expect(result.output).toContain('"line\\nbreak": value');
});
