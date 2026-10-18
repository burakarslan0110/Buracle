import { describe, expect, test } from 'bun:test'
import { parse as parseYaml } from 'yaml'
import { parseFrontmatter, parseInline, renderFrontmatter, renderScalar, renderYamlBlock } from '../../src/core/frontmatter'

describe('parseFrontmatter', () => {
  test('document without frontmatter returns body untouched', () => {
    const r = parseFrontmatter('# Title\n\ntext\n')
    expect(r.hasFrontmatter).toBe(false)
    expect(r.data).toEqual({})
    expect(r.body).toBe('# Title\n\ntext\n')
  })

  test('unterminated frontmatter is treated as body', () => {
    const r = parseFrontmatter('---\nname: x\n# no close\n')
    expect(r.hasFrontmatter).toBe(false)
  })

  test('scalars, quoting and typing', () => {
    const md = [
      '---',
      'id: m-20261007-k3q9',
      'title: "Use FTS5: default index"',
      "quote: 'it''s fine'",
      'count: 42',
      'ratio: 0.5',
      'pin: true',
      'locked: false',
      'empty:',
      'nothing: null',
      'created: 2026-10-07T23:50:00+03:00',
      'url: https://mcp.grep.app',
      'plain: value # trailing comment',
      '# a comment line',
      '---',
      '# Body',
    ].join('\n')
    const r = parseFrontmatter(md)
    expect(r.hasFrontmatter).toBe(true)
    expect(r.data).toEqual({
      id: 'm-20261007-k3q9',
      title: 'Use FTS5: default index',
      quote: "it's fine",
      count: 42,
      ratio: 0.5,
      pin: true,
      locked: false,
      empty: null,
      nothing: null,
      created: '2026-10-07T23:50:00+03:00',
      url: 'https://mcp.grep.app',
      plain: 'value',
    })
    expect(r.body).toBe('# Body')
  })

  test('flow lists with quoted wikilinks and block lists', () => {
    const md = '---\nrelated: ["[[memory-architecture]]", "[[qmd]]"]\ntags: [topic/memory, topic/search]\nsources:\n  - docs/research/09-memory.md\n  - "https://github.com/tobi/qmd"\n---\n'
    const r = parseFrontmatter(md)
    expect(r.data.related).toEqual(['[[memory-architecture]]', '[[qmd]]'])
    expect(r.data.tags).toEqual(['topic/memory', 'topic/search'])
    expect(r.data.sources).toEqual(['docs/research/09-memory.md', 'https://github.com/tobi/qmd'])
  })

  test("Claude auto-memory nested metadata block", () => {
    const md = '---\nname: user-profile\ndescription: "Who the user is"\nmetadata:\n  type: user\n  originSessionId: b33bd797\n  modified: 2026-10-07T19:07:29.219Z\n---\n\nBody text.\n'
    const r = parseFrontmatter(md)
    expect(r.data.metadata).toEqual({ type: 'user', originSessionId: 'b33bd797', modified: '2026-10-07T19:07:29.219Z' })
    expect(r.body).toBe('Body text.\n')
  })

  test('folded and literal block scalars (skill descriptions)', () => {
    const md = '---\nname: spec\ndescription: >-\n  Plan, implement and verify\n  a feature end to end.\n\n  Second paragraph.\nnotes: |\n  line one\n  line two\nafter: ok\n---\n'
    const r = parseFrontmatter(md)
    expect(r.data.description).toBe('Plan, implement and verify a feature end to end.\nSecond paragraph.')
    expect(r.data.notes).toBe('line one\nline two\n')
    expect(r.data.after).toBe('ok')
  })

  test('block list at the same indentation as its key', () => {
    const r = parseFrontmatter('---\npaths:\n- "**/*.py"\n- "**/*.pyi"\nnext: 1\n---\n')
    expect(r.data.paths).toEqual(['**/*.py', '**/*.pyi'])
    expect(r.data.next).toBe(1)
  })

  test('CRLF input and BOM', () => {
    const r = parseFrontmatter('﻿---\r\nname: x\r\n---\r\nbody\r\n')
    expect(r.data.name).toBe('x')
    expect(r.hasFrontmatter).toBe(true)
  })

  test('double-quoted escapes', () => {
    expect(parseInline('"a\\"b\\nc\\u0041"')).toBe('a"b\ncA')
  })
})

describe('render', () => {
  test('scalar quoting rules', () => {
    expect(renderScalar('plain text')).toBe('plain text')
    expect(renderScalar('a: b')).toBe('"a: b"')
    expect(renderScalar('true')).toBe('"true"')
    expect(renderScalar('42')).toBe('"42"')
    expect(renderScalar('[[slug]]')).toBe('"[[slug]]"')
    expect(renderScalar('#tag')).toBe('"#tag"')
    expect(renderScalar('')).toBe('""')
    expect(renderScalar('2026-10-07T23:50:00+03:00')).toBe('2026-10-07T23:50:00+03:00')
    expect(renderScalar(3)).toBe('3')
    expect(renderScalar(false)).toBe('false')
    expect(renderScalar(null)).toBe('null')
  })

  test('preferred key order and lists', () => {
    const y = renderYamlBlock({ title: 'T', id: 'x', related: ['[[a]]', '[[b]]'], tags: ['t/1'] }, ['id', 'title'])
    expect(y).toBe('id: x\ntitle: T\nrelated: ["[[a]]", "[[b]]"]\ntags: [t/1]')
  })

  test('round trip through parse', () => {
    const data = {
      id: 'm-20261008-abcd',
      type: 'decision',
      title: 'Use SQLite FTS5: fast and local',
      status: 'active',
      pin: true,
      confidence: 'high',
      related: ['[[x]]', '[[y]]'],
      sources: ['src/a.ts:10', 'https://example.com/a#b'],
      metadata: { type: 'project', modified: '2026-10-08T00:00:00Z' },
      multi: 'line one\nline two',
    }
    const doc = renderFrontmatter(data, '# Heading\n\nText\n', ['id', 'type'])
    const r = parseFrontmatter(doc)
    expect(r.data).toEqual(data)
    expect(r.body).toBe('# Heading\n\nText\n')
  })
})

describe('rendered YAML reads back the same in Obsidian\'s parser', () => {
  const roundTrip = (key: string, value: unknown) => {
    const doc = renderFrontmatter({ id: 'm-20261008-abcd', [key]: value }, '# x\n')
    const yaml = /^---\n([\s\S]*?)\n---\n/.exec(doc)?.[1] ?? ''
    return { obsidian: (parseYaml(yaml) as Record<string, unknown>)[key], own: parseFrontmatter(doc).data[key] as unknown, yaml }
  }

  const lists: unknown[][] = [
    ['src/memory/index.ts:350-357, src/core/memory/query.ts:36', 'see [RFC 7231] section 6'],
    ['RFC 7231, section 6.5.1'], ['see [x] here'], ['{"a":1}'], ['https://example.com/?a=1,2'], ['Buracle, the harness'],
    ['a,b'], ['x]y'], ['{curly} start'], ['tail {'], ['plain', 'item: with colon', 'trailing:', '#tag', 'a #comment'],
    ['[[wiki-link]]', '[[other|alias]]'], ['0x1F', '.inf', '1e3', 'yes', 'null', ''], [1, true, null, 'mixed'],
  ]
  for (const list of lists) {
    test(`flow list ${JSON.stringify(list)}`, () => {
      const r = roundTrip('sources', list)
      expect(r.obsidian).toEqual(list)
      expect(r.own).toEqual(list)
    })
  }

  const scalars = ['0x1F', '0o17', '.inf', '-.Inf', '+.INF', '.NaN', '.nan', '0X1f', '1_000', '0b101', 'Use "foo" not bar', ':colon start',
    'trailing colon:', 'tab\tinside', '= equals', '<angle>', '| pipe', '> gt', 'yes', 'Y', '2026-10-08', '1234567', '12e4567', '~', 'NULL', 'True']
  for (const v of scalars) {
    test(`scalar ${JSON.stringify(v)}`, () => {
      const r = roundTrip('title', v)
      expect(r.obsidian).toBe(v)
      expect(r.own).toBe(v)
    })
  }

  const multiline = ['first\nsecond', 'first\n  second', '  indented first\nsecond', '\nleading blank', 'a\n\n\nb', 'ends with newline\n',
    'two trailing\n\n', 'a\n   ', 'tab\n\tline', 'ctrl\u0007bell\nx', 'crlf\r\nline']
  for (const v of multiline) {
    test(`multi-line ${JSON.stringify(v)}`, () => {
      const r = roundTrip('description', v)
      expect(r.obsidian).toBe(v)
      expect(r.own).toBe(v)
    })
  }

  test('escapes JSON.stringify emits are read back by Buracle\'s parser', () => {
    expect(parseInline('"a\\bb\\fc\\u0007d\\e"')).toBe('a\bb\fc\u0007d\u001b')
  })
})
