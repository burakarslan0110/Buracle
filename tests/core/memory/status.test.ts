import { describe, expect, test } from 'bun:test'
import { memAge, memEmptyStatus, memHealth, memMcpHealth, memSegment, memSegmentWith, type MemHealthInput, type MemoryStatus } from '../../../src/core/memory/status'

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0)
const base = (over: Partial<MemHealthInput> = {}): MemHealthInput => ({ storeOk: true, readable: true, upkeep: 0, captures: 0, distillPending: 0, ...over })

describe('memHealth', () => {
  test('ok when nothing applies', () => {
    expect(memHealth(base())).toEqual({ health: 'ok', reasons: [] })
  })

  test('error reasons come first and win', () => {
    const h = memHealth(base({ storeOk: false, mcpDown: true, upkeep: 20 }))
    expect(h.health).toBe('error')
    expect(h.reasons).toEqual(['cortexdb_missing', 'mcp_down', 'upkeep_high'])
    expect(memHealth(base({ readable: false })).reasons).toEqual(['brain_unreadable'])
  })

  test('warnings', () => {
    expect(memHealth(base({ upkeep: 15 })).reasons).toEqual(['upkeep_high'])
    expect(memHealth(base({ upkeep: 14 })).reasons).toEqual([])
    expect(memHealth(base({ captures: 10 })).reasons).toEqual(['captures_high'])
    expect(memHealth(base({ coreMissing: 1 })).reasons).toEqual(['core_missing'])
    expect(memHealth(base({ coreMissing: 0 })).reasons).toEqual([])
    expect(memHealth(base({ distillPending: 5 }))).toEqual({ health: 'warn', reasons: ['distill_backlog'] })
  })
})

describe('memAge', () => {
  test('compact English units', () => {
    expect(memAge(10_000)).toBe('<1m')
    expect(memAge(12 * 60_000)).toBe('12m')
    expect(memAge(5 * 3600_000)).toBe('5h')
    expect(memAge(47 * 3600_000)).toBe('47h')
    expect(memAge(3 * 24 * 3600_000)).toBe('3d')
    expect(memAge(-5000)).toBe('<1m')
    expect(memAge(Number.NaN)).toBe('?')
  })
})

describe('memSegment', () => {
  const status = (over: Partial<MemoryStatus> = {}): MemoryStatus => ({
    ...memEmptyStatus('2026-10-08T15:00:00+03:00', 'buracle'),
    counts: { project: 142, person: 37 },
    upkeep: 3,
    captures: 1,
    last_write: { at: '2026-10-08T14:48:00+03:00', by: 'codex', type: 'decision' },
    ...over,
  })

  test('compact: count · upkeep · age · health', () => {
    expect(memSegment(status(), NOW, 'compact')).toEqual({ id: 'mem', text: 'brain 142·u3·12m ✓', color: 'green' })
  })

  test('wide', () => {
    expect(memSegment(status(), NOW, 'wide').text).toBe('🧠 buracle 142+37p · upkeep 3 · inbox 1 · last 12m (codex)')
    expect(memSegmentWith(status(), NOW, 'wide', { emoji: false }).text.startsWith('buracle 142+37p')).toBe(true)
  })

  test('warnings and errors append the first reason and change the color', () => {
    const warn = memSegment(status({ health: 'warn', reasons: ['upkeep_high'], upkeep: 16 }), NOW + 3 * 3600_000, 'compact')
    expect(warn).toEqual({ id: 'mem', text: 'brain 142·u16·3h ⚠ upkeep 16', color: 'yellow' })
    const err = memSegment(status({ health: 'error', reasons: ['cortexdb_missing'] }), NOW, 'wide')
    expect(err.color).toBe('red')
    expect(err.text.endsWith('✗ cortexdb missing')).toBe(true)
    const queue = memSegment(status({ health: 'warn', reasons: ['distill_backlog'], distill: { pending: 9, held: 2 } }), NOW, 'compact')
    expect(queue.text.endsWith('⚠ queue 7')).toBe(true)
    expect(memSegment(status({ health: 'warn', reasons: ['captures_high'], captures: 12 }), NOW, 'compact').text.endsWith('⚠ inbox 12')).toBe(true)
  })

  test('ages are computed at render time', () => {
    const s = status()
    expect(memSegment(s, NOW, 'compact').text).not.toBe(memSegment(s, NOW + 2 * 3600_000, 'compact').text)
  })

  test('no status yet, or a status of the old vault format', () => {
    expect(memSegment(undefined, NOW, 'compact')).toEqual({ id: 'mem', text: 'brain –', color: 'gray', dim: true })
    expect(memSegment({ v: 1 } as unknown as MemoryStatus, NOW, 'compact').text).toBe('brain –')
  })

  test('outside a project the person count shows', () => {
    const g = { ...memEmptyStatus('x'), counts: { project: 0, person: 9 } }
    expect(memSegment(g, NOW, 'compact').text).toBe('brain 9 ✓')
    expect(memSegment(g, NOW, 'wide').text).toBe('🧠 person 9p')
  })
})

describe('memMcpHealth (state/health.json, CONTRACTS §3)', () => {
  test('the documented shape: { v, checked_at, mcp: { id: { status, … } }, tools }', () => {
    const health = {
      v: 1, checked_at: '2026-10-08T09:00:00Z',
      mcp: {
        'buracle-memory': { status: 'down', transport: 'stdio', error: 'exit 1', ms: 120, checked_at: '2026-10-08T09:00:00Z' },
        context7: { status: 'ok', transport: 'stdio', tools: 2, toolNames: ['resolve-library-id', 'query-docs'], version: '4.2.0' },
        grep: { status: 'unknown', transport: 'http' },
      },
      tools: { rg: { status: 'ok', version: '15.1.0', checked_at: '2026-10-08T09:00:00Z' } },
    }
    expect(memMcpHealth(health, 'buracle-memory')).toBe('down')
    expect(memMcpHealth(health, 'context7')).toBe('ok')
    expect(memMcpHealth(health, 'grep')).toBe('unknown')
    expect(memMcpHealth(health, 'semble')).toBe('unknown')
    expect(memMcpHealth(health, 'tools')).toBe('unknown')
  })

  test('older and looser shapes are still read', () => {
    expect(memMcpHealth({ mcp: { 'buracle-memory': 'down' } }, 'buracle-memory')).toBe('down')
    expect(memMcpHealth({ servers: { 'buracle-memory': { status: 'down' } } }, 'buracle-memory')).toBe('down')
    expect(memMcpHealth({ 'buracle-memory': 'down' }, 'buracle-memory')).toBe('down')
    expect(memMcpHealth({ 'buracle-memory': false }, 'buracle-memory')).toBe('down')
    expect(memMcpHealth({ mcp: { 'buracle-memory': true } }, 'buracle-memory')).toBe('ok')
    expect(memMcpHealth({ mcp: { 'buracle-memory': { ok: false } } }, 'buracle-memory')).toBe('down')
    expect(memMcpHealth({ mcp: { 'buracle-memory': { ok: true } } }, 'buracle-memory')).toBe('ok')
  })

  test('a failed start recorded with `until` is down only until then when the time is given (core mcpHealthOf)', () => {
    const now = Date.UTC(2026, 9, 10, 12, 0, 0)
    const until = new Date(now + 60_000).toISOString()
    const health = { v: 1, mcp: { 'buracle-memory': { status: 'down', source: 'launch', error: 'exited with code 1', until }, context7: { status: 'down' } } }
    expect(memMcpHealth(health, 'buracle-memory', now)).toBe('down')
    expect(memMcpHealth(health, 'buracle-memory', now + 60_000)).toBe('unknown')
    expect(memMcpHealth(health, 'context7', now + 60_000)).toBe('down')
    expect(memMcpHealth(health, 'buracle-memory')).toBe('down')
  })

  test('anything unreadable is unknown', () => {
    for (const h of [undefined, null, 'down', [], 42, { mcp: { 'buracle-memory': 'broken' } }, { mcp: { 'buracle-memory': { status: { status: 'down' } } } }, { mcp: { 'buracle-memory': null } }]) {
      expect(memMcpHealth(h, 'buracle-memory')).toBe('unknown')
    }
  })
})
