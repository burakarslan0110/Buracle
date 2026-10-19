import { describe, expect, test } from 'bun:test'
import {
  brainStartText, cortexImportance, decodeBody, encodeContent, fromCortex, isLive, memoryIdFor, pruneCandidates, regionSummaries,
  duplicateTwins, searchTerms, similarMemories, sourcePath, TERMS_OPEN, toCortexSave, upkeepFindings, utf8Length, type MemItem,
} from '../../../src/core/memory/brain'

const NOW = Date.parse('2026-10-13T12:00:00Z')
const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()

function item(over: Partial<MemItem> & Pick<MemItem, 'id' | 'title'>): MemItem {
  return {
    kind: 'decision', layer: 'project', summary: '', body: '', tags: [], sources: [], about: [], status: 'active', review: 'ok',
    importance: 3, created: iso(NOW - DAY), updated: iso(NOW - DAY), author: 'agent', version: 1, history: [], ...over,
  }
}

describe('record encoding', () => {
  test('content carries the folded and stemmed words, and the body reads back without them', () => {
    const content = encodeContent('Kullanıcının yanıtları kısa olmalı', 'Türkçe cevap', 'Body text.')
    expect(content).toContain(TERMS_OPEN)
    const terms = content.slice(content.indexOf(TERMS_OPEN))
    expect(terms).toContain('yanitlari')
    expect(terms).toContain('yanit')
    expect(terms).toContain('kullanici')
    expect(decodeBody(content, 'Kullanıcının yanıtları kısa olmalı', 'Türkçe cevap')).toBe('Body text.')
  })

  test('search terms stem English inflections too', () => {
    expect(searchTerms('caching tests')).toEqual(expect.arrayContaining(['caching', 'cach', 'tests', 'test']))
  })

  test('a MemItem survives the CortexDB metadata round trip', () => {
    const it = item({ id: 'gotcha-x', kind: 'gotcha', title: 'X breaks', summary: 'one line', body: 'b', tags: ['t'], sources: ['src/a.ts:3'], importance: 5, pinned: true, verifiedCommit: 'abc1234', expires: iso(NOW + DAY) })
    const save = toCortexSave(it)
    expect(save['importance']).toBe(1)
    const back = fromCortex({ id: save['memory_id'], content: save['content'], created_at: it.created, importance: 1, metadata: save['metadata'] }, 'project')
    expect(back).toEqual(it)
  })

  test('a background check\'s finding is stored as contradicted_at and contradicted_note and reads back', () => {
    const it = item({ id: 'decision-x', title: 'X', review: 'pending', contradictedAt: iso(NOW), contradictedNote: 'src/a.ts no longer exports X' })
    const meta = toCortexSave(it)['metadata'] as Record<string, unknown>
    expect(meta['contradicted_at']).toBe(iso(NOW))
    expect(meta['contradicted_note']).toBe('src/a.ts no longer exports X')
    expect(fromCortex({ id: 'decision-x', content: 'X', metadata: meta }, 'project')).toMatchObject({ contradictedAt: iso(NOW), contradictedNote: 'src/a.ts no longer exports X' })
    expect(toCortexSave(item({ id: 'decision-y', title: 'Y' }))['metadata']).not.toHaveProperty('contradicted_at')
  })

  test('a record without Buracle metadata is not a memory of Buracle', () => {
    expect(fromCortex({ id: 'x', content: 'y', metadata: { kind: 'memory' } }, 'project')).toBeUndefined()
  })

  test('CortexDB importance maps 1..5 to 0.2..1', () => {
    expect(cortexImportance(1)).toBe(0.2)
    expect(cortexImportance(5)).toBe(1)
  })
})

describe('ids', () => {
  test('ids are kind plus a slug, made unique', () => {
    expect(memoryIdFor('decision', 'Use CortexDB per project', new Set())).toBe('decision-use-cortexdb-per-project')
    expect(memoryIdFor('decision', 'Use CortexDB per project', new Set(['decision-use-cortexdb-per-project']))).toBe('decision-use-cortexdb-per-project-2')
    expect(memoryIdFor('gotcha', 'Işık açık mı?', new Set())).toBe('gotcha-isik-acik-mi')
  })
})

describe('liveness and duplicates', () => {
  test('expired, deprecated and superseded memories are not live', () => {
    expect(isLive(item({ id: 'a', title: 'a' }), NOW)).toBe(true)
    expect(isLive(item({ id: 'a', title: 'a', expires: iso(NOW - 1) }), NOW)).toBe(false)
    expect(isLive(item({ id: 'a', title: 'a', status: 'deprecated' }), NOW)).toBe(false)
    expect(isLive(item({ id: 'a', title: 'a', status: 'superseded' }), NOW)).toBe(false)
  })

  test('a restated claim is a duplicate across inflections', () => {
    const existing = [item({ id: 'decision-a', title: 'Kararlar veritabanında tutulur', summary: 'Kararlar PostgreSQL veritabanında' })]
    expect(similarMemories({ kind: 'decision', title: 'Karar veritabanında tutulur', summary: 'Kararlar PostgreSQL veritabanında' }, existing, NOW).map(s => s.item.id)).toEqual(['decision-a'])
    expect(similarMemories({ kind: 'decision', title: 'Deploys go through CI', summary: 'only CI deploys' }, existing, NOW)).toEqual([])
  })
})

describe('upkeep', () => {
  const facts = (over: Partial<Parameters<typeof upkeepFindings>[1]> = {}) => ({ nowMs: NOW, missing: new Set<string>(), changed: new Map<string, string[]>(), ...over })

  test('each reason is found and comes with an action', () => {
    const items = [
      item({ id: 'capture-a', kind: 'capture', title: 'remember this', review: 'pending' }),
      item({ id: 'gotcha-gone', kind: 'gotcha', title: 'Gone file', sources: ['src/gone.ts:4'] }),
      item({ id: 'knowledge-changed', kind: 'knowledge', title: 'Changed file', sources: ['src/a.ts'] }),
      item({ id: 'decision-new', title: 'Fresh unverified', review: 'pending', created: iso(NOW - 60_000), updated: iso(NOW - 60_000) }),
      item({ id: 'decision-old', title: 'Old unverified', review: 'pending', created: iso(NOW - DAY) }),
      item({ id: 'procedure-stale', kind: 'procedure', title: 'Stale procedure', verifiedAt: iso(NOW - 200 * DAY) }),
    ]
    const out = upkeepFindings(items, facts({ missing: new Set(['src/gone.ts']), changed: new Map([['knowledge-changed', ['src/a.ts']]]) }))
    const reasons = Object.fromEntries(out.map(u => [u.id, u.reasons]))
    expect(reasons['capture-a']).toEqual(['capture'])
    expect(reasons['gotcha-gone']).toEqual(['source-missing'])
    expect(reasons['knowledge-changed']).toEqual(['source-changed'])
    expect(reasons['decision-old']).toEqual(['unverified'])
    expect(reasons['decision-new']).toBeUndefined()
    expect(reasons['procedure-stale']).toEqual(['stale'])
    for (const u of out) expect(u.action.length).toBeGreaterThan(10)
    expect(out[0]?.id).toBe('gotcha-gone')
  })

  test('duplicateTwins pairs memories across inflections through the title-word index and never core pages or captures', () => {
    const twins = duplicateTwins([
      item({ id: 'decision-a', kind: 'decision', title: 'Orders are stored in CockroachDB' }),
      item({ id: 'decision-b', kind: 'decision', title: 'The orders are stored in CockroachDB now' }),
      item({ id: 'gotcha-c', kind: 'gotcha', title: 'Memories are listed newest first' }),
      item({ id: 'gotcha-d', kind: 'gotcha', title: 'Memory listing is newest first' }),
      item({ id: 'core-brief', kind: 'core', title: 'Orders are stored in CockroachDB' }),
      item({ id: 'capture-e', kind: 'capture', title: 'Orders are stored in CockroachDB' }),
      item({ id: 'knowledge-f', kind: 'knowledge', title: 'Deploys go out on Tuesdays' }),
    ], NOW)
    expect(twins.get('decision-a')).toBe('decision-b')
    expect(twins.get('decision-b')).toBe('decision-a')
    expect(twins.get('gotcha-c')).toBe('gotcha-d')
    expect(twins.has('core-brief')).toBe(false)
    expect(twins.has('capture-e')).toBe(false)
    expect(twins.has('knowledge-f')).toBe(false)
  })

  test('two memories with the same claim are one duplicate item with its twin', () => {
    const out = upkeepFindings([
      item({ id: 'decision-a', title: 'Orders live in PostgreSQL', summary: 'orders in postgres' }),
      item({ id: 'decision-b', title: 'Orders live in PostgreSQL', summary: 'orders in postgres' }),
    ], facts())
    expect(out).toHaveLength(1)
    expect(out[0]?.reasons).toEqual(['duplicate'])
    expect(['decision-a', 'decision-b']).toContain(out[0]?.twin as string)
  })

  test('a settled memory is quiet whatever the verifier reason, also when its files changed since it was verified; other reasons stay loud', () => {
    const out = upkeepFindings([
      item({ id: 'knowledge-old', kind: 'knowledge', title: 'old', review: 'pending', created: iso(NOW - 9 * DAY) }),
      item({ id: 'gotcha-moved', kind: 'gotcha', title: 'moved', sources: ['src/a.ts'] }),
      item({ id: 'decision-wrong', kind: 'decision', title: 'wrong', review: 'pending', created: iso(NOW - 9 * DAY), contradictedAt: iso(NOW - DAY) }),
      item({ id: 'knowledge-gone', kind: 'knowledge', title: 'gone', sources: ['src/gone.ts', 'src/a.ts'] }),
    ], facts({ settled: new Set(['knowledge-old', 'gotcha-moved', 'decision-wrong', 'knowledge-gone']), missing: new Set(['src/gone.ts']), changed: new Map([['gotcha-moved', ['src/a.ts']], ['knowledge-gone', ['src/a.ts']]]) }))
    expect(out.find(u => u.id === 'knowledge-old')).toMatchObject({ reasons: ['unverified'], quiet: true })
    expect(out.find(u => u.id === 'gotcha-moved')).toMatchObject({ reasons: ['source-changed'], quiet: true })
    expect(out.find(u => u.id === 'decision-wrong')?.quiet).toBeUndefined()
    expect(out.find(u => u.id === 'knowledge-gone')?.quiet).toBeUndefined()
  })

  test('only project memories of the kinds the verifier checks are unverified or stale: nothing would ever check the others', () => {
    const old = { created: iso(NOW - 9 * DAY), updated: iso(NOW - 9 * DAY) }
    const out = upkeepFindings([
      item({ id: 'preference-tabs', kind: 'preference', layer: 'person', title: 'Tabs over spaces', review: 'pending', ...old }),
      item({ id: 'knowledge-person', kind: 'knowledge', layer: 'person', title: 'A crash-aware client restarts its helper', review: 'pending', ...old }),
      item({ id: 'decision-person-old', kind: 'decision', layer: 'person', title: 'Old person decision', verifiedAt: iso(NOW - 200 * DAY) }),
      item({ id: 'core-progress', kind: 'core', title: 'Progress', review: 'pending', ...old }),
      item({ id: 'core-architecture', kind: 'core', title: 'Architecture', verifiedAt: iso(NOW - 200 * DAY) }),
      item({ id: 'gotcha-project', kind: 'gotcha', title: 'A project gotcha', review: 'pending', ...old }),
    ], facts())
    expect(out.map(u => [u.id, u.reasons])).toEqual([['gotcha-project', ['unverified']]])
  })

  test('a pair marked distinct is not a duplicate', () => {
    const pair = [item({ id: 'decision-a', title: 'Orders live in PostgreSQL', summary: 'orders in postgres' }), item({ id: 'decision-b', title: 'Orders live in PostgreSQL', summary: 'orders in postgres' })]
    expect(upkeepFindings(pair, facts()).map(u => u.reasons)).toEqual([['duplicate']])
    expect(upkeepFindings(pair, facts({ distinct: new Set(['decision-a|decision-b']) }))).toEqual([])
  })

  test('a decision kept although the code disagrees is quiet while nothing else is wrong with it', () => {
    const out = upkeepFindings([item({ id: 'decision-kept', kind: 'decision', title: 'kept', review: 'pending', created: iso(NOW - 9 * DAY), tags: ['code-disagrees'] })], facts())
    expect(out.find(u => u.id === 'decision-kept')).toMatchObject({ reasons: ['unverified'], quiet: true })
  })

  test('generated memories are never upkeep', () => {
    expect(upkeepFindings([item({ id: 'session-x', kind: 'session', title: 's', review: 'pending', created: iso(NOW - 9 * DAY) })], facts())).toEqual([])
  })

  test('sourcePath keeps repository paths only', () => {
    expect(sourcePath('src/a.ts:10-20')).toBe('src/a.ts')
    expect(sourcePath('docs/DESIGN.md:68,343-344')).toBe('docs/DESIGN.md')
    expect(sourcePath('src/memory/api.ts:281-303,388-390')).toBe('src/memory/api.ts')
    expect(sourcePath('src/a.ts:12:5')).toBe('src/a.ts')
    expect(sourcePath('src/a.ts#L12-L20')).toBe('src/a.ts')
    expect(sourcePath('./docs/x.md')).toBe('docs/x.md')
    expect(sourcePath('https://example.com/a.ts')).toBeUndefined()
    expect(sourcePath('abc1234')).toBeUndefined()
    expect(sourcePath('/abs/path.ts')).toBeUndefined()
    expect(sourcePath('README')).toBeUndefined()
  })

  test('a pending memory a background check contradicted comes first, with its note as one clipped line', () => {
    const out = upkeepFindings([
      item({ id: 'gotcha-gone', kind: 'gotcha', title: 'Gone file', sources: ['src/gone.ts'] }),
      item({ id: 'decision-wrong', title: 'Wrong claim', review: 'pending', created: iso(NOW - DAY), contradictedAt: iso(NOW - 60_000), contradictedNote: `the code says otherwise\n${'x'.repeat(400)}` }),
      item({ id: 'decision-fixed', title: 'Fixed claim', review: 'ok', contradictedAt: iso(NOW - DAY) }),
    ], facts({ missing: new Set(['src/gone.ts']) }))
    expect(out.map(u => u.id)).toEqual(['decision-wrong', 'gotcha-gone'])
    const [first] = out
    expect(first?.reasons).toEqual(['contradicted'])
    expect(first?.action).toContain('contradicted by the code')
    expect(first?.note?.startsWith('the code says otherwise x')).toBe(true)
    expect(first?.note).not.toContain('\n')
    expect((first?.note ?? '').length).toBeLessThanOrEqual(200)
  })

  test('the unverified grace counts from the last change, not from the creation', () => {
    const old = { review: 'pending' as const, created: iso(NOW - 10 * DAY) }
    const out = upkeepFindings([
      item({ id: 'decision-rewritten', title: 'Rewritten an hour ago', ...old, updated: iso(NOW - 3600_000) }),
      item({ id: 'decision-untouched', title: 'Untouched for a week', ...old, updated: iso(NOW - 7 * DAY) }),
    ], facts())
    expect(out.map(u => [u.id, u.reasons])).toEqual([['decision-untouched', ['unverified']]])
  })

})

describe('pruning', () => {
  test('expired, long-retired and surplus episodes go; pinned ones stay', () => {
    const items: MemItem[] = [
      item({ id: 'session-old', kind: 'session', title: 's', expires: iso(NOW - 1) }),
      item({ id: 'decision-retired', title: 'r', status: 'superseded', supersededAt: iso(NOW - 31 * DAY) }),
      item({ id: 'decision-recent', title: 'r2', status: 'deprecated', deprecatedAt: iso(NOW - 5 * DAY) }),
      item({ id: 'gotcha-pinned', kind: 'gotcha', title: 'p', status: 'deprecated', deprecatedAt: iso(NOW - 90 * DAY), pinned: true }),
      ...Array.from({ length: 42 }, (_, i) => item({ id: `session-${i}`, kind: 'session', title: `s${i}`, created: iso(NOW - i * 60_000) })),
    ]
    const out = pruneCandidates(items, NOW)
    const ids = out.map(p => p.id)
    expect(ids).toContain('session-old')
    expect(ids).toContain('decision-retired')
    expect(ids).not.toContain('decision-recent')
    expect(ids).not.toContain('gotcha-pinned')
    expect(out.filter(p => p.reason === 'excess-session').map(p => p.id).sort()).toEqual(['session-40', 'session-41'])
  })
})

describe('the session-start text', () => {
  const project = [
    item({ id: 'core-commands', kind: 'core', title: 'Commands', summary: 'bun test', body: 'x' }),
    item({ id: 'decision-a', title: 'Decision A', summary: 'why A', review: 'pending' }),
    item({ id: 'gotcha-b', kind: 'gotcha', title: 'Gotcha B' }),
    item({ id: 'session-c', kind: 'session', title: 'claude-code session', summary: 'Outcome: tests passed.' }),
  ]
  const person = [item({ id: 'preference-short', kind: 'preference', layer: 'person', title: 'Short answers' }), item({ id: 'gotcha-bun', kind: 'gotcha', layer: 'person', title: 'Bun gotcha' })]

  test('profile, handoff, project and person parts in order, with ids', () => {
    const text = brainStartText({
      nowMs: NOW, maxBytes: 9600, maxLines: 150, profile: ['- Short answers', '- Writes mostly in Turkish'],
      handoff: { id: 'handoff-x', branch: 'main' },
      project: { slug: 'demo', items: project }, person,
    })
    const at = (s: string) => text.indexOf(s)
    expect(at('## How the user works')).toBeLessThan(at('Handoff'))
    expect(at('Handoff')).toBeLessThan(at('## Project memory: demo'))
    expect(text).not.toContain('upkeep')
    expect(at('## Project memory: demo')).toBeLessThan(at('## Person memory'))
    expect(text).toContain('(decision-a) (unverified)')
    expect(text).toContain('handoff-x')
    expect(text).toContain('(gotcha-bun)')
    expect(text).not.toContain('(preference-short)')
  })

  test('the text stays within its budget', () => {
    const many = Array.from({ length: 300 }, (_, i) => item({ id: `decision-${i}`, title: `Decision number ${i} with a long title to fill the room`, summary: 'x'.repeat(100) }))
    const text = brainStartText({ nowMs: NOW, maxBytes: 2000, maxLines: 40, profile: [], project: { slug: 'demo', items: many }, person: [] })
    expect(utf8Length(text)).toBeLessThanOrEqual(2001)
    expect(text.split('\n').length).toBeLessThanOrEqual(41)
  })
})

describe('regions', () => {
  test('every region is summarized with counts, groups and top tags', () => {
    const r = regionSummaries([item({ id: 'decision-a', title: 'a', tags: ['db', 'orders'] }), item({ id: 'decision-b', title: 'b', tags: ['db'] }), item({ id: 'gotcha-c', kind: 'gotcha', title: 'c' })], NOW)
    expect(r).toHaveLength(7)
    const plans = r.find(x => x.region === 'plans')
    expect(plans).toEqual({ region: 'plans', count: 2, groups: 2, topTags: ['db', 'orders'] })
    expect(r.find(x => x.region === 'warnings')?.count).toBe(1)
  })

  test('a project\'s You & preferences region holds the user\'s preferences for that project and the habits learned there', () => {
    const r = regionSummaries([
      item({ id: 'preference-a', kind: 'preference', title: 'Keep the memory graph-first' }),
      item({ id: 'convention-b', kind: 'convention', title: 'Runs bun test before every commit', author: 'buracle' }),
      item({ id: 'procedure-c', kind: 'procedure', title: 'Release steps' }),
    ], NOW)
    expect(r.find(x => x.region === 'self')?.count).toBe(2)
    expect(r.find(x => x.region === 'skills')?.count).toBe(1)
  })
})
