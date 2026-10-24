import { describe, expect, test } from 'bun:test'
import type { MemItem } from '../../../src/core/memory/brain'
import { PERSON_REGION_IDS, personRegionOf, personRegionOfKind, personRegionSummaries, profileFactCategory } from '../../../src/core/memory/person-brain'

const NOW = Date.UTC(2026, 9, 14, 12)

function item(over: Partial<MemItem> & Pick<MemItem, 'id' | 'kind' | 'title'>): MemItem {
  return {
    layer: 'person', summary: '', body: '', tags: [], sources: [], about: [], status: 'active', review: 'ok', importance: 3,
    created: '2026-10-10T10:00:00Z', updated: '2026-10-11T10:00:00Z', author: 'buracle', version: 1, history: [], ...over,
  }
}

describe('the person brain regions', () => {
  test('seven regions: how the user works on the left, what they know on the right, notes in the middle', () => {
    expect(PERSON_REGION_IDS).toEqual(['communication', 'collaboration', 'workflow', 'engineering', 'avoid', 'lessons', 'inbox'])
  })

  test('a profile fact goes to the region of its category tag, else of its summary', () => {
    expect(personRegionOf(item({ id: 'p1', kind: 'profile', title: 'Writes in Turkish', tags: ['communication', 'rank-1'] }))).toBe('communication')
    expect(personRegionOf(item({ id: 'p2', kind: 'profile', title: 'Works in Claude Code', summary: 'workflow · high' }))).toBe('workflow')
    expect(personRegionOf(item({ id: 'p3', kind: 'profile', title: 'Runs bun test', tags: ['quality', 'stated'] }))).toBe('engineering')
    expect(personRegionOf(item({ id: 'p4', kind: 'profile', title: 'Never push', tags: ['avoid'] }))).toBe('avoid')
    expect(personRegionOf(item({ id: 'p5', kind: 'profile', title: 'Feedback so far', summary: 'other · hypothesis' }))).toBe('collaboration')
    expect(personRegionOf(item({ id: 'p6', kind: 'profile', title: 'May like dark screens', summary: 'design · hypothesis' }))).toBe('collaboration')
    expect(profileFactCategory({ tags: ['hypothesis', 'engineering'], summary: 'workflow · high' })).toBe('engineering')
  })

  test('a preference that forbids something is to avoid; others follow their words', () => {
    expect(personRegionOf(item({ id: 'f1', kind: 'preference', title: 'Never use emojis in commit messages' }))).toBe('avoid')
    expect(personRegionOf(item({ id: 'f2', kind: 'preference', title: 'The user rejects AI slop UI design' }))).toBe('avoid')
    expect(personRegionOf(item({ id: 'f3', kind: 'preference', title: 'Keep answers short and concise' }))).toBe('communication')
    expect(personRegionOf(item({ id: 'f4', kind: 'preference', title: 'Run the tests before calling a change done' }))).toBe('engineering')
    expect(personRegionOf(item({ id: 'f5', kind: 'preference', title: 'Plan in a spec before big changes' }))).toBe('workflow')
  })

  test('cross-project lessons and notes to file go by kind', () => {
    for (const kind of ['gotcha', 'procedure', 'knowledge', 'reference', 'decision'] as const) expect(personRegionOf(item({ id: `k-${kind}`, kind, title: 'x' }))).toBe('lessons')
    for (const kind of ['capture', 'session', 'handoff'] as const) expect(personRegionOf(item({ id: `n-${kind}`, kind, title: 'x' }))).toBe('inbox')
    expect(personRegionOfKind('gotcha')).toBe('lessons')
    expect(personRegionOfKind('capture')).toBe('inbox')
    expect(personRegionOfKind('profile')).toBeUndefined()
    expect(personRegionOfKind('preference')).toBeUndefined()
  })

  test('the summaries count live memories and skip bookkeeping tags', () => {
    const items = [
      item({ id: 'a', kind: 'profile', title: 'Writes in Turkish', tags: ['communication', 'stated', 'rank-1'] }),
      item({ id: 'b', kind: 'profile', title: 'Maybe terse', tags: ['communication', 'hypothesis', 'rank-5'] }),
      item({ id: 'c', kind: 'preference', title: 'Keep answers short', tags: ['tone'] }),
      item({ id: 'd', kind: 'gotcha', title: 'Bun caches resolveSync', tags: ['bun'] }),
      item({ id: 'e', kind: 'gotcha', title: 'Gone', tags: ['bun'], status: 'deprecated' }),
    ]
    const s = personRegionSummaries(items, NOW)
    expect(s.map(r => r.region)).toEqual([...PERSON_REGION_IDS])
    expect(s[0]).toEqual({ region: 'communication', count: 3, groups: 1, topTags: ['tone'] })
    expect(s.find(r => r.region === 'lessons')).toMatchObject({ count: 1, topTags: ['bun'] })
    expect(s.find(r => r.region === 'inbox')?.count).toBe(0)
  })
})
