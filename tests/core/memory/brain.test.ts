import { describe, expect, test } from 'bun:test'
import {
  brainStartText, cortexAbout, cortexGraph, cortexImportance, cortexQuery, cortexReviewStatus, decodeBody, encodeContent, fromCortex, HANDOFF_KEEP_MS, hitLine, isLive, memLocked, memoryIdFor, memProtected,
  regionSummaries, searchTerms, SESSION_KEEP_MS, similarMemories, sourcePath, TERMS_OPEN, toCortexSave, ttlSeconds, utf8Length, type MemItem,
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

  test('an accepted memory always names its reviewer, because CortexDB refuses one that does not', () => {
    const generated = toCortexSave(item({ id: 'session-x', kind: 'session', title: 'S', author: 'buracle' }))
    expect(generated).toMatchObject({ review_status: 'accepted', reviewed_by: 'buracle', reviewed_at: iso(NOW - DAY) })
    const verified = toCortexSave(item({ id: 'decision-v', title: 'V', verifiedBy: 'claude-code', verifiedAt: iso(NOW) }))
    expect(verified).toMatchObject({ review_status: 'accepted', reviewed_by: 'claude-code', reviewed_at: iso(NOW) })
    const pending = toCortexSave(item({ id: 'decision-p', title: 'P', review: 'pending' }))
    expect(pending['review_status']).toBe('proposed')
    expect(pending).not.toHaveProperty('reviewed_by')
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

describe('source paths', () => {
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
})

describe('native expiry', () => {
  const session = (expires?: string) => item({ id: 'session-claude-abc123', kind: 'session', title: 'Session', author: 'buracle', ...(expires !== undefined ? { expires } : {}) })

  test('an expires date becomes CortexDB ttl_seconds counted from now, rounded up, never below 1', () => {
    expect(toCortexSave(session(iso(NOW + SESSION_KEEP_MS)), {}, NOW)['ttl_seconds']).toBe(45 * 86_400)
    expect(toCortexSave(session(iso(NOW + HANDOFF_KEEP_MS)), {}, NOW)['ttl_seconds']).toBe(14 * 86_400)
    expect(toCortexSave(session(iso(NOW + 1500)), {}, NOW)['ttl_seconds']).toBe(2)
    expect(toCortexSave(session(iso(NOW - DAY)), {}, NOW)['ttl_seconds']).toBe(1)
    expect(ttlSeconds(iso(NOW + 60_000), NOW)).toBe(60)
  })

  test('no ttl_seconds without an expires date, without a clock, or with a date that does not parse', () => {
    expect(toCortexSave(session(), {}, NOW)).not.toHaveProperty('ttl_seconds')
    expect(toCortexSave(session(iso(NOW + DAY)))).not.toHaveProperty('ttl_seconds')
    expect(toCortexSave(session('someday'), {}, NOW)).not.toHaveProperty('ttl_seconds')
    expect(ttlSeconds(undefined, NOW)).toBeUndefined()
    expect(ttlSeconds(iso(NOW), undefined)).toBeUndefined()
  })

  test('the expiry also stays in the metadata: a session row reads back with its date, and the native field is not stored as metadata', () => {
    const it = session(iso(NOW + SESSION_KEEP_MS))
    const save = toCortexSave(it, {}, NOW)
    expect(save['metadata']).toHaveProperty('expires', it.expires)
    expect(save['metadata']).not.toHaveProperty('ttl_seconds')
    const back = fromCortex({ id: save['memory_id'], content: save['content'], created_at: it.created, metadata: save['metadata'] }, 'project')
    expect(back?.expires).toBe(it.expires)
    expect(back).toEqual(it)
    expect(isLive(back as MemItem, NOW + SESSION_KEEP_MS - 1)).toBe(true)
    expect(isLive(back as MemItem, NOW + SESSION_KEEP_MS)).toBe(false)
  })

  test('a row written before native expiry (only a metadata expires date, no ttl) is hidden once the date has passed', () => {
    const raw = (expires: string) => ({ id: 'handoff-old', content: 'Handoff', metadata: { buracle: 1, type: 'handoff', title: 'Handoff', expires } })
    const passed = fromCortex(raw(iso(NOW - 1000)), 'project') as MemItem
    expect(passed.expires).toBe(iso(NOW - 1000))
    expect(isLive(passed, NOW)).toBe(false)
    expect(isLive(fromCortex(raw(iso(NOW + 1000)), 'project') as MemItem, NOW)).toBe(true)
  })
})

describe('origin and confidence', () => {
  const stated = () => item({ id: 'preference-short', kind: 'preference', layer: 'person', title: 'Short answers', origin: 'explicit', confidence: 0.8 })
  const read = (meta: Record<string, unknown>) => fromCortex({ id: 'preference-short', content: 'Short answers', metadata: { buracle: 1, type: 'preference', title: 'Short answers', ...meta } }, 'person') as MemItem

  test('both survive the CortexDB round trip as the origin and confidence metadata keys', () => {
    const save = toCortexSave(stated())
    expect(save['metadata']).toMatchObject({ origin: 'explicit', confidence: 0.8 })
    const back = fromCortex({ id: save['memory_id'], content: save['content'], created_at: stated().created, metadata: save['metadata'] }, 'person')
    expect(back).toEqual(stated())
    expect(read({ origin: 'inferred', confidence: 0 })).toMatchObject({ origin: 'inferred', confidence: 0 })
    expect(read({ confidence: 1 }).confidence).toBe(1)
  })

  test('a memory without them stores neither key', () => {
    const meta = toCortexSave(item({ id: 'decision-x', title: 'X' }))['metadata'] as Record<string, unknown>
    expect(meta).not.toHaveProperty('origin')
    expect(meta).not.toHaveProperty('confidence')
    expect(read({})).not.toHaveProperty('origin')
    expect(read({})).not.toHaveProperty('confidence')
  })

  test('an unknown origin and a confidence outside 0..1 or not a number are dropped, the rest of the row is kept', () => {
    const bad = read({ origin: 'x', confidence: 2 })
    expect(bad).not.toHaveProperty('origin')
    expect(bad).not.toHaveProperty('confidence')
    expect(bad.title).toBe('Short answers')
    expect(read({ confidence: -0.1 })).not.toHaveProperty('confidence')
    expect(read({ confidence: '0.5' })).not.toHaveProperty('confidence')
    expect(read({ origin: 'EXPLICIT' })).not.toHaveProperty('origin')
  })

  test('hitLine flags an explicit memory and one a background check contradicted', () => {
    expect(hitLine(item({ id: 'preference-a', kind: 'preference', layer: 'person', title: 'A', origin: 'explicit' }))).toEndWith('[person] (explicit)')
    expect(hitLine(item({ id: 'decision-b', title: 'B', origin: 'inferred' }))).toEndWith('[project]')
    expect(hitLine(item({ id: 'decision-c', title: 'C', review: 'pending', origin: 'explicit', contradictedAt: iso(NOW) }))).toEndWith('[project] (unverified, explicit, contradicts)')
  })
})

describe('locked and protected memories', () => {
  // [origin, pinned, review, locked, protected]
  const table: Array<[MemItem['origin'], boolean | undefined, MemItem['review'], boolean, boolean]> = [
    ['explicit', undefined, 'pending', true, true],
    ['explicit', false, 'pending', true, true],
    ['explicit', true, 'ok', true, true],
    ['inferred', true, 'pending', true, true],
    [undefined, true, 'pending', true, true],
    ['inferred', undefined, 'ok', false, true],
    [undefined, false, 'ok', false, true],
    ['inferred', undefined, 'pending', false, false],
    [undefined, undefined, 'pending', false, false],
    [undefined, false, 'pending', false, false],
  ]

  test('locked is the user\'s own words or pinned; protected is locked or verified', () => {
    for (const [origin, pinned, review, locked, prot] of table) {
      const m = item({ id: 'preference-x', title: 'x', review, ...(origin !== undefined ? { origin } : {}), ...(pinned !== undefined ? { pinned } : {}) })
      expect({ origin, pinned, review, locked: memLocked(m), protected: memProtected(m) }).toEqual({ origin, pinned, review, locked, protected: prot })
    }
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

  test('handoff, project and person parts in order, with ids; a person preference is listed like any other person memory', () => {
    const text = brainStartText({
      nowMs: NOW, maxBytes: 9600, maxLines: 150,
      handoff: { id: 'handoff-x', branch: 'main' },
      project: { slug: 'demo', items: project }, person,
    })
    const at = (s: string) => text.indexOf(s)
    expect(text).not.toContain('How the user works')
    expect(text).not.toContain('upkeep')
    expect(at('Handoff')).toBeLessThan(at('## Project memory: demo'))
    expect(at('## Project memory: demo')).toBeLessThan(at('## Person memory'))
    expect(text).toContain('(decision-a) (unverified)')
    expect(text).toContain('handoff-x')
    expect(text).toContain('(gotcha-bun)')
    expect(at('### Preferences')).toBeGreaterThan(at('## Person memory'))
    expect(text).toContain('- Short answers (preference-short)')
    expect(at('(preference-short)')).toBeLessThan(at('(gotcha-bun)'))
  })

  test('person preferences come before the other person kinds, and a retired one is not listed', () => {
    const text = brainStartText({
      nowMs: NOW, maxBytes: 9600, maxLines: 150,
      person: [
        item({ id: 'preference-old', kind: 'preference', layer: 'person', title: 'Old habit', status: 'deprecated' }),
        item({ id: 'knowledge-k', kind: 'knowledge', layer: 'person', title: 'Some knowledge' }),
        item({ id: 'preference-stated', kind: 'preference', layer: 'person', title: 'No emojis', origin: 'explicit', review: 'ok' }),
      ],
    })
    expect(text).toContain('- No emojis (preference-stated)')
    expect(text).not.toContain('preference-old')
    expect(text.indexOf('preference-stated')).toBeLessThan(text.indexOf('knowledge-k'))
  })

  test('the text stays within its budget', () => {
    const many = Array.from({ length: 300 }, (_, i) => item({ id: `decision-${i}`, title: `Decision number ${i} with a long title to fill the room`, summary: 'x'.repeat(100) }))
    const text = brainStartText({ nowMs: NOW, maxBytes: 2000, maxLines: 40, project: { slug: 'demo', items: many }, person: [] })
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

describe('what a save tells CortexDB beyond the text', () => {
  test('the review state is accepted once verified, and an inferred memory only by the user', () => {
    expect(cortexReviewStatus({ review: 'pending' })).toBe('proposed')
    expect(cortexReviewStatus({ review: 'ok', origin: 'explicit' })).toBe('accepted')
    expect(cortexReviewStatus({ review: 'ok' })).toBe('accepted')
    expect(cortexReviewStatus({ review: 'ok', origin: 'inferred', verifiedBy: 'codex' })).toBe('proposed')
    expect(cortexReviewStatus({ review: 'ok', origin: 'inferred', verifiedBy: 'user' })).toBe('accepted')
    const save = toCortexSave(item({ id: 'decision-a', title: 'A', review: 'ok', verifiedBy: 'user', verifiedAt: iso(NOW) }))
    expect(save).toMatchObject({ review_status: 'accepted', reviewed_by: 'user', reviewed_at: iso(NOW) })
    expect((save['metadata'] as Record<string, unknown>)['review']).toBe('ok')
    expect(toCortexSave(item({ id: 'decision-b', title: 'B', review: 'pending' }))).toMatchObject({ review_status: 'proposed' })
    expect(toCortexSave(item({ id: 'decision-b', title: 'B', review: 'pending' }))).not.toHaveProperty('reviewed_by')
  })

  test('what a memory is about, and the repository files its sources cite, become entities joined by about relations', () => {
    const g = cortexGraph({ about: ['Payments', 'payments', 'Retries'], sources: ['src/payments/retry.ts:10-20', 'https://example.com/doc', 'a1b2c3d4e5f', 'src/payments/retry.ts'] })
    expect(g.entities).toEqual([{ name: 'Payments', type: 'topic' }, { name: 'Retries', type: 'topic' }, { name: 'src/payments/retry.ts', type: 'file' }])
    expect(g.relations).toEqual([{ from: 'Payments', to: 'src/payments/retry.ts', type: 'about' }, { from: 'Retries', to: 'src/payments/retry.ts', type: 'about' }])
    // A relation never names an entity that is not in the list: the engine rejects the whole save for that.
    const names = new Set(g.entities.map(e => e.name))
    for (const r of g.relations) { expect(names.has(r.from)).toBe(true); expect(names.has(r.to)).toBe(true) }
    expect(cortexGraph({ about: [], sources: ['https://example.com/doc'] })).toEqual({ entities: [], relations: [] })
    expect(cortexGraph({ about: ['src/a.ts'], sources: ['src/a.ts'] }).relations).toEqual([])
  })

  test('a save carries the graph only when there is one, and the graph stays bounded', () => {
    expect(toCortexSave(item({ id: 'decision-a', title: 'A' }))).not.toHaveProperty('entities')
    expect(toCortexSave(item({ id: 'decision-a', title: 'A' }))).not.toHaveProperty('relations')
    const wide = cortexGraph({ about: Array.from({ length: 12 }, (_, n) => `topic ${n}`), sources: Array.from({ length: 20 }, (_, n) => `src/file${n}.ts`) })
    expect(wide.entities.length).toBeLessThanOrEqual(30)
    expect(wide.relations.length).toBeLessThanOrEqual(40)
    const save = toCortexSave(item({ id: 'decision-g', title: 'G', about: ['Payments'], sources: ['src/pay.ts'] }))
    expect(save['entities']).toEqual([{ name: 'Payments', type: 'topic' }, { name: 'src/pay.ts', type: 'file' }])
  })

  test('a search narrowed by about walks the graph from those topics; without topics it stays lexical', () => {
    const base = cortexQuery('retry storm', 10)
    expect(base['retrieval_mode']).toBe('lexical')
    expect(cortexAbout(base, [])).toBe(base)
    expect(cortexAbout(base, [' Payments ', ''])).toMatchObject({ retrieval_mode: 'graph', entity_names: ['Payments'], query: 'retry storm' })
  })
})
