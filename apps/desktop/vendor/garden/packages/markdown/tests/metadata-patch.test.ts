import { describe, expect, test } from 'bun:test'
import { createMarkdownDocument, parseMarkdownDocument, patchMarkdownEnvelope } from '../src/index'

const base = createMarkdownDocument({title:'Properties',id:'01998ce5-1200-7000-8000-000000000001',created:'2026-09-27T00:00:00.000Z',body:'Untouched **body**.\n'})
describe('property mutations', () => {
  test('appends multiple properties in requested order without changing body', () => {
    const output = patchMarkdownEnvelope(base,{tags:['design'],favorite:true,status:'draft'})
    const parsed = parseMarkdownDocument(output)
    expect(parsed.kind).toBe('markdown')
    if(parsed.kind !== 'markdown') throw new Error('Invalid output')
    expect(parsed.envelope.tags).toEqual(['design'])
    expect(parsed.envelope.favorite).toBe(true)
    expect(Object.keys(parsed.envelope).slice(-3)).toEqual(['tags','favorite','status'])
    expect(parsed.body).toBe('Untouched **body**.\n')
  })
  test('edits flow tags with YAML-sensitive strings and preserves unrelated comments', () => {
    const source = patchMarkdownEnvelope(base,{tags:['old']}).replace('title: Properties','title: Properties # retain me')
    const output = patchMarkdownEnvelope(source,{tags:['design: new','true','a,b','한글']})
    const parsed = parseMarkdownDocument(output)
    expect(parsed.kind).toBe('markdown')
    if(parsed.kind !== 'markdown') throw new Error('Invalid output')
    expect(parsed.envelope.tags).toEqual(['design: new','true','a,b','한글'])
    expect(output).toContain('title: Properties # retain me')
    expect(parsed.body).toBe('Untouched **body**.\n')
    expect(patchMarkdownEnvelope(output,{tags:parsed.envelope.tags})).toBe(output)
  })
  test('keeps structured block properties protected', () => {
    const source = base.replace('title: Properties','title: Properties\ncustom:\n  - one\n  - two')
    expect(() => patchMarkdownEnvelope(source,{custom:['three']})).toThrow()
  })
})
