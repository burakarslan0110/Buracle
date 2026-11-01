import { describe, expect, test } from 'bun:test'
import type { BandInput, BandView } from '../../../src/core/flow/band'
import { bandView } from '../../../src/core/flow/band'
import type { FlowRecord } from '../../../src/core/flow/record'
import { flowEnd, flowPhase, flowStart, flowStep } from '../../../src/core/flow/record'
import { formatResetIn, textWidth } from '../../../src/core/status/format'
import type { BarModel, IndexStatus, Segment, StatusLayout } from '../../../src/core/status/model'
import { SEGMENT_SEPARATOR, renderAnsi, renderPlain, renderTmux, rows } from '../../../src/core/status/render'
import type { MemoryStatus } from '../../../src/core/memory/status'
import { memSegment, memSegmentWith } from '../../../src/core/memory/status'

const NOW = Date.parse('2026-10-08T09:00:00.000Z')
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()

const LAYOUT: StatusLayout = {
  rows: [['model', 'ctx', '5h', '7d', 'month', 'cost'], ['git', 'dir', 'mem', 'plan', 'upd']],
  compact: [['model', 'ctx', '5h', '7d', 'month', 'git', 'mem', 'plan']],
  thresholds: { ctxWarn: 75, ctxCrit: 90 },
  emoji: true,
}

const MEM: MemoryStatus = {
  v: 3, computed_at: '2026-10-08T08:50:00.000Z', project: 'buracle', health: 'ok', reasons: [],
  counts: { project: 128, person: 37 }, regions: { plans: 20, knowledge: 60 }, captures: 2,
  last_write: { at: '2026-10-08T08:56:00.000Z', by: 'codex', type: 'decision' },
  store: { engine: 'cortexdb', version: '2.124.0', ok: true }, redactions_24h: 0,
}

function bar(over: Partial<BarModel> = {}): BarModel {
  return {
    harness: 'claude',
    model: 'Opus 5.5',
    effort: 'max',
    ctx: { pct: 37, tokens: 370_000, window: 1_000_000 },
    windows: [
      { label: '5h', pct: 42, windowMinutes: 300, resetsAt: at(80) },
      { label: '7d', pct: 18, windowMinutes: 10080, resetsAt: at(3 * 1440) },
    ],
    month: { tokens: 1_200_000_000, usd: 212.4, estimate: true },
    git: { branch: 'main', ahead: 2, behind: 0, staged: 0, unstaged: 3, untracked: 1, stash: 0, conflicts: 0, worktree: 'auth-fix' },
    mem: MEM,
    plan: { title: 'auth-fix', phase: 'implement', done: 3, total: 6 },
    updates: 2,
    ...over,
  }
}

const texts = (r: Segment[][]) => r.map(row => row.map(s => s.text))
const ids = (r: Segment[][]) => r.map(row => row.map(s => s.id))

describe('rows: full layout', () => {
  test('the DESIGN §6.3 bar at a wide terminal', () => {
    const r = rows(bar(), LAYOUT, 200, NOW)
    const sevenDay = formatResetIn(NOW + 3 * 1440 * 60_000, NOW)
    expect(texts(r)).toEqual([
      ['Opus 5.5 · max', 'ctx ▓▓░░░░ 37% (370k/1M)', '5h 42% ⇣ ↺1h20m', `7d 18% ⇣ ↺${sevenDay}`, 'mo ≈$212 · 1.2B tok'],
      ['⎇ main ↑2 ✚3 …1 [wt:auth-fix]', memSegment(MEM, NOW, 'wide').text, 'plan auth-fix [implement] 3/6', '⬆2'],
    ])
    expect(r[0]?.map(s => s.color)).toEqual(['cyan', 'green', 'green', 'green', undefined])
    expect(r[1]?.map(s => s.color)).toEqual(['yellow', memSegment(MEM, NOW, 'wide').color, 'blue', 'magenta'])
  })

  test('absent data produces no segment and empty rows are dropped', () => {
    const r = rows({ harness: 'codex', windows: [] }, LAYOUT, 120, NOW)
    expect(r).toEqual([])
    const only = rows({ harness: 'codex', windows: [], model: 'gpt-6.1-sol' }, LAYOUT, 120, NOW)
    expect(texts(only)).toEqual([['gpt-6.1-sol']])
  })

  test('compact rows are just another layout', () => {
    const r = rows(bar(), { ...LAYOUT, rows: LAYOUT.compact as string[][] }, 400, NOW)
    expect(ids(r)).toEqual([['model', 'ctx', '5h', '7d', 'month', 'git', 'mem', 'plan']])
  })
})

describe('rows: fitting the width', () => {
  test('every row fits; shortening comes before dropping, lowest priority first', () => {
    for (const width of [160, 120, 100, 80, 60, 40, 20, 8]) {
      const r = rows(bar(), LAYOUT, width, NOW)
      for (const row of r) {
        const w = row.reduce((n, s) => n + textWidth(s.text), 0) + 3 * (row.length - 1)
        expect(w).toBeLessThanOrEqual(width)
      }
    }
    expect(texts(rows(bar(), LAYOUT, 100, NOW))[0]).toEqual(['Opus 5.5 · max', 'ctx ▓▓░░░░ 37% (370k/1M)', '5h 42% ⇣ ↺1h20m', `7d 18% ⇣ ↺${formatResetIn(NOW + 3 * 1440 * 60_000, NOW)}`, 'mo ≈$212'])
    expect(texts(rows(bar(), LAYOUT, 60, NOW))[0]).toEqual(['Opus 5.5', 'ctx ▓▓░░░░ 37%', '5h 42%⇣', '7d 18%⇣', 'mo ≈$212'])
    expect(texts(rows(bar(), LAYOUT, 50, NOW))[0]).toEqual(['Opus 5.5', 'ctx 37%', '5h 42%⇣', '7d 18%⇣', 'mo ≈$212'])
    expect(ids(rows(bar(), LAYOUT, 47, NOW))).toEqual([['model', 'ctx', '5h', '7d'], ['git', 'mem', 'plan', 'upd']])
    expect(ids(rows(bar(), LAYOUT, 42, NOW))).toEqual([['model', 'ctx', '5h', '7d'], ['git', 'mem', 'plan']])
    expect(ids(rows(bar(), LAYOUT, 38, NOW))[1]).toEqual(['git', 'plan'])
    expect(texts(rows(bar(), LAYOUT, 20, NOW))).toEqual([['Opus 5.5', 'ctx 37%'], ['⎇ main ↑2 *']])
  })

  test('the second row drops upd, then dir, then mem; plan outlives mem', () => {
    const b = bar({ dir: 'auth-fix/src/core/status' })
    expect(texts(rows(b, LAYOUT, 400, NOW))[1]).toEqual(['⎇ main ↑2 ✚3 …1 [wt:auth-fix]', 'auth-fix/src/core/status', memSegment(MEM, NOW, 'wide').text, 'plan auth-fix [implement] 3/6', '⬆2'])
    expect(texts(rows(b, LAYOUT, 120, NOW))[1]).toEqual(['⎇ main ↑2 ✚3 …1 [wt:auth-fix]', 'status', memSegment(MEM, NOW, 'compact').text, 'plan auth-fix [implement] 3/6', '⬆2'])
    expect(ids(rows(b, LAYOUT, 52, NOW))[1]).toEqual(['git', 'dir', 'mem', 'plan'])
    expect(ids(rows(b, LAYOUT, 45, NOW))[1]).toEqual(['git', 'mem', 'plan'])
    expect(ids(rows(b, LAYOUT, 42, NOW))[1]).toEqual(['git', 'mem', 'plan'])
    expect(ids(rows(b, LAYOUT, 38, NOW))[1]).toEqual(['git', 'plan'])
  })

  test('a single segment wider than the terminal is truncated', () => {
    const r = rows({ harness: 'claude', windows: [], model: 'An Extremely Long Model Display Name' }, LAYOUT, 12, NOW)
    expect(texts(r)).toEqual([['An Extremel…']])
  })

  test('non-positive or NaN width means unlimited', () => {
    expect(rows(bar(), LAYOUT, 0, NOW)).toEqual(rows(bar(), LAYOUT, 10_000, NOW))
    expect(rows(bar(), LAYOUT, Number.NaN, NOW)).toEqual(rows(bar(), LAYOUT, 10_000, NOW))
  })
})

describe('rows: segment rules', () => {
  test('context colors follow the layout thresholds', () => {
    const color = (pct: number) => rows(bar({ ctx: { pct } }), { ...LAYOUT, rows: [['ctx']] }, 100, NOW)[0]?.[0]?.color
    expect([color(10), color(74.9), color(75), color(89), color(90), color(100)]).toEqual(['green', 'green', 'yellow', 'yellow', 'red', 'red'])
  })

  test('rate windows: pace arrows and colors', () => {
    const w = (pct: number, resetMin: number | undefined) => rows(
      bar({ windows: [{ label: '5h', pct, windowMinutes: 300, ...(resetMin !== undefined ? { resetsAt: at(resetMin) } : {}) }] }),
      { ...LAYOUT, rows: [['5h']] }, 100, NOW)[0]?.[0]
    expect(w(42, 210)).toMatchObject({ text: '5h 42% ⇡ ↺3h30m', color: 'red' })
    expect(w(20, 150)).toMatchObject({ text: '5h 20% ⇣ ↺2h30m', color: 'green' })
    expect(w(52, 150)).toMatchObject({ text: '5h 52% ↺2h30m', color: 'green' })
    expect(w(80, 60)).toMatchObject({ text: '5h 80% ↺1h', color: 'yellow' })
    expect(w(80, 30)).toMatchObject({ text: '5h 80% ⇣ ↺30m', color: 'green' })
    expect(w(95, 10)).toMatchObject({ color: 'red' })
    expect(w(40, undefined)).toMatchObject({ text: '5h 40%', color: 'green' })
  })

  test('`windows` expands every window not named elsewhere in the layout', () => {
    const b = bar({ windows: [{ label: '5h', pct: 10 }, { label: '1d', pct: 20 }, { label: '7d', pct: 30 }] })
    const r = rows(b, { ...LAYOUT, rows: [['5h', 'windows']] }, 200, NOW)
    expect(ids(r)).toEqual([['5h', '1d', '7d']])
    expect(ids(rows(b, { ...LAYOUT, rows: [['windows']] }, 200, NOW))).toEqual([['5h', '1d', '7d']])
  })

  test('month: estimate with ≈, tokens only, or the provider percentage', () => {
    const m = (month: BarModel['month']) => texts(rows(bar(month === undefined ? {} : { month }), { ...LAYOUT, rows: [['month']] }, 200, NOW))[0]?.[0]
    expect(m({ tokens: 38_000_000, usd: 12.3, estimate: true })).toBe('mo ≈$12.30 · 38M tok')
    expect(m({ tokens: 38_000_000, estimate: true })).toBe('mo 38M tok')
    expect(m({ tokens: 0, usd: 314.12, estimate: false, pct: 62.8 })).toBe('mo 63% $314')
    expect(m({ tokens: 0, estimate: true })).toBeUndefined()
    const red = rows(bar({ month: { tokens: 0, estimate: false, pct: 93 } }), { ...LAYOUT, rows: [['month']] }, 200, NOW)[0]?.[0]
    expect(red?.color).toBe('red')
  })

  test('git: all counters, detached HEAD, conflicts', () => {
    const g = (git: BarModel['git']) => rows(bar(git === undefined ? {} : { git }), { ...LAYOUT, rows: [['git']] }, 200, NOW)[0]?.[0]
    expect(g({ branch: 'main', ahead: 2, behind: 1, staged: 1, unstaged: 3, untracked: 1, stash: 2, conflicts: 1, worktree: 'wt' }))
      .toEqual({ id: 'git', text: '⎇ main ↑2 ↓1 ●1 ✚3 …1 ⚑2 ⚠1 [wt:wt]', color: 'red' })
    expect(g({ branch: '4f2a9c1', detached: true, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, stash: 0, conflicts: 0 }))
      .toEqual({ id: 'git', text: '⎇ @4f2a9c1', color: 'green' })
    const short = rows(bar({ git: { branch: 'spec/a-really-long-branch-name-here', ahead: 1, behind: 0, staged: 2, unstaged: 0, untracked: 0, stash: 0, conflicts: 0 } }), { ...LAYOUT, rows: [['git', 'plan']] }, 40, NOW)
    expect(texts(short)[0]?.[0]).toBe('⎇ spec/a-really-long-bran… ↑1 *')
  })

  test('git: the working tree lines added and removed follow the untracked count; nothing when both are zero', () => {
    const g = (git: BarModel['git']) => rows(bar(git === undefined ? {} : { git }), { ...LAYOUT, rows: [['git']] }, 200, NOW)[0]?.[0]?.text
    const base = { branch: 'main', ahead: 0, behind: 0, staged: 0, unstaged: 3, untracked: 1, stash: 2, conflicts: 0 }
    expect(g({ ...base, lines: { added: 42, removed: 7 } })).toBe('⎇ main ✚3 …1 +42 −7 ⚑2')
    expect(g({ ...base, lines: { added: 5, removed: 0 } })).toBe('⎇ main ✚3 …1 +5 −0 ⚑2')
    expect(g({ ...base, lines: { added: 0, removed: 0 } })).toBe('⎇ main ✚3 …1 ⚑2')
    expect(g(base)).toBe('⎇ main ✚3 …1 ⚑2')
  })

  test('cost, plan and updates', () => {
    const one = (b: Partial<BarModel>, id: string) => rows(bar(b), { ...LAYOUT, rows: [[id]] }, 200, NOW)[0]?.[0]?.text
    expect(one({ cost: { usd: 0.4234 } }, 'cost')).toBe('$0.42')
    expect(one({ plan: { title: 'Statusline', phase: 'verify', done: 0, total: 0 } }, 'plan')).toBe('plan Statusline [verify]')
    expect(one({ updates: 0 }, 'upd')).toBeUndefined()
    expect(one({ updates: 3 }, 'upd')).toBe('⬆3')
  })

  test('memory segment comes from memSegmentWith in the layout emoji mode', () => {
    const wide = memSegment(MEM, NOW, 'wide')
    const withEmoji = rows(bar(), { ...LAYOUT, rows: [['mem']] }, 400, NOW)[0]?.[0]
    expect(withEmoji?.text).toBe(wide.text)
    expect(withEmoji?.text).toBe(memSegmentWith(MEM, NOW, 'wide', { emoji: true }).text)
    const plain = rows(bar(), { ...LAYOUT, emoji: false, rows: [['mem']] }, 400, NOW)[0]?.[0]
    expect(plain?.text).toBe(memSegmentWith(MEM, NOW, 'wide', { emoji: false }).text)
    expect(plain?.text).not.toMatch(/\p{Emoji_Presentation}/u)
    const narrow = rows(bar(), { ...LAYOUT, emoji: false, rows: [['mem']] }, 30, NOW)[0]?.[0]
    expect(narrow?.text.startsWith('brain ')).toBe(true)
    expect(rows(bar({ mem: undefined }), { ...LAYOUT, rows: [['mem']] }, 400, NOW)).toEqual([])
  })

  test('control characters in data never reach the terminal', () => {
    const r = rows(bar({ model: 'evil\u001b]0;pwned\u0007model' }), { ...LAYOUT, rows: [['model']] }, 200, NOW)
    expect(r[0]?.[0]?.text).not.toContain('\u001b')
  })

  test('unknown ids are ignored', () => {
    expect(ids(rows(bar(), { ...LAYOUT, rows: [['nope', 'model', '30d']] }, 200, NOW))).toEqual([['model']])
  })
})

function flowRec(workflow: string, phase?: string, opts: { title?: string, step?: string } = {}): FlowRecord {
  const t0 = NOW - 12 * 60_000
  let r = flowStart(undefined, opts.title !== undefined ? { workflow, title: opts.title, source: 'command' } : { workflow, source: 'command' }, t0).record
  if (phase !== undefined) r = flowPhase(r, { phase }, t0 + 1).record
  if (opts.step !== undefined) r = flowStep(r, { text: opts.step }, t0 + 2).record
  return r
}

const SPEC_PLAN: NonNullable<BandInput['plan']> = { path: '/repo/docs/plans/p.md', type: 'Feature', status: 'IN_PROGRESS', phase: 'implement', approved: true, since: NOW - 12 * 60_000, done: 3, total: 7, current: 'Task 4: parser tests' }

function flowView(over: Partial<BandInput> = {}): BandView {
  return bandView({ nowMs: NOW, foldAfterSec: 8, flow: flowRec('plan-build', 'implement', { title: 'Rate limit the public API' }), plan: SPEC_PLAN, ...over })
}

describe('rows: the running workflow (flow) and the code indexes (index)', () => {
  const ROW: StatusLayout = { ...LAYOUT, rows: [['git', 'mem', 'index', 'flow', 'plan', 'upd']] }

  test('flow: the band\'s one-row view with the run\'s title; while it shows, the plan text is gone', () => {
    const r = rows(bar({ flow: flowView(), index: 'ready' }), ROW, 400, NOW)
    expect(texts(r)).toEqual([['⎇ main ↑2 ✚3 …1 [wt:auth-fix]', memSegment(MEM, NOW, 'wide').text, 'idx ready', 'plan-build ● Implement 3/7 · Rate limit the public API', '⬆2']])
    expect(r[0]?.find(s => s.id === 'flow')?.color).toBe('magenta')
    expect(texts(rows(bar({ flow: { ...flowView(), visible: false } }), ROW, 400, NOW))[0]).toContain('plan auth-fix [implement] 3/6')
    expect(ids(rows(bar(), ROW, 400, NOW))[0]).toEqual(['git', 'mem', 'plan', 'upd'])
    expect(texts(rows(bar({ flow: flowView() }), { ...LAYOUT, rows: [['plan']] }, 400, NOW))).toEqual([['plan auth-fix [implement] 3/6']])
  })

  test('flow: the status shows in words and in the segment color', () => {
    const one = (v: BandView) => rows(bar({ flow: v }), { ...LAYOUT, rows: [['flow']] }, 400, NOW)[0]?.[0]
    const waiting = one(flowView({ interaction: { state: 'paused', kind: 'decision', reason: 'Redis or in-memory?' } }))
    expect(waiting).toMatchObject({ text: 'plan-build ● Implement 3/7 · waiting for you · Rate limit the public API', color: 'yellow' })
    const approval = one(flowView({ flow: flowRec('plan-build', 'approve'), plan: { ...SPEC_PLAN, status: 'PENDING', phase: 'plan', approved: false } }))
    expect(approval).toMatchObject({ text: 'plan-build ● Approve · awaiting approval', color: 'cyan' })
    const failed = one(flowView({ flow: flowEnd(flowRec('bugfix', 'prove'), 'failed', NOW - 1000).record, plan: undefined }))
    expect(failed).toMatchObject({ text: 'bugfix ✗ Prove · failed', color: 'red' })
    const done = one(flowView({ flow: flowEnd(flowRec('research', 'write'), 'done', NOW - 1000).record, plan: undefined }))
    expect(done).toMatchObject({ text: 'research ✓ done', color: 'green' })
    expect(one(flowView({ flow: flowRec('inspect'), plan: undefined }))?.text).toBe('inspect')
  })

  test('narrow rows: the index state shortens first, then the workflow loses its title, then goes compact', () => {
    const b = bar({ flow: flowView(), index: 'ready' })
    const L: StatusLayout = { ...LAYOUT, rows: [['index', 'flow']] }
    expect(texts(rows(b, L, 66, NOW))).toEqual([['idx ready', 'plan-build ● Implement 3/7 · Rate limit the public API']])
    expect(texts(rows(b, L, 64, NOW))).toEqual([['idx ✓', 'plan-build ● Implement 3/7 · Rate limit the public API']])
    expect(texts(rows(b, L, 56, NOW))).toEqual([['idx ✓', 'plan-build ● Implement 3/7']])
    expect(texts(rows(b, L, 32, NOW))).toEqual([['idx ✓', 'plan-build ● Impl 3/7']])
    expect(texts(rows(b, L, 26, NOW))).toEqual([['plan-build ● Impl 3/7']])
    expect(texts(rows(b, L, 16, NOW))).toEqual([['plan-build ● Im…']])
    expect(ids(rows(b, ROW, 40, NOW))[0]).toEqual(['git', 'flow'])
  })

  test('a nested run shows its breadcrumb, and only the inner workflow when space runs out', () => {
    let r = flowStart(undefined, { workflow: 'requirements', source: 'command' }, NOW - 5 * 60_000).record
    r = flowPhase(r, { phase: 'research' }, NOW - 4 * 60_000).record
    r = flowStart(r, { workflow: 'research', source: 'skill' }, NOW - 3 * 60_000).record
    r = flowPhase(r, { phase: 'gather' }, NOW - 2 * 60_000).record
    const b = bar({ flow: bandView({ nowMs: NOW, foldAfterSec: 8, flow: r }) })
    const L: StatusLayout = { ...LAYOUT, rows: [['flow']] }
    expect(texts(rows(b, L, 400, NOW))).toEqual([['requirements › research ● Gather']])
    expect(texts(rows(b, L, 20, NOW))).toEqual([['research ● Gather']])
  })

  test('the workflow glyphs are not emoji: they stay in layouts without emoji', () => {
    const r = rows(bar({ flow: flowView() }), { ...LAYOUT, emoji: false, rows: [['flow']] }, 400, NOW)
    expect(texts(r)).toEqual([['plan-build ● Implement 3/7 · Rate limit the public API']])
  })

  test('index: one word per state (long), a mark when space runs out, a color per state', () => {
    const one = (index: IndexStatus | undefined, width = 400) => rows(bar(index === undefined ? {} : { index }), { ...LAYOUT, rows: [['index']] }, width, NOW)[0]?.[0]
    expect(one('ready')).toEqual({ id: 'index', text: 'idx ready', color: 'green' })
    expect(one('building')).toEqual({ id: 'index', text: 'idx building', color: 'yellow' })
    expect(one('none')).toEqual({ id: 'index', text: 'idx none', color: 'gray' })
    expect(one('failed')).toEqual({ id: 'index', text: 'idx failed', color: 'red' })
    expect(one('off')).toEqual({ id: 'index', text: 'idx off', color: 'gray', dim: true })
    expect(one(undefined)).toBeUndefined()
    expect([one('ready', 6), one('building', 6), one('none', 6), one('failed', 6)].map(s => s?.text)).toEqual(['idx ✓', 'idx ⟳', 'idx ○', 'idx ✗'])
  })
})

describe('rows: the canonical second row', () => {
  test('a segment id nobody feeds is left out, and the row drops upd, dir and the index state first', () => {
    const ROW: StatusLayout = { ...LAYOUT, rows: [['git', 'dir', 'mem', 'index', 'plan', 'upd']] }
    const b = bar({ dir: 'auth-fix/src/core/status', index: 'ready' })
    const at = (w: number) => rows(b, ROW, w, NOW)[0] ?? []
    expect(at(400).map(s => s.id)).toEqual(['git', 'dir', 'mem', 'index', 'plan', 'upd'])
    const dropped: string[] = []
    let prev = at(400).map(s => s.id)
    for (let w = 400; w >= 10; w--) {
      const ids = at(w).map(s => s.id)
      for (const id of prev) if (!ids.includes(id) && !dropped.includes(id)) dropped.push(id)
      prev = ids
    }
    expect(dropped.slice(0, 3)).toEqual(['upd', 'dir', 'index'])
  })
})

describe('renderers', () => {
  const sample: Segment[][] = [
    [{ id: 'model', text: 'Opus 5.5', color: 'cyan' }, { id: 'month', text: 'mo ≈$12' }],
    [{ id: 'dir', text: 'src/#1', color: 'gray', dim: true }],
  ]

  test('renderPlain joins with the separator, one line per row', () => {
    expect(renderPlain(sample)).toBe(`Opus 5.5${SEGMENT_SEPARATOR}mo ≈$12\nsrc/#1`)
    expect(renderPlain([])).toBe('')
  })

  test('renderAnsi colors segments and dims separators', () => {
    expect(renderAnsi(sample)).toBe('\u001b[36mOpus 5.5\u001b[0m\u001b[2m │ \u001b[0mmo ≈$12\n\u001b[2;90msrc/#1\u001b[0m')
  })

  test('renderTmux uses #[…] styles, escapes # and keeps one line', () => {
    expect(renderTmux(sample)).toBe('#[fg=cyan]Opus 5.5#[default]#[fg=colour244] │ #[default]mo ≈$12#[fg=colour244] │ #[default]#[fg=colour244,dim]src/##1#[default]')
    expect(renderTmux(sample)).not.toContain('\n')
  })

  test('renderers sanitize segments built by hand', () => {
    const bad: Segment[][] = [[{ id: 'x', text: 'a\u001b[2Jb' }]]
    expect(renderPlain(bad)).toBe('a [2Jb')
    expect(renderAnsi(bad)).toBe('a [2Jb')
  })
})
