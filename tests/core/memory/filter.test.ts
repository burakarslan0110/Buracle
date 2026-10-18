import { describe, expect, test } from 'bun:test'
import type { MemItem } from '../../../src/core/memory/brain'
import { memAround, memCitesFile, memFilterPath, memMatchesFilter, memMatchesWords, memPage } from '../../../src/core/memory/filter'

function mem(id: string, over: Partial<MemItem> = {}): MemItem {
  return {
    id, kind: 'decision', layer: 'project', title: id, summary: '', body: '', tags: [], sources: [], about: [],
    status: 'active', review: 'pending', importance: 3, created: '2026-10-01T00:00:00.000Z', updated: '2026-10-01T00:00:00.000Z',
    author: 'agent', version: 1, history: [], ...over,
  }
}

const NOW = Date.parse('2026-10-17T00:00:00Z')

describe('memFilterPath', () => {
  test('keeps repository paths, drops line suffixes, ./ and trailing slashes', () => {
    expect(memFilterPath('src/a.ts:12-20')).toBe('src/a.ts')
    expect(memFilterPath('./src/memory/')).toBe('src/memory')
    expect(memFilterPath('docs/x.md#L4')).toBe('docs/x.md')
    expect(memFilterPath('src\\win\\path.ts')).toBe('src/win/path.ts')
  })

  test('refuses what is not a path inside the repository', () => {
    for (const bad of ['', '  ', '/abs/path.ts', 'C:\\x.ts', 'https://example.com/a', '../up.ts', 'a/../../b', '.']) expect(memFilterPath(bad)).toBeUndefined()
  })
})

describe('memCitesFile', () => {
  const m = mem('decision-a', { sources: ['src/memory/store.ts:121', 'src/core/', 'https://example.com/src/memory/api.ts', 'session:abc'] })
  test('a file, a folder that holds a cited file, and a file inside a cited folder match', () => {
    expect(memCitesFile(m, ['src/memory/store.ts'])).toBe(true)
    expect(memCitesFile(m, ['src/memory'])).toBe(true)
    expect(memCitesFile(m, ['src/core/memory/brain.ts'])).toBe(true)
    expect(memCitesFile(m, ['src/memory/api.ts'])).toBe(false)
    expect(memCitesFile(m, ['src/mem'])).toBe(false)
    expect(memCitesFile(m, [])).toBe(true)
  })
})

describe('memMatchesFilter', () => {
  test('tags and about ignore case; one hit of each list is enough; live only unless any', () => {
    const m = mem('gotcha-x', { kind: 'gotcha', tags: ['locks', 'store'], about: ['CortexDB'] })
    expect(memMatchesFilter(m, { tags: ['LOCKS', 'nope'] }, NOW)).toBe(true)
    expect(memMatchesFilter(m, { tags: ['nope'] }, NOW)).toBe(false)
    expect(memMatchesFilter(m, { about: ['cortexdb'], kinds: ['gotcha'] }, NOW)).toBe(true)
    expect(memMatchesFilter(m, { kinds: ['decision'] }, NOW)).toBe(false)
    const gone = { ...m, status: 'deprecated' as const }
    expect(memMatchesFilter(gone, {}, NOW)).toBe(false)
    expect(memMatchesFilter(gone, { any: true }, NOW)).toBe(true)
    expect(memMatchesFilter(m, { since: Date.parse('2026-10-02T00:00:00Z') }, NOW)).toBe(false)
    expect(memMatchesFilter(m, { until: Date.parse('2026-10-02T00:00:00Z') }, NOW)).toBe(true)
  })

  test('memMatchesWords finds a query word or its stem in the text, tags and about', () => {
    const m = mem('decision-y', { title: 'Backups run daily', about: ['sqlite'] })
    expect(memMatchesWords(m, 'backup')).toBe(true)
    expect(memMatchesWords(m, 'SQLite')).toBe(true)
    expect(memMatchesWords(m, 'postgres')).toBe(false)
  })
})

describe('memAround', () => {
  test('neighbors of the same layer by the time they were recorded, oldest first', () => {
    const items = [
      mem('a', { created: '2026-10-01T00:00:00Z' }), mem('b', { created: '2026-10-02T00:00:00Z', updated: '2026-10-09T00:00:00Z' }),
      mem('c', { created: '2026-10-03T00:00:00Z' }), mem('p', { created: '2026-10-03T12:00:00Z', layer: 'person' }),
      mem('d', { created: '2026-10-04T00:00:00Z', kind: 'gotcha' }), mem('e', { created: '2026-10-05T00:00:00Z' }),
    ]
    const c = items[2] as MemItem
    const r = memAround(items, c, 1)
    expect([...r.before, r.anchor, ...r.after].map(i => i.id)).toEqual(['b', 'c', 'd'])
    expect(memAround(items, c, 9).after.map(i => i.id)).toEqual(['d', 'e'])
    expect(memAround(items, c, 2, i => i.kind === 'decision').after.map(i => i.id)).toEqual(['e'])
  })
})

describe('memPage', () => {
  test('a window, its 1-based bounds and the total', () => {
    expect(memPage([1, 2, 3, 4, 5], 2, 2)).toEqual({ rows: [3, 4], from: 3, to: 4, total: 5 })
    expect(memPage([1, 2], 5, 3)).toEqual({ rows: [], from: 2, to: 2, total: 2 })
  })
})
