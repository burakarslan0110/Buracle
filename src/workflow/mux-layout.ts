// Where the worker panes of a task board go. The lead keeps the top of its area and the workers share the rest as a grid
// of boxes of the same size, ordered left to right and top to bottom. This module only plans: every step names the pane
// it splits, the direction and the share that pane keeps; the multiplexer adapters in src/workflow/mux.ts carry it out.
// Pure: no IO, no environment.

/** Workers in one row before the grid gets a second row (a harness's terminal UI is hard to read in less than about 60 columns). */
export const WORKERS_PER_ROW = 4

/** The share of its pane the lead keeps, by the number of worker rows below it. */
const LEAD_KEEP: readonly number[] = [0.5, 0.4, 0.3]

export type SplitDirection = 'right' | 'down'

/**
 * The pane a step splits. `lead`: the lead's own pane. `live`: the last pane of an earlier spawn. `new`: a pane of this
 * plan, by rank. `none`: nothing to split (the pane starts a fresh area, as the first pane of a detached tmux session does).
 */
export type Anchor = { kind: 'none' } | { kind: 'lead' } | { kind: 'live' } | { kind: 'new'; rank: number }

/** One pane to open. `keep` is the share of the split pane's area that pane keeps; the new pane takes the rest. */
export interface PanePlan { rank: number; anchor: Anchor; direction: SplitDirection; keep: number }

export interface LayoutInput {
  /** How many panes to open. */
  count: number
  /** How many worker panes of an earlier spawn are still open: the new ones go next to the last of them. */
  live: number
  /** Whether the lead's own pane can be split (it runs inside the multiplexer). */
  lead: boolean
  /** Whether a split takes a size. Without it (cmux) every split halves, so the plan halves too. */
  exact: boolean
}

export interface Layout {
  /** In the order the panes must be opened: a pane is always opened after the pane it splits. */
  panes: PanePlan[]
  rows: number
  cols: number
}

interface LineStep { cell: number; anchorCell: number; keep: number }

/**
 * `m` cells in a line whose first cell exists already: the splits that make them equal (a chain, each split keeps
 * 1/(cells left)), or, without sizes, halving splits arranged so that powers of two come out equal.
 */
function lineSteps(m: number, exact: boolean): LineStep[] {
  const out: LineStep[] = []
  if (exact) {
    for (let j = 1; j < m; j++) out.push({ cell: j, anchorCell: j - 1, keep: 1 / (m - j + 1) })
    return out
  }
  const halve = (lo: number, hi: number): void => {
    const size = hi - lo
    if (size <= 1) return
    const mid = lo + Math.ceil(size / 2)
    out.push({ cell: mid, anchorCell: lo, keep: 0.5 })
    halve(lo, mid)
    halve(mid, hi)
  }
  halve(0, m)
  return out
}

export function planLayout(o: LayoutInput): Layout {
  if (o.count <= 0) return { panes: [], rows: 0, cols: 0 }

  if (o.live > 0) {
    // Panes are open already: leave them as they are and share the area of the last one with the new panes.
    const direction: SplitDirection = o.live >= WORKERS_PER_ROW ? 'down' : 'right'
    const panes = lineSteps(o.count + 1, o.exact).map((s): PanePlan => ({
      rank: s.cell - 1,
      anchor: s.anchorCell === 0 ? { kind: 'live' } : { kind: 'new', rank: s.anchorCell - 1 },
      direction,
      keep: s.keep,
    }))
    return direction === 'right' ? { panes, rows: 1, cols: o.count } : { panes, rows: o.count, cols: 1 }
  }

  const rows = Math.ceil(o.count / WORKERS_PER_ROW)
  const cols = Math.ceil(o.count / rows)
  const leadKeep = LEAD_KEEP[Math.min(rows, LEAD_KEEP.length) - 1] ?? 0.3
  const panes: PanePlan[] = [o.lead
    ? { rank: 0, anchor: { kind: 'lead' }, direction: 'down', keep: leadKeep }
    : { rank: 0, anchor: { kind: 'none' }, direction: 'down', keep: 1 }]
  // The first row is cut into columns that run the whole height of the worker area.
  for (const s of lineSteps(Math.min(cols, o.count), o.exact)) {
    panes.push({ rank: s.cell, anchor: { kind: 'new', rank: s.anchorCell }, direction: 'right', keep: s.keep })
  }
  // Then every column is cut into its rows.
  for (let c = 0; c < cols; c++) {
    const cells = Math.ceil((o.count - c) / cols)
    for (const s of lineSteps(cells, o.exact)) {
      panes.push({ rank: s.cell * cols + c, anchor: { kind: 'new', rank: s.anchorCell * cols + c }, direction: 'down', keep: s.keep })
    }
  }
  return { panes, rows, cols }
}
