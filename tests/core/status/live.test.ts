import { describe, expect, test } from 'bun:test'
import type { BandView } from '../../../src/core/flow/band'
import { bandView } from '../../../src/core/flow/band'
import { flowEnd, flowPhase, flowStart } from '../../../src/core/flow/record'
import { textWidth } from '../../../src/core/status/format'
import { FLOW_ROW_MIN_COLUMNS, INDEX_STATUS_TEXT, flowElapsed, flowRow, flowRowColor, flowRowText, indexStatusOf, isIndexStatus, worstIndexStatus } from '../../../src/core/status/live'
import type { IndexStatus } from '../../../src/core/status/model'
import type { IndexState, ProjectIndex } from '../../../src/core/workspace'

const T = Date.UTC(2026, 9, 9, 10, 0, 0)

function run(workflow: string, phase?: string, now = T + 5 * 60_000): BandView {
  let r = flowStart(undefined, { workflow, source: 'command' }, T).record
  if (phase !== undefined) r = flowPhase(r, { phase }, T + 1).record
  return bandView({ nowMs: now, foldAfterSec: 8, flow: r })
}

describe('flowRow', () => {
  test('nothing to show: no view, or a view that is not visible', () => {
    expect(flowRow(undefined)).toEqual([])
    expect(flowRow(bandView({ nowMs: T, foldAfterSec: 8 }))).toEqual([])
  })

  test('the band\'s one-row layout: workflow, current phase, status words unless it runs', () => {
    const fix = flowRow(run('bugfix', 'red'))
    expect(flowRowText(fix)).toBe('bugfix ● RED')
    expect(fix.map(s => s.id)).toEqual(['band-crumb', 'band-phase-red'])
    expect(flowRowColor(fix)).toBe('magenta')
    const started = flowRow(run('research'))
    expect(started).toEqual([{ id: 'band-crumb', text: 'research', bold: true }])
  })

  test('compact: the innermost workflow, the short phase label, no status words', () => {
    let r = flowStart(undefined, { workflow: 'requirements', source: 'command' }, T).record
    r = flowPhase(r, { phase: 'research' }, T + 1).record
    r = flowStart(r, { workflow: 'research', source: 'skill' }, T + 2).record
    r = flowPhase(r, { phase: 'gather' }, T + 3).record
    r = flowEnd(r, 'failed', T + 4).record
    const v = bandView({ nowMs: T + 5, foldAfterSec: 8, flow: r })
    expect(flowRowText(flowRow(v))).toBe('requirements › research ✗ Gather · failed')
    const compact = flowRow(v, { compact: true })
    expect(flowRowText(compact)).toBe('research ✗ Gather')
    expect(flowRowColor(compact)).toBe('red')
    expect(flowRowText(flowRow(run('bugfix', 'investigate'), { compact: true }))).toBe('bugfix ● Inv')
  })

  test('the row fits the columns it is given, never fewer than the band\'s narrowest', () => {
    const v = run('project-rules', 'validate')
    for (const columns of [24, 30, 80, 10, Number.NaN]) {
      const w = textWidth(flowRowText(flowRow(v, { columns })))
      expect(w).toBeLessThanOrEqual(Number.isFinite(columns) ? Math.max(columns, FLOW_ROW_MIN_COLUMNS) : 160)
      expect(w).toBeGreaterThan(0)
    }
  })
})

describe('flowElapsed', () => {
  test('minutes in the band\'s units', () => {
    expect([flowElapsed(0), flowElapsed(0.5), flowElapsed(12), flowElapsed(119), flowElapsed(120), flowElapsed(125), flowElapsed(Number.NaN)]).toEqual(['<1m', '<1m', '12m', '119m', '2h', '2h5m', '<1m'])
  })
})

describe('index states', () => {
  test('every state has a long and a short text', () => {
    const states: IndexStatus[] = ['ready', 'building', 'none', 'failed', 'off']
    expect(Object.keys(INDEX_STATUS_TEXT).sort()).toEqual([...states].sort())
    for (const s of states) {
      expect(INDEX_STATUS_TEXT[s].long).toBe(`idx ${s}`)
      expect(INDEX_STATUS_TEXT[s].short.startsWith('idx ')).toBe(true)
      expect(isIndexStatus(s)).toBe(true)
    }
    expect([isIndexStatus('stale'), isIndexStatus(undefined), isIndexStatus('toString')]).toEqual([false, false, false])
  })

  test('indexStatusOf: a project shows its own indexes (the worse of the two), a folder of projects its worst child, anything else nothing', () => {
    const idx = (codegraph: IndexState, semble: IndexState): ProjectIndex => ({ codegraph, semble })
    const ready: IndexState = { state: 'ready' }
    const building: IndexState = { state: 'building' }
    const none: IndexState = { state: 'none' }
    const off: IndexState = { state: 'off' }
    expect(indexStatusOf({ cwd: '/w', root: '/w', children: [], index: idx(ready, building) })).toBe('building')
    expect(indexStatusOf({ cwd: '/w/src', root: '/w', children: [], index: idx(off, off) })).toBe('off')
    expect(indexStatusOf({ cwd: '/p', children: ['/p/a', '/p/b'], index: idx(none, none), childIndex: { '/p/a': idx(ready, ready), '/p/b': idx(ready, none) } })).toBe('none')
    expect(indexStatusOf({ cwd: '/p', children: ['/p/a'], index: idx(none, none), childIndex: { '/p/a': idx(off, off) } })).toBe('off')
    expect(indexStatusOf({ cwd: '/h', children: [], index: idx(none, none) })).toBeUndefined()
  })

  test('a folder of projects shows its worst child; off only when every child is off', () => {
    expect(worstIndexStatus([])).toBeUndefined()
    expect(worstIndexStatus(['ready', 'ready'])).toBe('ready')
    expect(worstIndexStatus(['ready', 'building'])).toBe('building')
    expect(worstIndexStatus(['building', 'none', 'ready'])).toBe('none')
    expect(worstIndexStatus(['none', 'failed', 'off'])).toBe('failed')
    expect(worstIndexStatus(['off', 'ready'])).toBe('ready')
    expect(worstIndexStatus(['off', 'off'])).toBe('off')
  })
})
