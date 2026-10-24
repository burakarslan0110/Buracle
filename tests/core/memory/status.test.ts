import { describe, expect, test } from 'bun:test'
import { memAge, memEmptyStatus, memHealth, memHealthLine, memMcpHealth, memReasonAdvice, memSegment, memSegmentWith, type MemHealthInput, type MemoryStatus } from '../../../src/core/memory/status'

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0)
const base = (over: Partial<MemHealthInput> = {}): MemHealthInput => ({ storeOk: true, readable: true, captures: 0, ...over })

describe('memHealth', () => {
  test('ok when nothing applies', () => {
    expect(memHealth(base())).toEqual({ health: 'ok', reasons: [] })
  })

  test('error reasons come first and win over warnings', () => {
    const h = memHealth(base({ storeOk: false, mcpDown: true, captures: 20 }))
    expect(h.health).toBe('error')
    expect(h.reasons).toEqual(['cortexdb_missing', 'mcp_down', 'captures_high'])
    expect(memHealth(base({ readable: false })).reasons).toEqual(['brain_unreadable'])
  })

  test('an unreadable brain is not reported on top of a missing store', () => {
    expect(memHealth(base({ storeOk: false, readable: false })).reasons).toEqual(['cortexdb_missing'])
  })

  test('only a full inbox warns', () => {
    expect(memHealth(base({ captures: 10 }))).toEqual({ health: 'warn', reasons: ['captures_high'] })
    expect(memHealth(base({ captures: 9 }))).toEqual({ health: 'ok', reasons: [] })
    expect(memHealth(base({ mcpDown: true })).health).toBe('error')
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
    captures: 1,
    last_write: { at: '2026-10-08T14:48:00+03:00', by: 'codex', type: 'decision' },
    ...over,
  })

  test('compact: count · age · health', () => {
    expect(memSegment(status(), NOW, 'compact')).toEqual({ id: 'mem', text: 'brain 142·12m ✓', color: 'green' })
  })

  test('wide', () => {
    expect(memSegment(status(), NOW, 'wide').text).toBe('🧠 buracle 142+37p · inbox 1 · last 12m (codex)')
    expect(memSegmentWith(status(), NOW, 'wide', { emoji: false }).text.startsWith('buracle 142+37p')).toBe(true)
  })

  test('wide shows when the last capture saved something', () => {
    const s = status({ last_capture: { at: '2026-10-08T14:55:00+03:00', by: 'claude', saved: 2 } })
    expect(memSegment(s, NOW, 'wide').text).toBe('🧠 buracle 142+37p · inbox 1 · last 12m (codex) · captured 5m')
    expect(memSegment(s, NOW, 'compact').text).toBe('brain 142·12m ✓')
    expect(memSegment(status({ last_capture: { at: 'not a date', by: 'claude', saved: 0 } }), NOW, 'wide').text).not.toContain('captured')
  })

  test('warnings and errors append the first reason and change the color', () => {
    const warn = memSegment(status({ health: 'warn', reasons: ['captures_high'], captures: 12 }), NOW + 3 * 3600_000, 'compact')
    expect(warn).toEqual({ id: 'mem', text: 'brain 142·3h ⚠ inbox 12', color: 'yellow' })
    const err = memSegment(status({ health: 'error', reasons: ['cortexdb_missing'] }), NOW, 'wide')
    expect(err.color).toBe('red')
    expect(err.text.endsWith('✗ cortexdb missing')).toBe(true)
    expect(memSegment(status({ health: 'error', reasons: ['mcp_down'] }), NOW, 'compact').text.endsWith('✗ mcp down')).toBe(true)
  })

  test('ages are computed at render time', () => {
    const s = status()
    expect(memSegment(s, NOW, 'compact').text).not.toBe(memSegment(s, NOW + 2 * 3600_000, 'compact').text)
  })

  test('no status yet, or a status of an older format', () => {
    expect(memSegment(undefined, NOW, 'compact')).toEqual({ id: 'mem', text: 'brain –', color: 'gray', dim: true })
    expect(memSegment({ v: 1 } as unknown as MemoryStatus, NOW, 'compact').text).toBe('brain –')
    expect(memSegment({ ...status(), v: 2 } as unknown as MemoryStatus, NOW, 'compact').text).toBe('brain –')
  })

  test('outside a project the person count shows', () => {
    const g = { ...memEmptyStatus('x'), counts: { project: 0, person: 9 } }
    expect(memSegment(g, NOW, 'compact').text).toBe('brain 9 ✓')
    expect(memSegment(g, NOW, 'wide').text).toBe('🧠 person 9p')
  })
})

describe('health text', () => {
  test('memHealthLine names the reasons and stays silent while the memory is healthy', () => {
    expect(memHealthLine(undefined)).toBeUndefined()
    expect(memHealthLine({ health: 'ok', reasons: [], captures: 0 })).toBeUndefined()
    expect(memHealthLine({ health: 'warn', reasons: ['captures_high'], captures: 12 })).toBe('Memory health: warn (inbox 12). `buracle mem doctor` names what is wrong.')
    expect(memHealthLine({ health: 'error', reasons: ['cortexdb_missing', 'mcp_down'], captures: 0 })).toContain('(cortexdb missing, mcp down)')
  })

  test('every reason memHealth can give has advice with a fix, and an unknown reason is passed through', () => {
    for (const reason of memHealth(base({ storeOk: false, mcpDown: true, captures: 20 })).reasons.concat('brain_unreadable')) {
      const advice = memReasonAdvice(reason, { captures: 20 })
      expect(advice.detail.length).toBeGreaterThan(10)
      expect(advice.fix?.length ?? 0).toBeGreaterThan(0)
    }
    expect(memReasonAdvice('captures_high', { captures: 20 }).detail).toContain('20')
    expect(memReasonAdvice('something_new', { captures: 0 })).toEqual({ detail: 'something_new' })
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
