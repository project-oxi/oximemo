import { describe, expect, test } from 'bun:test'
import { parseTaskMetadata, patchTaskMetadata } from '../src/index'

describe('task line metadata', () => {
  test('parses Dataview fields and normalizes uppercase enums without changing source', () => {
    const source = '- [ ] Review release [priority:: high] [due:: 2028-02-29] [onCompletion:: keep]'
    const parsed = parseTaskMetadata(source)

    expect(parsed.fields.map(({ key, rawValue, value, valid }) => ({ key, rawValue, value, valid }))).toEqual([
      { key: 'priority', rawValue: 'high', value: 'HIGH', valid: true },
      { key: 'due', rawValue: '2028-02-29', value: '2028-02-29', valid: true },
      { key: 'onCompletion', rawValue: 'keep', value: 'KEEP', valid: true },
    ])
    expect(source.slice(parsed.fields[0]!.range.from, parsed.fields[0]!.range.to)).toBe('[priority:: high]')
    expect(source.slice(parsed.fields[0]!.valueRange.from, parsed.fields[0]!.valueRange.to)).toBe('high')
    expect(parsed.issues).toEqual([])
    expect(source).toBe('- [ ] Review release [priority:: high] [due:: 2028-02-29] [onCompletion:: keep]')
  })

  test('leaves code spans, escaped brackets, links, images, wikilinks, and unknown fields alone', () => {
    const source = "- [ ] Task [priority:: HIGH] `[priority:: LOW]` \\[due:: 2026-09-27] [priority:: NONE](https://example.test) ![priority:: LOW](image.png) [Open [priority:: HIGH]](/task) [[due:: 2026-09-27]] [custom:: retained]"
    const parsed = parseTaskMetadata(source)

    expect(parsed.fields.map(({ key, value }) => [key, value])).toEqual([['priority', 'HIGH']])
    expect(source.slice(parsed.fields[0]!.range.from, parsed.fields[0]!.range.to)).toBe('[priority:: HIGH]')
  })

  test('reports malformed dates, enum values, empty values, and repeated keys', () => {
    const parsed = parseTaskMetadata('- [ ] Work [due:: 2025-02-29] [priority:: Urgent] [start:: ] [priority:: LOW]')

    expect(parsed.fields.map(({ key, value, valid }) => ({ key, value, valid }))).toEqual([
      { key: 'due', value: null, valid: false },
      { key: 'priority', value: null, valid: false },
      { key: 'start', value: null, valid: false },
      { key: 'priority', value: 'LOW', valid: true },
    ])
    expect(parsed.issues.map(({ code, key }) => [code, key])).toEqual([
      ['invalid-value', 'due'],
      ['invalid-value', 'priority'],
      ['invalid-value', 'start'],
      ['duplicate-field', 'priority'],
    ])
  })

  test('keeps ranges correct when a single line includes CRLF', () => {
    const source = '- [ ] Ship [due:: 2026-09-27]\r\n'
    const field = parseTaskMetadata(source).fields[0]!
    expect(source.slice(field.range.from, field.range.to)).toBe('[due:: 2026-09-27]')
    expect(patchTaskMetadata(source, 'due', '2026-10-01')).toBe('- [ ] Ship [due:: 2026-10-01]\r\n')
  })

  test('updates and removes only the selected property while preserving neighboring text', () => {
    const source = '- [ ] Ship  [priority:: high] [custom:: keep]  '
    expect(patchTaskMetadata(source, 'priority', 'HIGH')).toBe(source)
    expect(patchTaskMetadata(source, 'priority', null)).toBe('- [ ] Ship  [custom:: keep]  ')
    expect(patchTaskMetadata('a  [due:: 2026-01-01]  b', 'due', null)).toBe('a   b')
    expect(patchTaskMetadata('- [ ] Ship', 'due', '2026-09-27')).toBe('- [ ] Ship [due:: 2026-09-27]')
    expect(patchTaskMetadata('- [ ] Ship', 'priority', 'high')).toBe('- [ ] Ship [priority:: HIGH]')
    expect(patchTaskMetadata('- [ ] Ship [priority:: MEDIUM]', 'priority', 'high')).toBe('- [ ] Ship [priority:: HIGH]')
  })

  test('does not patch ambiguous duplicates or invalid values', () => {
    expect(patchTaskMetadata('- [ ] Work [priority:: HIGH] [priority:: LOW]', 'priority', 'MEDIUM')).toBeNull()
    expect(patchTaskMetadata('- [ ] Work [due:: 2026-02-30]', 'due', '2026-03-01')).toBe('- [ ] Work [due:: 2026-03-01]')
    expect(patchTaskMetadata('- [ ] Work', 'due', '2026-02-30')).toBeNull()
    expect(patchTaskMetadata('- [ ] Work', 'priority', 'URGENT')).toBeNull()
    expect(patchTaskMetadata('- [ ] Work', 'onCompletion', 'DELETE EVERYTHING')).toBeNull()
    expect(patchTaskMetadata('- [ ] Work\nsecond line', 'id', 'task-1')).toBeNull()
  })
})
