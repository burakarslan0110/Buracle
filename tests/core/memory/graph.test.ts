import { describe, expect, test } from 'bun:test'
import { memSimilarity, type MemItem } from '../../../src/core/memory/brain'
import { memGraph, type MemGraph, type MemGraphEdge, type MemGraphEntityNode, type MemGraphMemoryNode } from '../../../src/core/memory/graph'

const NOW = Date.parse('2026-10-13T12:00:00Z')
const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()

function item(over: Partial<MemItem> & Pick<MemItem, 'id' | 'title'>): MemItem {
  return {
    kind: 'decision', layer: 'project', summary: '', body: '', tags: [], sources: [], about: [], status: 'active', review: 'ok',
    importance: 3, created: iso(NOW - 2 * DAY), updated: iso(NOW - DAY), author: 'agent', version: 1, history: [], ...over,
  }
}

const memoryNodes = (g: MemGraph) => g.nodes.filter((n): n is MemGraphMemoryNode => n.type === 'memory')
const entityNodes = (g: MemGraph) => g.nodes.filter((n): n is MemGraphEntityNode => n.type !== 'memory')
const memIds = (g: MemGraph) => memoryNodes(g).map(n => n.id)
const edgesOf = (g: MemGraph, kind: MemGraphEdge['kind']) => g.edges.filter(e => e.kind === kind).map(e => ({ source: e.source, target: e.target }))

function assertConsistent(g: MemGraph): void {
  const ids = new Set(g.nodes.map(n => n.id))
  expect(ids.size).toBe(g.nodes.length)
  for (const e of g.edges) {
    expect(ids.has(e.source)).toBe(true)
    expect(ids.has(e.target)).toBe(true)
    expect(e.source).not.toBe(e.target)
  }
  for (const n of g.nodes) expect(n.degree).toBe(g.edges.filter(e => e.source === n.id || e.target === n.id).length)
  const pairs = g.edges.map(e => `${e.kind}|${[e.source, e.target].sort().join('|')}`)
  expect(new Set(pairs).size).toBe(pairs.length)
  expect(g.stats).toEqual({ memories: memoryNodes(g).length, entities: entityNodes(g).length, edges: g.edges.length })
}

describe('which memories', () => {
  test('only live memories: deprecated, superseded and expired ones are left out, and every id comes from the input', () => {
    const items = [
      item({ id: 'decision-live', title: 'Live decision', body: 'see decision-old and decision-gone' }),
      item({ id: 'decision-old', title: 'Old decision', status: 'deprecated' }),
      item({ id: 'decision-gone', title: 'Gone decision', status: 'superseded', supersededBy: 'decision-live' }),
      item({ id: 'decision-expired', title: 'Expired decision', expires: iso(NOW - 1) }),
    ]
    const upkeep = new Map([['decision-live', { reasons: ['duplicate'], twin: 'decision-elsewhere' }], ['decision-unknown', { reasons: ['unverified'] }]])
    const g = memGraph(items, { nowMs: NOW, upkeep })
    expect(memIds(g)).toEqual(['decision-live'])
    expect(g.edges).toEqual([])
    const input = new Set(items.map(i => i.id))
    for (const n of memoryNodes(g)) expect(input.has(n.id)).toBe(true)
    expect(JSON.stringify(g)).not.toContain('decision-elsewhere')
    expect(JSON.stringify(g)).not.toContain('decision-unknown')
    assertConsistent(g)
  })

  test('a memory node carries its kind, region, flags and recall count', () => {
    const items = [
      item({ id: 'gotcha-a', kind: 'gotcha', title: 'A', review: 'pending', importance: 5, pinned: true, recallCount: 7 }),
      item({ id: 'session-codex-abc123', kind: 'session', title: 'Session', review: 'pending', author: 'buracle' }),
      item({ id: 'decision-b', title: 'B' }),
    ]
    const g = memGraph(items, { nowMs: NOW, upkeep: new Map([['decision-b', { reasons: ['stale'] }]]) })
    const byId = new Map(memoryNodes(g).map(n => [n.id, n]))
    expect(byId.get('gotcha-a')).toEqual({ id: 'gotcha-a', type: 'memory', kind: 'gotcha', region: 'warnings', title: 'A', importance: 5, unverified: true, upkeep: false, pinned: true, recallCount: 7, focus: true, degree: 0 })
    expect(byId.get('session-codex-abc123')).toMatchObject({ region: 'episodes', unverified: false, pinned: false, recallCount: 0 })
    expect(byId.get('decision-b')).toMatchObject({ region: 'plans', upkeep: true, unverified: false })
  })

  test('a region keeps its own memories in focus, best first: pinned, then importance, then the newest', () => {
    const items = [
      item({ id: 'decision-new', title: 'New', updated: iso(NOW - 1000) }),
      item({ id: 'decision-old', title: 'Old', updated: iso(NOW - 9 * DAY) }),
      item({ id: 'decision-important', title: 'Important', importance: 5, updated: iso(NOW - 20 * DAY) }),
      item({ id: 'decision-pinned', title: 'Pinned', importance: 1, pinned: true, updated: iso(NOW - 30 * DAY) }),
      item({ id: 'gotcha-other', kind: 'gotcha', title: 'Other region' }),
    ]
    const g = memGraph(items, { nowMs: NOW, region: 'plans' })
    expect(g.region).toBe('plans')
    expect(memIds(g)).toEqual(['decision-pinned', 'decision-important', 'decision-new', 'decision-old'])
    expect(memoryNodes(g).every(n => n.focus)).toBe(true)
    expect(g.truncated).toBe(false)
  })

  test('without a region every live memory is in focus (the whole brain)', () => {
    const items = [
      item({ id: 'decision-a', title: 'A', body: 'links gotcha-b' }),
      item({ id: 'gotcha-b', kind: 'gotcha', title: 'B' }),
      item({ id: 'preference-c', kind: 'preference', layer: 'person', title: 'C' }),
    ]
    const g = memGraph(items, { nowMs: NOW })
    expect(g.region).toBeNull()
    expect(memIds(g).sort()).toEqual(['decision-a', 'gotcha-b', 'preference-c'])
    expect(memoryNodes(g).every(n => n.focus)).toBe(true)
    assertConsistent(g)
  })
})

describe('memory-to-memory edges', () => {
  test('supersedes: from the replacing memory to the one it replaced, only while both are live', () => {
    const items = [
      item({ id: 'decision-first', title: 'First', supersededBy: 'decision-second' }),
      item({ id: 'decision-second', title: 'Second' }),
      item({ id: 'decision-third', title: 'Third', supersededBy: 'decision-missing' }),
    ]
    const g = memGraph(items, { nowMs: NOW })
    expect(edgesOf(g, 'supersedes')).toEqual([{ source: 'decision-second', target: 'decision-first' }])
    expect(g.edges.find(e => e.kind === 'supersedes')?.weight).toBe(1)
  })

  test('related: a link to a superseded memory is drawn to its live survivor; a link whose chain ends nowhere draws nothing', () => {
    const items = [
      item({ id: 'decision-keeps', title: 'Keeps', sources: ['memory:knowledge-old', 'memory:knowledge-gone'] }),
      item({ id: 'knowledge-old', title: 'Old', status: 'superseded', supersededBy: 'knowledge-older' }),
      item({ id: 'knowledge-older', title: 'Older', status: 'superseded', supersededBy: 'knowledge-new' }),
      item({ id: 'knowledge-new', title: 'New' }),
      item({ id: 'knowledge-gone', title: 'Gone', status: 'superseded', supersededBy: 'knowledge-missing' }),
    ]
    const g = memGraph(items, { nowMs: NOW })
    expect(edgesOf(g, 'related')).toEqual([{ source: 'decision-keeps', target: 'knowledge-new' }])
    assertConsistent(g)
  })

  test('mentions: a live id in the summary or the body as a whole token, never a longer id or a bare word', () => {
    const items = [
      item({ id: 'decision-a', title: 'A', body: 'Follows `decision-b`, (see decision-c). Not decision-bb nor xdecision-c nor decision-c-2.' }),
      item({ id: 'decision-b', title: 'B' }),
      item({ id: 'decision-c', title: 'C' }),
      item({ id: 'decision-d', title: 'D', summary: 'replaces decision-a; mentions itself: decision-d' }),
      item({ id: 'notes', title: 'A bare word id' }),
      item({ id: 'decision-e', title: 'E', body: 'some notes here, and decision-b again' }),
      item({ id: 'decision-f', title: 'F', body: 'decision-e' }),
    ]
    const g = memGraph(items, { nowMs: NOW })
    expect(edgesOf(g, 'mentions')).toEqual([
      { source: 'decision-a', target: 'decision-b' },
      { source: 'decision-a', target: 'decision-c' },
      { source: 'decision-d', target: 'decision-a' },
      { source: 'decision-e', target: 'decision-b' },
      { source: 'decision-f', target: 'decision-e' },
    ])
    assertConsistent(g)
  })

  test('one edge per pair and kind: two memories that mention each other are linked once', () => {
    const g = memGraph([
      item({ id: 'decision-a', title: 'A', body: 'decision-b decision-b' }),
      item({ id: 'decision-b', title: 'B', body: 'decision-a' }),
    ], { nowMs: NOW })
    expect(edgesOf(g, 'mentions')).toEqual([{ source: 'decision-a', target: 'decision-b' }])
  })

  test('twin: the upkeep queue links a likely duplicate to its twin', () => {
    const g = memGraph([item({ id: 'decision-a', title: 'Alpha' }), item({ id: 'decision-b', title: 'Beta' })], {
      nowMs: NOW, upkeep: new Map([['decision-b', { reasons: ['duplicate'], twin: 'decision-a' }]]),
    })
    expect(edgesOf(g, 'twin')).toEqual([{ source: 'decision-b', target: 'decision-a' }])
    expect(memoryNodes(g).find(n => n.id === 'decision-b')?.upkeep).toBe(true)
    expect(memoryNodes(g).find(n => n.id === 'decision-a')?.upkeep).toBe(false)
  })

  test('from: a `session:` source names a session memory by its session id or by its memory id', () => {
    const sid = '0199a213-81c0-7800-8aa1-bbab2a035a53'
    const items = [
      item({ id: 'session-codex-035a53', kind: 'session', title: 'Session one', author: 'buracle', session: sid }),
      item({ id: 'session-codex-999999', kind: 'session', title: 'Session two', author: 'buracle', session: 'other-sid' }),
      item({ id: 'decision-distilled', title: 'Distilled', sources: [`session:${sid}`] }),
      item({ id: 'gotcha-by-id', kind: 'gotcha', title: 'By id', sources: ['session:session-codex-999999'] }),
      item({ id: 'gotcha-unknown', kind: 'gotcha', title: 'Unknown session', sources: ['session:nope'] }),
    ]
    const g = memGraph(items, { nowMs: NOW })
    expect(edgesOf(g, 'from')).toEqual([
      { source: 'decision-distilled', target: 'session-codex-035a53' },
      { source: 'gotcha-by-id', target: 'session-codex-999999' },
    ])
    expect(entityNodes(g)).toEqual([])
  })

  test('related: a `memory:` source names a live memory', () => {
    const g = memGraph([
      item({ id: 'procedure-learned', kind: 'procedure', title: 'Learned', sources: ['memory:gotcha-root', 'memory:gotcha-dead', 'memory:Not An Id'] }),
      item({ id: 'gotcha-root', kind: 'gotcha', title: 'Root' }),
      item({ id: 'gotcha-dead', kind: 'gotcha', title: 'Dead', status: 'deprecated' }),
    ], { nowMs: NOW })
    expect(edgesOf(g, 'related')).toEqual([{ source: 'procedure-learned', target: 'gotcha-root' }])
    expect(entityNodes(g)).toEqual([])
  })

  test('similar: claims at or above 0.5 similarity, weighted by it; generated kinds never', () => {
    const a = item({ id: 'decision-cache', title: 'Cache invalidation runs nightly' })
    const b = item({ id: 'decision-cache-sunday', title: 'Cache invalidation runs nightly on Sundays' })
    const c = item({ id: 'decision-other', title: 'Ports start at 41777' })
    const s1 = item({ id: 'session-codex-aaaaaa', kind: 'session', title: 'Session 2026-10-10 codex', author: 'buracle' })
    const s2 = item({ id: 'session-codex-bbbbbb', kind: 'session', title: 'Session 2026-10-10 codex', author: 'buracle' })
    const g = memGraph([a, b, c, s1, s2], { nowMs: NOW })
    const sim = g.edges.filter(e => e.kind === 'similar')
    expect(sim.map(e => [e.source, e.target])).toEqual([['decision-cache', 'decision-cache-sunday']])
    expect(sim[0]?.weight).toBe(Math.round(memSimilarity(a, b) * 1000) / 1000)
    expect(sim[0]?.weight).toBeGreaterThanOrEqual(0.5)
  })

  test('similar edges are not computed past 300 focus memories', () => {
    const items = Array.from({ length: 301 }, (_, n) => item({ id: `decision-same-${n}`, title: 'Exactly the same title' }))
    const g = memGraph(items, { nowMs: NOW, limits: { memories: 400, edges: 10 } })
    expect(g.edges).toEqual([])
    expect(g.truncated).toBe(false)
  })
})

describe('neighbors from other regions', () => {
  test('a live memory of another region with a direct edge to a focus memory comes in with focus: false', () => {
    const items = [
      item({ id: 'decision-a', title: 'A', body: 'see gotcha-mentioned' }),
      item({ id: 'decision-b', title: 'B', sources: ['memory:procedure-related'] }),
      item({ id: 'gotcha-mentioned', kind: 'gotcha', title: 'Broker gotcha' }),
      item({ id: 'procedure-related', kind: 'procedure', title: 'Related' }),
      item({ id: 'knowledge-mentions-a', kind: 'knowledge', title: 'Linker note', body: 'decision-a' }),
      item({ id: 'knowledge-twin', kind: 'knowledge', title: 'Twin' }),
      item({ id: 'knowledge-unlinked', kind: 'knowledge', title: 'Unlinked' }),
      item({ id: 'reference-x', kind: 'reference', title: 'X', body: 'reference-y gotcha-mentioned' }),
      item({ id: 'reference-y', kind: 'reference', title: 'Y' }),
    ]
    const g = memGraph(items, { nowMs: NOW, region: 'plans', upkeep: new Map([['knowledge-twin', { reasons: ['duplicate'], twin: 'decision-b' }]]) })
    const focus = memoryNodes(g).filter(n => n.focus).map(n => n.id)
    const neighbors = memoryNodes(g).filter(n => !n.focus).map(n => n.id)
    expect(focus).toEqual(['decision-a', 'decision-b'])
    expect(neighbors.sort()).toEqual(['gotcha-mentioned', 'knowledge-mentions-a', 'knowledge-twin', 'procedure-related'])
    expect(memIds(g)).not.toContain('knowledge-unlinked')
    expect(memIds(g)).not.toContain('reference-x')
    expect(memIds(g)).not.toContain('reference-y')
    assertConsistent(g)
  })

  test('neighbors never create hubs, but link to the hubs of focus memories; at most 60 come in', () => {
    const many = Array.from({ length: 65 }, (_, n) => item({ id: `gotcha-n${String(n).padStart(2, '0')}`, kind: 'gotcha', title: `Item${n}`, tags: ['shared', `own-${n}`] }))
    const hub = item({ id: 'decision-hub', title: 'Hub', tags: ['shared'], body: many.map(m => m.id).join(' ') })
    const g = memGraph([hub, ...many], { nowMs: NOW, region: 'plans' })
    expect(memoryNodes(g).filter(n => !n.focus).length).toBe(60)
    expect(g.truncated).toBe(true)
    expect(entityNodes(g).map(e => e.id)).toEqual(['tag:shared'])
    expect(entityNodes(g)[0]).toMatchObject({ type: 'tag', label: 'shared', weight: 61, degree: 61 })
    assertConsistent(g)
  })
})

describe('entity hubs', () => {
  test('tags, about entries and repository files become hubs; generated profile tags, URLs and commits do not', () => {
    const items = [
      item({ id: 'decision-a', title: 'A', tags: ['memory', 'rank-1', 'hypothesis', 'stated'], about: ['CortexDB ', 'bun'], sources: ['src/memory/store.ts:12-20', 'https://example.com/x', 'abc1234', '/abs/path.ts', 'session:x', 'memory:decision-b'] }),
      item({ id: 'decision-b', title: 'B', tags: ['memory'], about: ['cortexdb'], sources: ['./src/memory/store.ts'] }),
      item({ id: 'profile-x', kind: 'profile', layer: 'person', title: 'Wants the result first', author: 'buracle', tags: ['communication', 'stated', 'rank-1'] }),
    ]
    const g = memGraph(items, { nowMs: NOW })
    const ents = entityNodes(g)
    expect(ents.map(e => e.id)).toEqual(['concept:cortexdb', 'tag:memory', 'file:src/memory/store.ts', 'concept:bun', 'tag:communication'])
    expect(ents.find(e => e.id === 'concept:cortexdb')).toEqual({ id: 'concept:cortexdb', type: 'concept', label: 'CortexDB', weight: 2, degree: 2 })
    expect(ents.find(e => e.id === 'file:src/memory/store.ts')).toMatchObject({ type: 'file', label: 'src/memory/store.ts', weight: 2 })
    for (const hidden of ['tag:rank-1', 'tag:hypothesis', 'tag:stated']) expect(ents.map(e => e.id)).not.toContain(hidden)
    expect(edgesOf(g, 'tag')).toContainEqual({ source: 'decision-a', target: 'tag:memory' })
    expect(edgesOf(g, 'about')).toContainEqual({ source: 'decision-b', target: 'concept:cortexdb' })
    expect(edgesOf(g, 'cites')).toContainEqual({ source: 'decision-a', target: 'file:src/memory/store.ts' })
    assertConsistent(g)
  })

  test('the entity cap keeps the most linked hubs (label breaks ties)', () => {
    const items = [
      item({ id: 'decision-a', title: 'A', tags: ['zeta', 'beta', 'alpha'] }),
      item({ id: 'decision-b', title: 'B', tags: ['zeta'] }),
    ]
    const g = memGraph(items, { nowMs: NOW, limits: { entities: 2 } })
    expect(entityNodes(g).map(e => e.id)).toEqual(['tag:zeta', 'tag:alpha'])
    expect(g.truncated).toBe(true)
    assertConsistent(g)
  })
})

describe('caps and order', () => {
  test('the memory cap keeps the best and says so', () => {
    const items = Array.from({ length: 5 }, (_, n) => item({ id: `decision-${n}`, title: `Decision${n}`, importance: n + 1 }))
    const g = memGraph(items, { nowMs: NOW, limits: { memories: 3 } })
    expect(memIds(g)).toEqual(['decision-4', 'decision-3', 'decision-2'])
    expect(g.truncated).toBe(true)
  })

  test('the edge cap drops the weakest similar edges first, then the weakest others; a hub left without edges goes', () => {
    const items = [
      item({ id: 'decision-cache', title: 'Cache invalidation runs nightly', tags: ['ops'] }),
      item({ id: 'decision-cache-sunday', title: 'Cache invalidation runs nightly on Sundays', tags: ['ops'], body: 'decision-cache' }),
      item({ id: 'decision-solo', title: 'Ports start at 41777', tags: ['solo'] }),
    ]
    const full = memGraph(items, { nowMs: NOW })
    expect(full.edges.map(e => e.kind).sort()).toEqual(['mentions', 'similar', 'tag', 'tag', 'tag'])
    expect(full.truncated).toBe(false)

    const four = memGraph(items, { nowMs: NOW, limits: { edges: 4 } })
    expect(four.edges.map(e => e.kind).sort()).toEqual(['mentions', 'tag', 'tag', 'tag'])
    expect(four.truncated).toBe(true)
    assertConsistent(four)

    const three = memGraph(items, { nowMs: NOW, limits: { edges: 3 } })
    expect(three.edges.map(e => [e.kind, e.source, e.target])).toEqual([
      ['mentions', 'decision-cache-sunday', 'decision-cache'],
      ['tag', 'decision-cache', 'tag:ops'],
      ['tag', 'decision-cache-sunday', 'tag:ops'],
    ])
    expect(entityNodes(three).map(e => e.id)).toEqual(['tag:ops'])
    assertConsistent(three)

    const one = memGraph(items, { nowMs: NOW, limits: { edges: 1 } })
    expect(one.edges.map(e => e.kind)).toEqual(['mentions'])
    expect(entityNodes(one)).toEqual([])
    expect(memIds(one).length).toBe(3)
    assertConsistent(one)
  })

  test('the output does not depend on the order of the input', () => {
    const sid = 'sid-1'
    const items = [
      item({ id: 'decision-a', title: 'Cache invalidation runs nightly', tags: ['ops', 'cache'], about: ['Redis'], sources: ['src/a.ts', `session:${sid}`], body: 'gotcha-b decision-c' }),
      item({ id: 'decision-c', title: 'Cache invalidation runs nightly on Sundays', tags: ['cache'], body: 'decision-a' }),
      item({ id: 'gotcha-b', kind: 'gotcha', title: 'B', tags: ['ops'], sources: ['memory:decision-c'] }),
      item({ id: 'session-codex-sid1', kind: 'session', title: 'Session', author: 'buracle', session: sid }),
      item({ id: 'decision-d', title: 'D', importance: 3, updated: iso(NOW - DAY), tags: ['cache'] }),
      item({ id: 'decision-e', title: 'E', importance: 3, updated: iso(NOW - DAY), tags: ['ops'] }),
    ]
    const upkeep = new Map([['decision-d', { reasons: ['duplicate'], twin: 'decision-e' }]])
    const want = JSON.stringify(memGraph(items, { nowMs: NOW, region: 'plans', upkeep }))
    for (const order of [[5, 4, 3, 2, 1, 0], [2, 0, 5, 1, 3, 4], [3, 5, 1, 0, 4, 2]]) {
      const shuffled = order.map(n => items[n] as MemItem)
      expect(JSON.stringify(memGraph(shuffled, { nowMs: NOW, region: 'plans', upkeep }))).toBe(want)
    }
    const g = JSON.parse(want) as MemGraph
    assertConsistent(g)
    expect(memIds(g).slice(0, 4)).toEqual(['decision-a', 'decision-c', 'decision-d', 'decision-e'])
    expect(memoryNodes(g).filter(n => !n.focus).map(n => n.id).sort()).toEqual(['gotcha-b', 'session-codex-sid1'])
  })

  test('an empty brain is an empty graph', () => {
    expect(memGraph([], { nowMs: NOW, region: 'self' })).toEqual({ region: 'self', nodes: [], edges: [], truncated: false, stats: { memories: 0, entities: 0, edges: 0 } })
  })
})
