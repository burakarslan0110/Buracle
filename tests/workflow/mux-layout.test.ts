import { describe, expect, test } from 'bun:test'
import { planLayout, WORKERS_PER_ROW, type Anchor, type Layout } from '../../src/workflow/mux-layout'

interface Rect { x: number, y: number, w: number, h: number }
const area = (r: Rect): number => r.w * r.h

/**
 * Carries a plan out on a sheet of paper: the area the first split cuts is the unit square, and every step cuts the
 * rectangle of the pane it splits in two (the pane keeps `keep` of the width or the height, the new pane takes the rest).
 * The expected sizes come from this arithmetic, not from the planner.
 */
function carryOut(layout: Layout, o: { live?: number }): { lead: Rect | undefined, workers: Rect[] } {
  const rects = new Map<string, Rect>()
  const key = (a: Anchor): string => (a.kind === 'new' ? `n${a.rank}` : a.kind)
  const unit: Rect = { x: 0, y: 0, w: 1, h: 1 }
  if ((o.live ?? 0) > 0) rects.set('live', unit)
  else rects.set('lead', unit)
  const seen = new Set<number>()
  for (const step of layout.panes) {
    if (step.anchor.kind === 'none') { rects.set(`n${step.rank}`, unit); seen.add(step.rank); continue }
    const a = rects.get(key(step.anchor))
    if (a === undefined) throw new Error(`rank ${step.rank} splits ${key(step.anchor)}, which is not open yet`)
    if (step.anchor.kind === 'new' && !seen.has(step.anchor.rank)) throw new Error(`rank ${step.rank} splits rank ${step.anchor.rank} before it opened`)
    const kept: Rect = step.direction === 'right' ? { ...a, w: a.w * step.keep } : { ...a, h: a.h * step.keep }
    const added: Rect = step.direction === 'right' ? { x: a.x + kept.w, y: a.y, w: a.w - kept.w, h: a.h } : { x: a.x, y: a.y + kept.h, w: a.w, h: a.h - kept.h }
    rects.set(key(step.anchor), kept)
    rects.set(`n${step.rank}`, added)
    seen.add(step.rank)
  }
  const ranks = layout.panes.map(p => p.rank).sort((a, b) => a - b)
  return { lead: rects.get('lead'), workers: ranks.map(r => rects.get(`n${r}`) as Rect) }
}

describe('planLayout: the lead on top, the workers in boxes of the same size below', () => {
  test('one row up to four workers, then rows of up to ceil(n / rows): the grid fills the area below the lead without a gap or an overlap', () => {
    for (let n = 1; n <= 8; n++) {
      const layout = planLayout({ count: n, live: 0, lead: true, exact: true })
      expect(layout.panes.map(p => p.rank).sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i))
      expect(layout.rows).toBe(Math.ceil(n / WORKERS_PER_ROW))
      expect(layout.cols).toBe(Math.ceil(n / layout.rows))
      const { lead, workers } = carryOut(layout, {})
      // The lead keeps the top; the workers share what is left, all of it.
      expect(lead).toBeDefined()
      const below = 1 - (lead as Rect).h
      expect((lead as Rect).y).toBe(0)
      expect((lead as Rect).w).toBe(1)
      // The workers get at least the half of the area that the lead leaves free.
      expect(below).toBeGreaterThanOrEqual(0.5 - 1e-9)
      expect(workers.reduce((sum, r) => sum + area(r), 0)).toBeCloseTo(below, 9)
      for (const r of workers) expect(r.y).toBeGreaterThanOrEqual((lead as Rect).h - 1e-9)
      // A full grid has boxes of one size; a last row that is not full leaves some boxes taller, never more than twice as big.
      const areas = workers.map(area)
      if (n % layout.cols === 0) for (const a of areas) expect(a).toBeCloseTo(below / n, 9)
      else expect(Math.max(...areas) / Math.min(...areas)).toBeLessThanOrEqual(2 + 1e-9)
    }
  })

  test('the ranks read left to right and top to bottom, so Worker k sits where its number says, with or without sizes', () => {
    for (const exact of [true, false]) {
      for (let n = 1; n <= 9; n++) {
        const { workers } = carryOut(planLayout({ count: n, live: 0, lead: true, exact }), {})
        const byPosition = workers.map((r, rank) => ({ rank, row: Math.round(r.y * 1000), col: Math.round(r.x * 1000) }))
          .sort((a, b) => a.row - b.row || a.col - b.col).map(p => p.rank)
        expect(byPosition).toEqual(Array.from({ length: n }, (_, i) => i))
      }
    }
  })

  test('without sizes the panes are not opened in rank order (three workers: 1, 3, 2), and every pane still opens after the pane it splits', () => {
    const order = planLayout({ count: 3, live: 0, lead: true, exact: false }).panes.map(p => p.rank)
    expect(order).toEqual([0, 2, 1])
  })

  test('the shape it reports is the shape it builds: a row of new panes, or a column of them once four are open', () => {
    expect(planLayout({ count: 3, live: 1, lead: true, exact: true })).toMatchObject({ rows: 1, cols: 3 })
    expect(planLayout({ count: 2, live: WORKERS_PER_ROW, lead: true, exact: true })).toMatchObject({ rows: 2, cols: 1 })
    expect(planLayout({ count: 6, live: 0, lead: true, exact: true })).toMatchObject({ rows: 2, cols: 3 })
  })

  test('four workers are one row of four columns; five to eight are two rows; the lead keeps half of its area for one row and less for two', () => {
    const four = planLayout({ count: 4, live: 0, lead: true, exact: true })
    expect(four.panes[0]).toEqual({ rank: 0, anchor: { kind: 'lead' }, direction: 'down', keep: 0.5 })
    expect(four.panes.slice(1).map(p => [p.direction, p.keep])).toEqual([['right', 0.25], ['right', 1 / 3], ['right', 0.5]])
    expect([planLayout({ count: 5, live: 0, lead: true, exact: true }).rows, planLayout({ count: 8, live: 0, lead: true, exact: true }).rows]).toEqual([2, 2])
    expect(planLayout({ count: 6, live: 0, lead: true, exact: true }).panes[0]?.keep).toBe(0.4)
    expect(planLayout({ count: 9, live: 0, lead: true, exact: true }).panes[0]?.keep).toBe(0.3)
  })

  test('without a lead pane to split (a detached tmux session) the first pane starts the area and the rest cut it into the same grid', () => {
    const layout = planLayout({ count: 3, live: 0, lead: false, exact: true })
    expect(layout.panes[0]?.anchor).toEqual({ kind: 'none' })
    const { workers } = carryOut(layout, {})
    for (const r of workers) expect(area(r)).toBeCloseTo(1 / 3, 9)
  })

  test('panes of an earlier spawn stay as they are: the new panes share the area of the last one, to its right, or below it once a row of four is full', () => {
    const layout = planLayout({ count: 2, live: 1, lead: true, exact: true })
    expect(layout.panes[0]?.anchor).toEqual({ kind: 'live' })
    const { workers } = carryOut(layout, { live: 1 })
    for (const r of workers) expect(area(r)).toBeCloseTo(1 / 3, 9)
    expect(planLayout({ count: 1, live: 2, lead: true, exact: true }).panes[0]).toEqual({ rank: 0, anchor: { kind: 'live' }, direction: 'right', keep: 0.5 })
    expect(planLayout({ count: 1, live: WORKERS_PER_ROW, lead: true, exact: true }).panes[0]?.direction).toBe('down')
  })

  test('a multiplexer that only halves (cmux) gets halving splits that come out equal for 1, 2, 4 and 8 workers and never worse than 4 to 1', () => {
    for (let n = 1; n <= 8; n++) {
      const layout = planLayout({ count: n, live: 0, lead: true, exact: false })
      for (const p of layout.panes.slice(1)) expect(p.keep).toBe(0.5)
      const { workers } = carryOut(layout, {})
      const areas = workers.map(area)
      if ([1, 2, 4, 8].includes(n)) for (const a of areas) expect(a).toBeCloseTo(areas[0] as number, 9)
      expect(Math.max(...areas) / Math.min(...areas)).toBeLessThanOrEqual(4 + 1e-9)
    }
  })

  test('nothing to open plans nothing', () => {
    expect(planLayout({ count: 0, live: 0, lead: true, exact: true })).toEqual({ panes: [], rows: 0, cols: 0 })
  })
})
