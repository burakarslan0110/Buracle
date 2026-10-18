import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { HookBinding, HookSpec, HooksMatrix } from '../../../src/core/catalog'
import { hookFallbacks } from '../../../src/core/catalog'
import { HARNESSES, HOOK_IDS } from '../../../src/core/events'
import {
  BLOCKING_HOOKS, CLAUDE_CLASSIC_EVENTS, CLAUDE_ENGINE_EVENTS, CODEX_EVENTS, HOOK_EVENTS, OMP_EVENTS, OPENCODE_EVENTS, validateHooksMatrix,
} from '../../../src/core/policy/hooks-matrix'
import { harnessMcpToolName } from '../../../src/core/policy/routing'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'

const REPO = join(paths.canonicalDir(), '..')
const RAW = parseYaml(readFileSync(join(paths.canonicalDir(), 'hooks.yaml'), 'utf8')) as HooksMatrix
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T
const binding = (h: HookSpec, harness: keyof HookSpec['bindings']): HookBinding | undefined => {
  const b = h.bindings[harness]
  return b && 'event' in b ? b : undefined
}

describe('canonical/hooks.yaml', () => {
  test('is valid and loads through the canonical loader', () => {
    expect(validateHooksMatrix(RAW)).toEqual([])
    expect(loadCanonicalSync(paths.canonicalDir()).hooks).toEqual(RAW)
  })

  test('has H01…H28 exactly once, in order, with names from DESIGN §5', () => {
    expect(RAW.hooks.map(h => h.id)).toEqual([...HOOK_IDS])
    expect(HOOK_IDS.length).toBe(28)
    expect(RAW.hooks.map(h => h.name)).toEqual([
      'guard.bash', 'guard.write', 'route.tools', 'check.file', 'context.watch', 'compact.save', 'compact.restore', 'plan.stop', 'plan.question',
      'plan.interaction', 'plan.validate', 'plan.capture', 'memory.inject', 'memory.capture', 'capability.catalog', 'session.maint',
      'profile.guard', 'status.feed', 'review.gate', 'consent.gate', 'workspace.prepare',
      'route.prompt', 'route.audit', 'usage.ledger', 'flow.track', 'profile.signals', 'context.session', 'project.assets',
    ])
  })

  test('only H01, H02, H03, H08, H09, H11, H20 and H23 block', () => {
    expect([...BLOCKING_HOOKS]).toEqual(['H01', 'H02', 'H03', 'H08', 'H09', 'H11', 'H20', 'H23'])
    expect(RAW.hooks.filter(h => h.blocking !== 'none').map(h => h.id)).toEqual(['H01', 'H02', 'H03', 'H08', 'H09', 'H11', 'H20', 'H23'])
    expect(RAW.hooks.filter(h => h.blocking === 'stop').map(h => h.id)).toEqual(['H08', 'H11', 'H23'])
    expect(RAW.hooks.find(h => h.id === 'H20')).toMatchObject({ blocking: 'deny', failure: 'open' })
    expect(RAW.hooks.find(h => h.id === 'H23')).toMatchObject({ blocking: 'stop', failure: 'open' })
  })

  test('H22–H26 are bound on all four harnesses', () => {
    const by = Object.fromEntries(RAW.hooks.map(h => [h.id, h])) as Record<string, HookSpec>
    const events = (id: string, harness: keyof HookSpec['bindings']) => {
      const b = binding(by[id] as HookSpec, harness)
      return b ? [b.event, ...(b.also ?? []).map(a => a.event)] : []
    }
    for (const id of ['H22', 'H23', 'H24', 'H25', 'H26']) for (const h of HARNESSES) expect({ id, h, bound: events(id, h).length > 0 }).toEqual({ id, h, bound: true })
    expect([events('H22', 'claude'), events('H22', 'codex'), events('H22', 'opencode'), events('H22', 'omp')]).toEqual([['classic.UserPromptSubmit'], ['UserPromptSubmit'], ['session.prompt', 'session.context'], ['input', 'before_agent_start']])
    expect([events('H23', 'claude'), events('H23', 'codex'), events('H23', 'opencode'), events('H23', 'omp')]).toEqual([['classic.Stop'], ['Stop'], ['session.execution.succeeded'], ['session_stop']])
    expect(binding(by['H24'] as HookSpec, 'claude')?.matcher).toBe('Skill|Grep|Glob|mcp__plugin_buracle_.*')
    expect(String(binding(by['H24'] as HookSpec, 'codex')?.matcher).split('|')).toEqual(expect.arrayContaining(['Bash', 'apply_patch', 'mcp__.+']))
    expect(events('H24', 'opencode')).toContain('session.skill.activated')
    expect(events('H25', 'claude')).toEqual(['command.run', 'tool.call', 'classic.UserPromptExpansion', 'classic.PostToolUse'])
    expect(binding(by['H25'] as HookSpec, 'claude')?.also?.find(a => a.event === 'classic.UserPromptExpansion')).toEqual({ event: 'classic.UserPromptExpansion', matcher: '^buracle:', timeoutMs: 5000 })
    expect(binding(by['H25'] as HookSpec, 'codex')).toEqual({ event: 'UserPromptSubmit', timeoutMs: 5000, also: [{ event: 'SessionStart', matcher: 'resume' }, { event: 'PreToolUse', matcher: 'Bash', timeoutMs: 5000 }] })
    expect(binding(by['H25'] as HookSpec, 'opencode')).toEqual({ event: 'session.prompt', also: [{ event: 'tool.execute.before', matcher: 'skill' }, { event: 'session.skill.activated' }] })
    for (const id of ['H10', 'H25', 'H26']) expect({ id, events: events(id, 'omp') }).toEqual({ id, events: expect.arrayContaining(['input', 'before_agent_start']) })
    const ompRegistered = ['input', 'before_agent_start', 'session_stop', 'tool_call', 'tool_result', 'turn_end', 'session.compacting', 'session_compact', 'session_shutdown', 'session_start', 'session_switch']
    for (const id of ['H22', 'H23', 'H24', 'H25', 'H26']) for (const e of events(id, 'omp')) expect({ id, e, registered: ompRegistered.includes(e) }).toEqual({ id, e, registered: true })
  })

  test('descriptions are English and the omp TTSR claim is gone', () => {
    const text = readFileSync(join(paths.canonicalDir(), 'hooks.yaml'), 'utf8')
    expect(text).not.toMatch(/[ğüşıöçĞÜŞİÖÇ]/)
    expect(text).not.toContain('TTSR rules in the omp plugin')
    for (const h of RAW.hooks) expect({ id: h.id, described: typeof h.description === 'string' && h.description.length > 20 }).toEqual({ id: h.id, described: true })
    for (const word of ['dur', 'bekle', 'devam', 'iptal']) expect(RAW.hooks.find(h => h.id === 'H10')?.description).not.toMatch(new RegExp(`\\b${word}\\b`))
  })

  test('the hard guards fail closed; the stop guard fails open (DESIGN §14)', () => {
    const failure = Object.fromEntries(RAW.hooks.map(h => [h.id, h.failure]))
    expect(failure['H01']).toBe('closed')
    expect(failure['H02']).toBe('closed')
    expect(failure['H08']).toBe('open')
    expect(failure['H11']).toBe('open')
  })

  test('every binding uses a valid event of its harness (also and fallbacks too)', () => {
    for (const h of RAW.hooks) {
      for (const harness of HARNESSES) {
        const b = h.bindings[harness]
        expect(b).toBeDefined()
        if (!b || 'unsupported' in b) continue
        expect(HOOK_EVENTS[harness]).toContain(b.event)
        for (const extra of ((b as { also?: HookBinding[] }).also ?? [])) expect(HOOK_EVENTS[harness]).toContain(extra.event)
        for (const fb of hookFallbacks(b)) expect(CLAUDE_CLASSIC_EVENTS).toContain(fb.event)
      }
    }
  })

  test('bindings follow DESIGN §5 on the key events', () => {
    const by = Object.fromEntries(RAW.hooks.map(h => [h.id, h])) as Record<string, HookSpec>
    const ev = (id: string, harness: keyof HookSpec['bindings']) => binding(by[id] as HookSpec, harness)?.event
    expect([ev('H01', 'claude'), ev('H01', 'codex'), ev('H01', 'opencode'), ev('H01', 'omp')]).toEqual(['classic.PreToolUse', 'PreToolUse', 'permission.evaluate', 'tool_call'])
    expect([ev('H08', 'claude'), ev('H08', 'codex'), ev('H08', 'omp')]).toEqual(['classic.Stop', 'Stop', 'session_stop'])
    expect([ev('H09', 'claude'), ev('H09', 'codex'), ev('H09', 'omp')]).toEqual(['classic.PreToolUse', 'PreToolUse', 'tool_call'])
    expect(binding(by['H09'] as HookSpec, 'codex')?.matcher).toBe('request_user_input|request_user_input_async')
    expect(binding(by['H09'] as HookSpec, 'omp')?.matcher).toBe('ask')
    expect([ev('H10', 'claude'), ev('H10', 'codex'), ev('H10', 'opencode'), ev('H10', 'omp')]).toEqual(['classic.UserPromptSubmit', 'UserPromptSubmit', 'session.prompt', 'input'])
    expect(ev('H06', 'claude')).toBe('classic.PreCompact')
    expect(ev('H15', 'claude')).toBe('classic.SessionStart')
    expect(ev('H19', 'codex')).toBe('SubagentStop')
    const claude = (h: HookSpec) => { const b = binding(h, 'claude'); return b ? [b.event, ...(b.also ?? []).map(a => a.event)] : [] }
    const all = RAW.hooks.flatMap(claude)
    expect([...new Set(all.filter(e => e.startsWith('classic.')))].sort()).toEqual(['PostCompact', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptExpansion', 'UserPromptSubmit'].map(e => `classic.${e}`))
    const h24 = RAW.hooks.find(h => h.id === 'H24') as HookSpec
    expect(binding(h24, 'claude')?.also).toContainEqual({ event: 'classic.PostToolUseFailure', matcher: 'mcp__plugin_buracle_.*', timeoutMs: 5000 })
    expect([...new Set(all.filter(e => !e.startsWith('classic.')))].sort()).toEqual(['command.run', 'session.compact', 'session.measure', 'tool.call', 'tool.describe'])
    expect(RAW.hooks.flatMap(h => hookFallbacks(h.bindings.claude))).toEqual([])
  })

  test('shell and code tools outside Bash are guarded: Claude Monitor (H01/H03), omp eval (H01/H02), context-mode\'s sandbox (H01/H02/H20)', () => {
    const by = Object.fromEntries(RAW.hooks.map(h => [h.id, h])) as Record<string, HookSpec>
    const foreign = 'mcp__(?:plugin_[^_]+_)?context-mode__ctx_.*'
    expect(binding(by['H01'] as HookSpec, 'claude')?.matcher).toBe(`Bash|Monitor|mcp__plugin_buracle_context-mode__.*|${foreign}`)
    expect(binding(by['H20'] as HookSpec, 'claude')?.matcher).toBe(`Bash|Monitor|mcp__plugin_buracle_context-mode__.*|${foreign}`)
    expect(binding(by['H02'] as HookSpec, 'claude')?.matcher).toBe('Edit|Write|MultiEdit|NotebookEdit|mcp__.*')
    expect(binding(by['H03'] as HookSpec, 'claude')?.matcher).toBe('Bash|Monitor|WebSearch|WebFetch|Edit|Write|MultiEdit|Grep|Glob|mcp__plugin_buracle_.*')
    expect(binding(by['H03'] as HookSpec, 'codex')?.matcher).toBe('Bash|apply_patch|mcp__.+')
    expect([binding(by['H01'] as HookSpec, 'codex')?.matcher, binding(by['H02'] as HookSpec, 'codex')?.matcher, binding(by['H20'] as HookSpec, 'codex')?.matcher]).toEqual(['Bash|mcp__.+', 'apply_patch|mcp__.+', 'Bash|mcp__.+'])
    const exec = (h: 'opencode' | 'omp'): string[] => ['ctx_execute', 'ctx_execute_file', 'ctx_batch_execute'].map(t => harnessMcpToolName(h, 'context-mode', t))
    expect(binding(by['H01'] as HookSpec, 'omp')?.matcher).toEqual(['bash', 'eval', ...exec('omp')])
    expect(binding(by['H02'] as HookSpec, 'omp')?.matcher).toEqual(['edit', 'write', 'ast_edit', 'eval', 'mcp__context_mode_ctx_execute', 'mcp__context_mode_ctx_execute_file', 'mcp__context_mode_ctx_index'])
    expect(binding(by['H01'] as HookSpec, 'opencode')?.matcher).toEqual(['bash', ...exec('opencode')])
    expect(binding(by['H20'] as HookSpec, 'opencode')?.matcher).toEqual(['bash', ...exec('opencode'), 'context-mode_ctx_purge'])
    expect(binding(by['H20'] as HookSpec, 'omp')?.matcher).toEqual(['bash', ...exec('omp'), 'mcp__context_mode_ctx_purge'])
    for (const id of ['H01', 'H02', 'H20']) expect(by[id]?.description).toContain('ctx_execute')
  })

  test('H27 context.session: non-blocking, fails open, bound on all four harnesses to the events the session bridge needs', () => {
    const h27 = RAW.hooks.find(h => h.id === 'H27') as HookSpec
    expect(h27).toMatchObject({ name: 'context.session', blocking: 'none', failure: 'open', contract_test: 'tests/core/context-mode.test.ts' })
    expect(BLOCKING_HOOKS).not.toContain('H27')
    const events = (harness: keyof HookSpec['bindings']): string[] => { const b = binding(h27, harness); return b ? [b.event, ...(b.also ?? []).map(a => a.event)] : [] }
    expect(events('claude')).toEqual(['classic.SessionStart', 'classic.UserPromptSubmit', 'classic.PreCompact', 'classic.PostToolUse', 'classic.PostToolUse', 'classic.PostToolUseFailure'])
    expect(events('codex')).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact'])
    expect(events('opencode')).toEqual(['tool.execute.after', 'session.prompt', 'session.created', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.deleted', 'session.compaction', 'session.compaction.ended', 'session.compaction.failed', 'session.context'])
    expect(events('omp')).toEqual(['tool_result', 'input', 'before_agent_start', 'session_start', 'session_switch', 'session_branch', 'turn_end', 'session.compacting', 'session_compact', 'session_shutdown'])
    expect(events('omp')).not.toContain('session_before_compact')
    const also = binding(h27, 'claude')?.also ?? []
    const post = also.filter(a => a.event === 'classic.PostToolUse')
    const sync = post.find(a => a.async !== true)?.matcher?.toString().split('|') ?? []
    const async_ = post.find(a => a.async === true)?.matcher?.toString().split('|') ?? []
    expect(sync).toEqual(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'ExitPlanMode', 'AskUserQuestion'])
    expect(async_).toEqual(expect.arrayContaining(['Bash', 'Read', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'Skill', 'Glob', 'Grep', 'EnterPlanMode', 'Agent', 'EnterWorktree']))
    expect(async_).not.toContain('AskUserQuestion')
    expect(sync.filter(t => async_.includes(t))).toEqual([])
    const union = (isAsync: boolean): string[] => RAW.hooks.flatMap(h => { const b = binding(h, 'claude'); return b ? [b, ...(b.also ?? [])] : [] })
      .filter(b => b.event === 'classic.PostToolUse' && (b.async === true) === isAsync).flatMap(b => String(b.matcher ?? '').split('|'))
    expect(union(false).filter(t => union(true).includes(t))).toEqual([])
    expect(also.find(a => a.event === 'classic.PostToolUseFailure')).toEqual({ event: 'classic.PostToolUseFailure', matcher: 'Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep|Agent|Skill', async: true, timeoutMs: 5000 })
  })

  test('H28 project.assets: non-blocking, fails open, bound on all four harnesses at session start, after edits and at the end of a turn', () => {
    const h28 = RAW.hooks.find(h => h.id === 'H28') as HookSpec
    expect(h28).toMatchObject({ name: 'project.assets', blocking: 'none', failure: 'open', contract_test: 'tests/adapters/shared/project-assets.test.ts' })
    expect(BLOCKING_HOOKS).not.toContain('H28')
    const events = (harness: keyof HookSpec['bindings']): string[] => { const b = binding(h28, harness); return b ? [b.event, ...(b.also ?? []).map(a => a.event)] : [] }
    expect(events('claude')).toEqual(['classic.SessionStart', 'classic.PostToolUse', 'classic.Stop'])
    expect(events('codex')).toEqual(['SessionStart', 'PostToolUse', 'Stop'])
    expect(events('opencode')).toEqual(['session.context', 'setup', 'tool.execute.after', 'session.execution.succeeded'])
    expect(events('omp')).toEqual(['before_agent_start', 'session_start', 'tool_result', 'session_stop'])
    expect(binding(h28, 'claude')?.also?.[0]).toEqual({ event: 'classic.PostToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit', timeoutMs: 30000 })
    expect(binding(h28, 'codex')?.also?.[0]).toEqual({ event: 'PostToolUse', matcher: 'apply_patch', timeoutMs: 30000 })
  })

  test('adapter-reported corrections: Codex rollout telemetry, matcher-less SubagentStop, omp events', () => {
    const by = Object.fromEntries(RAW.hooks.map(h => [h.id, h])) as Record<string, HookSpec>
    const events = (id: string, harness: keyof HookSpec['bindings']) => {
      const b = binding(by[id] as HookSpec, harness)
      return b ? [b.event, ...(b.also ?? []).map(a => a.event)] : []
    }
    for (const id of ['H05', 'H18']) expect(events(id, 'codex').sort()).toEqual(['PostCompact', 'PostToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'])
    expect(binding(by['H19'] as HookSpec, 'codex')).toEqual({ event: 'SubagentStop', timeoutMs: 10000 })
    expect(binding(by['H14'] as HookSpec, 'codex')).toMatchObject({ event: 'Stop' })
    expect(binding(by['H14'] as HookSpec, 'codex')?.async).toBeUndefined()
    expect(binding(by['H14'] as HookSpec, 'codex')?.also).toContainEqual({ event: 'PostToolUse', matcher: '^(Bash|webrun|mcp__.+)$', async: true, timeoutMs: 15000 })
    expect(events('H15', 'omp')).toEqual(['before_agent_start'])
    expect(events('H07', 'omp')).toEqual(['session_compact'])
    expect(events('H14', 'omp')).toEqual(expect.arrayContaining(['session_stop', 'input', 'tool_result', 'turn_end']))
    expect(events('H14', 'opencode')).toEqual(['session.execution.succeeded', 'session.deleted', 'tool.execute.after'])
    expect(events('H16', 'opencode')).toEqual(['setup'])
    expect(binding(by['H19'] as HookSpec, 'claude')).toEqual({ event: 'classic.SubagentStop', timeoutMs: 10000, also: [{ event: 'classic.PreToolUse', matcher: 'SubagentHandback', timeoutMs: 10000 }] })
    expect(events('H14', 'claude')).toEqual(['classic.PostToolUse', 'classic.Stop', 'classic.PostCompact', 'classic.SessionEnd'])
    expect(binding(by['H14'] as HookSpec, 'claude')?.async).toBe(true)
    expect(by['H17']?.contract_test).toBe('tests/cli/ops/profile-guard.test.ts')
  })

  test('phase 2 bound what the adapters serve (each checked against the real binary by its owner)', () => {
    const by = Object.fromEntries(RAW.hooks.map(h => [h.id, h])) as Record<string, HookSpec>
    expect(by['H05']?.bindings.omp).toEqual({ event: 'turn_end' })
    expect([by['H17']?.bindings.opencode, by['H17']?.bindings.omp]).toEqual([{ event: 'setup', also: [{ event: 'session.context' }] }, { event: 'session_start' }])
    expect([by['H19']?.bindings.opencode, by['H19']?.bindings.omp]).toEqual([{ event: 'tool.execute.after', matcher: 'subagent' }, { event: 'tool_call', matcher: ['yield'] }])
    expect(by['H19']?.blocking).toBe('none')
    expect(by['H19']?.description).toContain('subagent tool')
    expect(by['H19']?.description).toContain('yield')
    expect(by['H21']?.bindings.claude).toEqual({ event: 'classic.SessionStart', timeoutMs: 10000, also: [{ event: 'classic.SubagentStart', timeoutMs: 5000 }] })
    expect(by['H21']?.bindings.opencode).toEqual({ event: 'setup', also: [{ event: 'session.created' }] })
  })

  test('codes the unsupported cells with a reason: none are left', () => {
    const unsupported = RAW.hooks.flatMap(h => HARNESSES.filter(x => { const b = h.bindings[x]; return b !== undefined && 'unsupported' in b }).map(x => `${h.id}/${x}`))
    expect(unsupported).toEqual([])
  })

  test('H12 plan.capture is bound on all four harnesses; OpenCode saves a draft only', () => {
    const h12 = RAW.hooks.find(h => h.id === 'H12') as HookSpec
    expect(h12).toMatchObject({ name: 'plan.capture', blocking: 'none', failure: 'open' })
    expect(binding(h12, 'claude')).toEqual({ event: 'classic.PostToolUse', matcher: 'ExitPlanMode', timeoutMs: 10000 })
    expect(binding(h12, 'codex')).toEqual({ event: 'Stop', timeoutMs: 15000, also: [{ event: 'UserPromptSubmit', timeoutMs: 5000 }] })
    expect(binding(h12, 'opencode')).toEqual({ event: 'session.context' })
    expect(binding(h12, 'omp')).toEqual({ event: 'before_agent_start', also: [{ event: 'tool_result' }] })
    expect(h12.description).toContain('draft (approved: false)')
    expect(h12.description).toContain('<proposed_plan>')
    expect(h12.description).toContain('plan.autosave')
  })

  test('contract tests owned by the policy task exist', () => {
    const ownedPrefixes = ['tests/core/policy/', 'tests/core/plan/', 'tests/core/compact/', 'tests/core/checkers/']
    const owned = RAW.hooks.filter(h => ownedPrefixes.some(p => h.contract_test.startsWith(p)))
    expect(owned.map(h => h.id)).toEqual(['H01', 'H02', 'H03', 'H04', 'H06', 'H07', 'H08', 'H09', 'H10', 'H11', 'H15', 'H19', 'H20', 'H22', 'H23', 'H24'])
    for (const h of owned) expect(existsSync(join(REPO, h.contract_test))).toBe(true)
  })

  const STILL_TO_WRITE: string[] = []
  test('contract tests of the other hooks exist', () => {
    const foreign = RAW.hooks.filter(h => !['tests/core/policy/', 'tests/core/plan/', 'tests/core/compact/', 'tests/core/checkers/'].some(p => h.contract_test.startsWith(p)))
    expect(foreign.map(h => h.id)).toEqual(['H05', 'H12', 'H13', 'H14', 'H16', 'H17', 'H18', 'H21', 'H25', 'H26', 'H27', 'H28'])
    for (const h of foreign.filter(x => !STILL_TO_WRITE.includes(x.id))) expect({ hook: h.id, file: h.contract_test, exists: existsSync(join(REPO, h.contract_test)) }).toEqual({ hook: h.id, file: h.contract_test, exists: true })
  })
  for (const h of RAW.hooks.filter(x => STILL_TO_WRITE.includes(x.id))) {
    if (existsSync(join(REPO, h.contract_test))) test(`${h.id} contract test exists: ${h.contract_test}`, () => expect(true).toBe(true))
    else test.todo(`${h.id} contract test still to be written by its owner: ${h.contract_test}`, () => undefined)
  }
})

describe('per-harness event lists', () => {
  test('sizes match the researched surfaces', () => {
    expect(CLAUDE_CLASSIC_EVENTS.length).toBe(33)
    expect(CLAUDE_ENGINE_EVENTS.length).toBe(46)
    expect(CODEX_EVENTS.length).toBe(12)
    expect(OMP_EVENTS.length).toBe(48)
    expect(new Set(OPENCODE_EVENTS).size).toBe(OPENCODE_EVENTS.length)
    for (const h of HARNESSES) expect(new Set(HOOK_EVENTS[h]).size).toBe(HOOK_EVENTS[h].length)
  })

  test('spot checks', () => {
    expect(HOOK_EVENTS.claude).toContain('classic.SubagentStop')
    expect(HOOK_EVENTS.claude).not.toContain('Stop')
    expect(HOOK_EVENTS.codex).toContain('Interrupt')
    expect(HOOK_EVENTS.codex).not.toContain('PostToolUseFailure')
    expect(HOOK_EVENTS.opencode).toContain('permission.evaluate')
    expect(HOOK_EVENTS.omp).toContain('session.compacting')
    expect(HOOK_EVENTS.omp).not.toContain('session_end')
  })
})

describe('validateHooksMatrix: negative cases', () => {
  const errs = (mutate: (m: HooksMatrix) => void): string => {
    const m = clone(RAW)
    mutate(m)
    return validateHooksMatrix(m).join('\n')
  }
  const hook = (m: HooksMatrix, id: string): HookSpec => m.hooks.find(h => h.id === id) as HookSpec

  test('a non-allowlisted hook may not block, and allowlisted hooks keep their kind', () => {
    expect(errs(m => { hook(m, 'H04').blocking = 'deny' })).toContain('only H01, H02, H03, H08, H09, H11, H20, H23 may block')
    expect(errs(m => { hook(m, 'H22').blocking = 'deny' })).toContain('only H01, H02, H03, H08, H09, H11, H20, H23 may block')
    expect(errs(m => { hook(m, 'H08').blocking = 'deny' })).toContain('expected stop')
    expect(errs(m => { hook(m, 'H23').blocking = 'deny' })).toContain('expected stop')
    expect(errs(m => { (hook(m, 'H23').bindings.codex as HookBinding).event = 'UserPromptSubmit' })).toContain('cannot keep a turn going')
  })

  test('unknown events, wrong matcher shapes and Codex matcher rules', () => {
    expect(errs(m => { (hook(m, 'H01').bindings.codex as HookBinding).event = 'BeforeTool' })).toContain('is not a codex event')
    expect(errs(m => { (hook(m, 'H01').bindings.claude as HookBinding).event = 'Stop' })).toContain('is not a claude event')
    expect(errs(m => { (hook(m, 'H01').bindings.claude as unknown as Record<string, unknown>)['matcher'] = { tool: 'Bash' } })).toContain('a Claude command hook matcher is a string')
    expect(errs(m => { (hook(m, 'H20').bindings.claude as unknown as { also: Array<Record<string, unknown>> }).also[1] = { event: 'tool.call', matcher: 'Bash' } })).toContain('partial objects')
    expect(errs(m => { (hook(m, 'H08').bindings.codex as HookBinding).matcher = 'x' })).toContain('Codex ignores matchers on Stop')
    expect(errs(m => { (hook(m, 'H14').bindings.codex as unknown as { also: HookBinding[] }).also = [{ event: 'SessionEnd', timeoutMs: 9000 }] })).toContain('at most 3000')
  })

  test('blocking hooks must use a blocking event and cannot be async', () => {
    expect(errs(m => { (hook(m, 'H01').bindings.codex as HookBinding).event = 'PostToolUse' })).toContain('cannot deny a tool call')
    expect(errs(m => { (hook(m, 'H08').bindings.omp as HookBinding).event = 'turn_end' })).toContain('cannot keep a turn going')
    expect(errs(m => { (hook(m, 'H02').bindings.omp as HookBinding).async = true })).toContain('cannot be async')
  })

  test('structure: ids, missing harnesses, unknown keys, contract tests, fallbacks', () => {
    expect(errs(m => { m.hooks.pop() })).toContain('expected exactly H01')
    expect(errs(m => { delete hook(m, 'H05').bindings.opencode })).toContain('missing')
    expect(errs(m => { (hook(m, 'H05') as unknown as Record<string, unknown>)['priority'] = 1 })).toContain('unknown key')
    expect(errs(m => { hook(m, 'H05').contract_test = 'src/x.ts' })).toContain('contract_test')
    expect(errs(m => { hook(m, 'H05').bindings.codex = { unsupported: 'no' } })).toContain('give the reason')
    expect(errs(m => { (hook(m, 'H01').bindings.codex as unknown as Record<string, unknown>)['fallback'] = { event: 'Stop' } })).toContain('only Claude')
    expect(errs(m => { (hook(m, 'H08').bindings.claude as unknown as Record<string, unknown>)['fallback'] = { event: 'tool.call' } })).toContain('classic hook event')
    expect(errs(m => { (hook(m, 'H08').bindings.claude as unknown as Record<string, unknown>)['fallback'] = [] })).toContain('non-empty list')
    expect(errs(m => { (hook(m, 'H08').bindings.claude as unknown as Record<string, unknown>)['fallback'] = [{ event: 'Stop' }, { event: 'Nope' }] })).toContain('fallback[1].event')
    expect(errs(m => { (hook(m, 'H08').bindings.claude as unknown as Record<string, unknown>)['fallback'] = [{ event: 'Stop' }, { event: 'Stop' }] })).toContain('duplicate fallback Stop')
    expect(errs(m => { (hook(m, 'H14').bindings.claude as unknown as { also: Array<Record<string, unknown>> }).also[0] = { event: 'classic.Stop', fallback: { event: 'Stop' } } })).toContain('only Claude bindings have a classic fallback')
    expect(validateHooksMatrix(null)).toEqual(['(root): expected { hooks: [...] }'])
  })
})
