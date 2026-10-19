import { describe, expect, test } from 'bun:test'
import type { BandInput, BandView } from '../../../src/core/flow/band'
import { bandView } from '../../../src/core/flow/band'
import { flowPhase, flowStart, flowStep } from '../../../src/core/flow/record'
import type { BarModel } from '../../../src/core/status/model'
import { barLines, barOneLine, contextBar, shortDuration } from '../../../src/core/status/bar'
import { renderAnsiLines, renderPlainLines, renderTmuxLines } from '../../../src/core/status/render'
import { textWidth } from '../../../src/core/status/format'

const NOW = Date.parse('2026-10-08T12:00:00Z')
const LAYOUT = { thresholds: { ctxWarn: 75, ctxCrit: 90 }, emoji: true }
const H = 3_600_000

function specRun(over: Partial<BandInput> = {}): BandView {
  const t0 = NOW - 12 * 60_000
  let r = flowStart(undefined, { workflow: 'plan-build', title: 'Rate limit the public API', source: 'command' }, t0).record
  r = flowPhase(r, { phase: 'implement' }, t0 + 1).record
  r = flowStep(r, { text: 'Running middleware tests' }, t0 + 2).record
  return bandView({
    nowMs: NOW, foldAfterSec: 8, flow: r,
    plan: { path: '/repo/docs/plans/p.md', type: 'Feature', status: 'IN_PROGRESS', phase: 'implement', approved: true, since: t0, done: 3, total: 7 },
    agents: [{ id: 'a1', label: 'buracle:plan-build-review', startedAt: t0 }],
    ...over,
  })
}

function bar(over: Partial<BarModel> = {}): BarModel {
  return {
    harness: 'claude',
    model: 'Opus 5.5',
    effort: 'xhigh',
    ctx: { pct: 24, window: 1_000_000, tokens: 240_000 },
    windows: [
      { label: '5h', pct: 2, windowMinutes: 300, resetsAt: new Date(NOW + 4 * H).toISOString() },
      { label: '7d', pct: 32, windowMinutes: 10_080, resetsAt: new Date(NOW + 50 * H).toISOString() },
    ],
    git: { branch: 'main', ahead: 0, behind: 0, staged: 0, unstaged: 3, untracked: 0, stash: 0, conflicts: 0 },
    ...over,
  }
}

const INFO = { product: { name: 'Buracle', version: '0.2.0' }, harness: { label: 'CC', version: '2.1.294', plan: 'Max' }, memoryUrl: 'http://localhost:41777', lines: { added: 120, removed: 30 } }

describe('shortDuration', () => {
  test('minutes, hours, days as in the Buracle bar', () => {
    expect(shortDuration(45 * 60_000)).toBe('45m')
    expect(shortDuration(4 * H)).toBe('4h')
    expect(shortDuration(3 * H + 20 * 60_000)).toBe('3h20m')
    expect(shortDuration(12 * H + 5 * 60_000)).toBe('12h')
    expect(shortDuration(30 * H)).toBe('1d6h')
    expect(shortDuration(50 * H)).toBe('2d')
    expect(shortDuration(-5)).toBe('0m')
  })
})

describe('contextBar', () => {
  test('eight cells; unknown fill is all empty', () => {
    expect(contextBar(undefined).bar).toBe('░░░░░░░░')
    expect(contextBar(0).bar).toBe('░░░░░░░░')
    expect(contextBar(50)).toEqual({ bar: '████░░░░', filled: 4 })
    expect(contextBar(3).filled).toBe(1)
    expect(contextBar(140).bar).toBe('████████')
  })
})

describe('barLines', () => {
  test('line one: model, effort, window, context, both windows with pace and reset, lines, git', () => {
    const lines = barLines(bar(), INFO, LAYOUT, 200, NOW)
    const text = renderPlainLines(lines).split('\n')
    expect(text[0]).toBe('Opus 5.5 [xhigh] [1M] | ██░░░░░░ 24% | 5h: 2% ↓ 4h | 7d: 32% ↓ 2d | +120 -30 | ⎇ main ✚3')
    expect(text[1]).toBe('Buracle 0.2.0 · CC 2.1.294 (Max) · Buracle Brain: localhost:41777')
    expect(text).toHaveLength(2)
  })

  test('an over-pace window turns red with an up arrow; an unknown context reads --%', () => {
    const b = bar({ ctx: undefined, windows: [{ label: '5h', pct: 80, windowMinutes: 300, resetsAt: new Date(NOW + 4 * H).toISOString() }] })
    const lines = barLines(b, {}, LAYOUT, 200, NOW)
    expect(renderPlainLines(lines)).toContain('░░░░░░░░ --% | 5h: 80% ↑ 4h')
    const five = lines[0]?.find(s => s.text.startsWith('80%'))
    expect(five?.color).toBe('red')
  })

  test('an active plan adds the Spec line', () => {
    const lines = barLines(bar({ plan: { title: 'auth-fix', phase: 'implement', done: 3, total: 6 } }), INFO, LAYOUT, 200, NOW)
    expect(renderPlainLines(lines).split('\n')[1]).toBe('Plan: auth-fix [implement] ▰▰▰▱▱▱ 3/6')
  })

  test('a running workflow takes the plan line\'s place: the run, its title, the current step, the subagents and the time so far', () => {
    const plan = { title: 'auth-fix', phase: 'implement', done: 3, total: 6 }
    const text = renderPlainLines(barLines(bar({ plan, flow: specRun() }), INFO, LAYOUT, 200, NOW)).split('\n')
    expect(text).toEqual([
      'Opus 5.5 [xhigh] [1M] | ██░░░░░░ 24% | 5h: 2% ↓ 4h | 7d: 32% ↓ 2d | +120 -30 | ⎇ main ✚3',
      'plan-build ● Implement 3/7 | Rate limit the public API | ▸ Running middleware tests | ⟳ plan-build-review | 12m',
      'Buracle 0.2.0 · CC 2.1.294 (Max) · Buracle Brain: localhost:41777',
    ])
    expect(renderAnsiLines(barLines(bar({ flow: specRun() }), INFO, LAYOUT, 200, NOW))).toContain('\u001b]8;;http://localhost:41777\u001b\\')
    expect(renderPlainLines(barLines(bar({ plan, flow: { ...specRun(), visible: false } }), INFO, LAYOUT, 200, NOW)).split('\n')[1]).toBe('Plan: auth-fix [implement] ▰▰▰▱▱▱ 3/6')
  })

  test('a run that waits for the person says so and why', () => {
    const v = specRun({ interaction: { state: 'paused', kind: 'decision', reason: 'Redis or in-memory?' } })
    const lines = barLines(bar({ flow: v }), INFO, LAYOUT, 200, NOW)
    expect(renderPlainLines(lines).split('\n')[1]).toBe('plan-build ● Implement 3/7 · waiting for you | Rate limit the public API | ▸ Redis or in-memory? | ⟳ plan-build-review | 12m')
    expect(lines[1]?.find(s => s.text.startsWith('▸'))?.color).toBe('yellow')
  })

  test('the footer shows the code index state after the memory status', () => {
    const footer = (b: BarModel) => renderPlainLines(barLines(b, INFO, LAYOUT, 200, NOW)).split('\n').at(-1)
    expect(footer(bar({ index: 'ready' }))).toBe('Buracle 0.2.0 · CC 2.1.294 (Max) · Buracle Brain: localhost:41777 · idx ready')
    expect(footer(bar({ index: 'building', updates: 2 }))).toBe('Buracle 0.2.0 · CC 2.1.294 (Max) · Buracle Brain: localhost:41777 · idx building · ⬆2')
    expect(footer(bar())).toBe('Buracle 0.2.0 · CC 2.1.294 (Max) · Buracle Brain: localhost:41777')
  })

  test('the footer shows the month estimate and the updates after the index state; the updates go first when space runs out', () => {
    const month = { tokens: 0, usd: 212.4, estimate: true }
    const footer = (b: BarModel, w = 200) => renderPlainLines(barLines(b, INFO, LAYOUT, w, NOW)).split('\n').at(-1) ?? ''
    expect(footer(bar({ index: 'ready', month, updates: 2 }))).toBe('Buracle 0.2.0 · CC 2.1.294 (Max) · Buracle Brain: localhost:41777 · idx ready · mo ≈$212 · ⬆2')
    const full = bar({ index: 'ready', month, updates: 2 })
    const widths: Record<string, number> = {}
    for (let w = 200; w >= 20; w--) {
      const text = footer(full, w)
      if (!text.includes('⬆2')) widths['upd'] ??= w
      if (!text.includes('mo ')) widths['month'] ??= w
    }
    expect(widths['upd']).toBeGreaterThan(widths['month'] ?? 0)
  })

  test('O3: failing hooks and a runtime behind the checkout show in the footer, red and yellow; nothing while all is well', () => {
    const footer = (b: BarModel, w = 200) => barLines(b, INFO, LAYOUT, w, NOW).at(-1) ?? []
    const text = (b: BarModel, w = 200) => footer(b, w).map(s => s.text).join('')
    expect(text(bar({ hooks: { failures: 0, failClosed: 0 } }))).toBe('Buracle 0.2.0 · CC 2.1.294 (Max) · Buracle Brain: localhost:41777')
    expect(text(bar({ hooks: { failures: 3, failClosed: 1 }, index: 'ready' }))).toBe('Buracle 0.2.0 · CC 2.1.294 (Max) · hooks ✗3 (1 denied) · Buracle Brain: localhost:41777 · idx ready')
    expect(footer(bar({ hooks: { failures: 3, failClosed: 1 } })).find(s => s.id === 'hooks')?.color).toBe('red')
    expect(footer(bar({ hooks: { failures: 0, failClosed: 0, runtimeBehind: true } })).find(s => s.id === 'hooks')).toMatchObject({ text: 'runtime behind: buracle install', color: 'yellow' })
    const narrow = text(bar({ hooks: { failures: 3, failClosed: 1 }, index: 'ready', updates: 2 }), 12)
    expect(narrow).toBe('hooks ✗3')
  })

  test('O3: in one narrow line the hooks alarm stays beside the first line\'s parts', () => {
    const tight = barOneLine(bar({ hooks: { failures: 2, failClosed: 0 } }), INFO, LAYOUT, 70, NOW).map(s => s.text).join('')
    expect(tight).toContain('hooks ✗2')
    expect(textWidth(tight)).toBeLessThanOrEqual(70)
  })

  test('barOneLine folds the footer\'s month part into the one line when everything fits', () => {
    const one = barOneLine(bar({ month: { tokens: 0, usd: 212.4, estimate: true } }), INFO, LAYOUT, 400, NOW).map(s => s.text).join('')
    expect(one).toContain('mo ≈$212')
  })

  test('a narrow workflow line keeps the run, then its compact form', () => {
    const line = (w: number) => renderPlainLines(barLines(bar({ flow: specRun() }), INFO, LAYOUT, w, NOW)).split('\n')[1]
    expect(line(30)).toBe('plan-build ● Implement 3/7')
    expect(line(24)).toBe('plan-build ● Impl 3/7')
    for (const w of [120, 80, 60, 40, 24]) {
      for (const l of barLines(bar({ flow: specRun(), index: 'ready' }), INFO, LAYOUT, w, NOW)) expect(textWidth(l.map(s => s.text).join(''))).toBeLessThanOrEqual(w)
    }
  })

  test('narrow terminals shorten, then drop the low-priority parts; no line is wider than the width', () => {
    for (const width of [100, 80, 60, 40, 24]) {
      const lines = barLines(bar({ dir: '~/work/project' }), INFO, LAYOUT, width, NOW)
      for (const l of lines) expect(textWidth(l.map(s => s.text).join(''))).toBeLessThanOrEqual(width)
      expect(renderPlainLines(lines)).toContain('Opus 5.5')
    }
    const narrow = renderPlainLines(barLines(bar(), INFO, LAYOUT, 60, NOW)).split('\n')[0] ?? ''
    expect(narrow).not.toContain('+120')
    expect(narrow).toContain('24%')
  })

  test('emoji off keeps the spaces around values', () => {
    const plain = renderPlainLines(barLines(bar(), INFO, { ...LAYOUT, emoji: false }, 200, NOW))
    expect(plain).toContain('Buracle 0.2.0 · CC 2.1.294 (Max)')
    expect(plain).toContain('Buracle Brain: localhost:41777')
  })

  test('the memory address is an OSC 8 link only in ANSI', () => {
    const lines = barLines(bar(), INFO, LAYOUT, 200, NOW)
    expect(renderAnsiLines(lines)).toContain('\u001b]8;;http://localhost:41777\u001b\\')
    expect(renderPlainLines(lines)).not.toContain('\u001b')
    expect(renderTmuxLines(lines)).not.toContain(']8;;')
  })

  test('a link that is not http(s)/file/obsidian is never emitted', () => {
    const lines = barLines(bar(), { memoryUrl: 'javascript:alert(1)' }, LAYOUT, 200, NOW)
    expect(renderAnsiLines(lines)).not.toContain(']8;;javascript')
  })
})

describe('barOneLine', () => {
  test('folds the lines into one for tmux and drops the footer facts first', () => {
    const one = barOneLine(bar(), INFO, LAYOUT, 400, NOW)
    const text = one.map(s => s.text).join('')
    expect(text).toContain('Opus 5.5')
    expect(text).toContain('Buracle Brain: localhost:41777')
    expect(text).not.toContain('Buracle 0.2.0')
    const tight = barOneLine(bar(), INFO, LAYOUT, 70, NOW).map(s => s.text).join('')
    expect(textWidth(tight)).toBeLessThanOrEqual(70)
  })

  test('a running workflow shares the one line with the first line\'s parts and outranks the weekly window', () => {
    const wide = barOneLine(bar({ flow: specRun() }), INFO, LAYOUT, 400, NOW).map(s => s.text).join('')
    expect(wide).toContain('| plan-build ● Implement 3/7 | Rate limit the public API |')
    expect(wide).toContain('Buracle Brain: localhost:41777')
    const tight = barOneLine(bar({ flow: specRun() }), INFO, LAYOUT, 80, NOW).map(s => s.text).join('')
    expect(tight).toBe('Opus 5.5 [xhigh] [1M] | ██░░░░░░ 24% | 5h: 2% ↓ 4h | plan-build ● Implement 3/7')
  })
})
