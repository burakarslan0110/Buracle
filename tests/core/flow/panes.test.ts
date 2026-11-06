import { describe, expect, test } from 'bun:test'
import { bandView } from '../../../src/core/flow/band'
import { cachedHarnessVersionOf, memoryPaneLines, modStatusLines, planPaneLines, themeOf } from '../../../src/core/flow/panes'
import { flowPhase, flowStart } from '../../../src/core/flow/record'
import { emptyState } from '../../../src/core/plan/state'

const T = Date.UTC(2026, 9, 9, 10, 0, 0)

describe('panes', () => {
  test('the plan pane: the running workflow, the plan, the pause and the stop guard', () => {
    const flow = flowPhase(flowStart(undefined, { workflow: 'bugfix', source: 'command' }, T).record, { phase: 'red' }, T + 1).record
    const view = bandView({ nowMs: T + 60_000, foldAfterSec: 8, flow })
    const state = { ...emptyState(), plan: { path: '/r/docs/plans/p.md', slug: 'p', status: 'IN_PROGRESS' as const, type: 'Feature' as const, phase: 'implement' as const, registeredAt: T }, interaction: { state: 'paused' as const, kind: 'decision' as const, since: T } }
    expect(planPaneLines(view, state)).toEqual([
      { text: 'bugfix · running · 1m', bold: true },
      { text: 'phases: ✓ Investigate  ● RED  ○ Fix  ○ Prove  ○ Quality gate  ○ Finish' },
      { text: 'plan: p (Feature)', bold: true },
      { text: 'status IN_PROGRESS · phase implement' },
      { text: 'file: /r/docs/plans/p.md', dim: true },
      { text: 'paused: the stop guard lets the turn end; say "continue" to resume', color: 'warning' },
      { text: 'stop guard blocks: plan 0 · chain 0', dim: true },
    ])
    expect(planPaneLines(bandView({ nowMs: T, foldAfterSec: 8 }), emptyState())).toEqual([
      { text: 'No plan is bound to this session.', bold: true },
      { text: 'A new plan: /plan-build <task> · an existing one: buracle plan register <path>', dim: true },
    ])
  })

  test('the memory pane from the status file, or a hint when there is none', () => {
    const status = { v: 3, health: 'warn', project: 'demo', counts: { project: 4, person: 2 }, captures: 3, last_capture: { at: '2026-10-23T09:30:12.000Z', by: 'codex', saved: 2 } }
    expect(memoryPaneLines(status, 'http://localhost:41777', '/home/me/.buracle/brain')).toEqual([
      { text: 'memory: warn', color: 'warning', bold: true },
      { text: 'project demo 4 · person 2' },
      { text: 'inbox 3 · last capture 2026-10-23 09:30' },
      { text: 'web UI: http://localhost:41777  (w)', dim: true },
      { text: 'brain: /home/me/.buracle/brain', dim: true },
    ])
    expect(memoryPaneLines(undefined, undefined, '/b').map(l => l.text)).toEqual(['No memory status yet.', '`buracle mem status` and memory writes create the status file.', 'brain: /b'])
    expect(memoryPaneLines({ v: 1, health: 'ok', notes: { project: 1 } }, undefined, '/b')[0]?.text).toBe('No memory status yet.')
    expect(memoryPaneLines({ v: 2, health: 'ok', counts: { project: 1, person: 1 }, upkeep: 0, captures: 0 }, undefined, '/b')[0]?.text).toBe('No memory status yet.')
    expect(memoryPaneLines({ v: 3, health: 'ok', counts: { project: 1, person: 1 }, captures: 0 }, undefined, '/b').map(l => l.text)).toContain('inbox 0 · last capture none yet')
  })

  test('/buracle-status lines and the theme of segment colors', () => {
    expect(modStatusLines({ version: '0.3.0', claude: '2.1.318', sid: 's1', interactive: true, bypass: true, strictness: 'enforce', redact: true, band: false, commands: ['buracle-ping', 'brain'], uiUrl: 'http://localhost:1' })).toEqual([
      'Buracle 0.3.0 · Claude Code 2.1.318',
      'session: s1 · interactive',
      "permissions: bypass (no approval prompts; Buracle's guards and consent gate protect)",
      'routing: enforce · secret masking: on · workflow band: off',
      'commands: /buracle-ping /brain',
      'memory UI: http://localhost:1',
    ])
    expect(modStatusLines({ version: '0.3.0', sid: '', interactive: false, bypass: false, strictness: 'warn', redact: false, band: true, commands: [] })[0]).toBe('Buracle 0.3.0 · Claude Code')
    expect(themeOf('green')).toBe('success')
    expect(themeOf('magenta')).toBe('claude')
    expect(themeOf(undefined)).toBeUndefined()
  })

  test('the installed harness version comes from the version cache only while the entry is fresh', () => {
    const at = T - 60_000
    const text = JSON.stringify({ claude: { v: '2.1.318', at }, omp: { v: '18.10.4', at: T - 13 * 60 * 60_000 }, codex: { v: 7, at }, opencode: { at } })
    expect(cachedHarnessVersionOf(text, 'claude', T)).toBe('2.1.318')
    expect(cachedHarnessVersionOf(text, 'omp', T)).toBeUndefined() // older than 12 hours
    expect(cachedHarnessVersionOf(text, 'claude', at - 1)).toBeUndefined() // written after now
    expect(cachedHarnessVersionOf(text, 'codex', T)).toBeUndefined() // not a string
    expect(cachedHarnessVersionOf(text, 'opencode', T)).toBeUndefined() // no version
    expect(cachedHarnessVersionOf(text, 'gemini', T)).toBeUndefined()
    expect(cachedHarnessVersionOf('{not json', 'claude', T)).toBeUndefined()
    expect(cachedHarnessVersionOf('[1,2]', 'claude', T)).toBeUndefined()
    expect(cachedHarnessVersionOf(undefined, 'claude', T)).toBeUndefined()
  })
})
