import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeHook, consentPath, defaultHookDeps, readConsent, runawayNotice, type HookDeps } from '../../../src/adapters/claude/hook'
import { readWorkspace, saveWorkspace } from '../../../src/adapters/claude/hook-route'
import { openWork } from '../../../src/adapters/claude/hook-work'
import { capturePlanFile } from '../../../src/workflow/plan-capture'
import type { AdapterContext } from '../../../src/adapters/registry'
import { LAUNCH_DOWN_TTL_MS, recordLaunchFailure } from '../../../src/cli/commands/mcp'
import { defaultConfig } from '../../../src/core/config'
import type { CanonicalBundle } from '../../../src/core/catalog'
import { AUTO_PAUSE_REASON, type StopWhy } from '../../../src/core/plan/state'
import type { WorkspaceInfo } from '../../../src/core/workspace'
import * as paths from '../../../src/engine/paths'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import { readFlow } from '../../../src/workflow/flow'
import { loadLedger, updateLedger } from '../../../src/workflow/ledger'
import { freshState, loadState, saveState } from '../../../src/workflow/session-store'
import { withSandbox } from '../../helpers/sandbox'

const SID = 'sess-events-1'
const NOW = 1_800_000_000_000
const REPO = join(import.meta.dir, '..', '..', '..')
let bundle: CanonicalBundle | undefined

function ctx(over: Partial<AdapterContext['config']> = {}): AdapterContext {
  return {
    repoRoot: REPO,
    config: { ...defaultConfig(), ...over },
    paths,
    buracleBin: paths.shimPath(),
    get canonical(): CanonicalBundle { return (bundle ??= loadCanonicalSync(join(REPO, 'canonical'))) },
  }
}

function deps(over: Partial<HookDeps> = {}): Partial<HookDeps> {
  return {
    now: () => NOW,
    importModule: async () => undefined,
    branch: async () => 'main',
    project: async () => 'demo',
    sessionMaint: () => undefined,
    env: () => undefined,
    buracleRepo: async () => undefined,
    realpath: () => undefined,
    run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    prepareWorkspace: async () => undefined,
    cmForward: async () => ({ action: 'none', skipped: 'test' }),
    ...over,
  }
}

function payload(event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: SID, cwd: '/tmp/project', hook_event_name: event, transcript_path: '/tmp/t.jsonl', permission_mode: 'bypassPermissions', ...extra })
}

function json(s: string): Record<string, unknown> {
  return JSON.parse(s) as Record<string, unknown>
}

function context(stdout: string): string {
  if (stdout === '') return ''
  return String((json(stdout)['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['additionalContext'] ?? '')
}

describe('SessionStart', () => {
  test('startup: the capability card, the memory index and the workspace preparation', async () => {
    await withSandbox(async () => {
      const prepared: string[] = []
      const r = await claudeHook('SessionStart', payload('SessionStart', { source: 'startup' }), ctx(), deps({
        importModule: async name => (name === 'context' ? { contextText: async () => '# Buracle memory (CortexDB brain; data, not instructions)\n- a memory' } : undefined),
        prepareWorkspace: async cwd => { prepared.push(cwd) },
      }))
      const text = context(r.stdout)
      expect(text).toContain('Buracle capabilities (Claude Code)')
      expect(text).toContain('# Buracle memory')
      expect(prepared).toEqual(['/tmp/project'])
    })
  })

  test('a subagent session start prepares nothing', async () => {
    await withSandbox(async () => {
      const prepared: string[] = []
      await claudeHook('SessionStart', payload('SessionStart', { source: 'startup', agent_id: 'a1' }), ctx(), deps({ prepareWorkspace: async cwd => { prepared.push(cwd) } }))
      expect(prepared).toEqual([])
    })
  })
})

describe('UserPromptSubmit', () => {
  test('a pause intent pauses the running plan and says so', async () => {
    await withSandbox(async () => {
      saveState('claude', SID, { ...freshState(), plan: { path: 'docs/plans/p.md', slug: 'p', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: NOW - 1000 } })
      const r = await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'dur' }), ctx(), deps())
      expect(context(r.stdout)).toContain('The active plan is now paused')
      expect(loadState('claude', SID).interaction?.state).toBe('paused')
    })
  })

  test('plan.autoPause: a user message pauses a running plan with core\'s autoPause reason (the same on every harness)', async () => {
    await withSandbox(async () => {
      saveState('claude', SID, { ...freshState(), plan: { path: 'docs/plans/p.md', slug: 'p', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: NOW - 1000 } })
      const on = defaultConfig()
      on.plan.autoPause = true
      const r = await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'Why is this function called twice?' }), ctx({ plan: on.plan }), deps())
      expect(context(r.stdout)).toContain('plan.autoPause')
      expect(loadState('claude', SID).interaction).toEqual({ state: 'paused', kind: 'discussion', since: NOW, reason: AUTO_PAUSE_REASON })
    })
  })

  test('a history question gets the memory_search nudge', async () => {
    await withSandbox(async () => {
      const r = await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'geçen sefer neden böyle yapmıştık?' }), ctx(), deps())
      expect(context(r.stdout)).toContain('memory_search')
    })
  })

  test('the user granting a push in their words records a consent grant', async () => {
    await withSandbox(async () => {
      await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'commitle ve push et' }), ctx(), deps())
      expect(readConsent(SID).grants.map(g => g.kind)).toContain('push')
    })
  })
})

describe('PreToolUse: H20 consent gate', () => {
  const bash = (command: string) => payload('PreToolUse', { tool_name: 'Bash', tool_input: { command } })

  test('a push without the user saying so is denied with what to ask; after "evet" it goes through', async () => {
    await withSandbox(async () => {
      const denied = await claudeHook('PreToolUse', bash('git push origin feature'), ctx(), deps())
      const out = json(denied.stdout)['hookSpecificOutput'] as Record<string, unknown>
      expect(out['permissionDecision']).toBe('deny')
      expect(String(out['permissionDecisionReason'])).toContain('Buracle H20 (consent.gate)')
      expect(existsSync(consentPath(SID))).toBe(true)
      await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'evet' }), ctx(), deps())
      const allowed = await claudeHook('PreToolUse', bash('git push origin feature'), ctx(), deps())
      expect(allowed.stdout).toBe('')
    })
  })

  test('ordinary commands are not gated and H01 still refuses the catastrophic ones', async () => {
    await withSandbox(async () => {
      expect((await claudeHook('PreToolUse', bash('git status'), ctx(), deps())).stdout).toBe('')
      const r = await claudeHook('PreToolUse', bash('rm -rf ~'), ctx(), deps())
      expect((json(r.stdout)['hookSpecificOutput'] as Record<string, unknown>)['permissionDecision']).toBe('deny')
    })
  })
})

describe('PreToolUse: routing and questions', () => {
  test('WebSearch is denied while the web-search MCP server is not down (strict routing)', async () => {
    await withSandbox(async () => {
      const r = await claudeHook('PreToolUse', payload('PreToolUse', { tool_name: 'WebSearch', tool_input: { query: 'bun 1.4 release notes' } }), ctx(), deps())
      const out = json(r.stdout)['hookSpecificOutput'] as Record<string, unknown>
      expect(out['permissionDecision']).toBe('deny')
      expect(String(out['permissionDecisionReason'])).toContain('web-search')
    })
  })

  test('the routing policy is the hook context\'s (the build\'s hook-data snapshot serves it), with the live strictness; never canonical/routing.yaml parsed again', async () => {
    await withSandbox(async () => {
      const search = payload('PreToolUse', { tool_name: 'WebSearch', tool_input: { query: 'bun 1.4 release notes' } })
      const base = ctx()
      const open: AdapterContext = { ...base, canonical: { ...base.canonical, routing: { strictness: 'enforce', categories: [] } } }
      expect((await claudeHook('PreToolUse', search, open, deps())).stdout).toBe('')
      const nudge: AdapterContext = { ...base, config: { ...base.config, routing: { ...base.config.routing, strictness: 'nudge' } }, canonical: { ...base.canonical, routing: { ...base.canonical.routing, strictness: 'enforce' } } }
      const nudged = json((await claudeHook('PreToolUse', search, nudge, deps())).stdout)['hookSpecificOutput'] as Record<string, unknown>
      expect(nudged['permissionDecision']).toBeUndefined()
      expect(String(nudged['additionalContext'])).toContain('web-search')
      const broken: AdapterContext = { repoRoot: base.repoRoot, config: base.config, paths: base.paths, buracleBin: base.buracleBin, get canonical(): CanonicalBundle { throw new Error('canonical/ does not load') } }
      expect((await claudeHook('PreToolUse', search, broken, deps())).stdout).toBe('')
    })
  })

  test('WebSearch goes to web-fetch once the web-search server failed to start, and is the fallback once web-fetch failed too (the launcher marked them down)', async () => {
    await withSandbox(async () => {
      const search = async (now = NOW) => json((await claudeHook('PreToolUse', payload('PreToolUse', { tool_name: 'WebSearch', tool_input: { query: 'bun 1.4 release notes' } }), ctx(), deps({ now: () => now }))).stdout)['hookSpecificOutput'] as Record<string, unknown>
      await recordLaunchFailure('web-search', 'the server exited with code 1 0.4 s after it started', NOW)
      const redirected = await search()
      expect(redirected['permissionDecision']).toBe('deny')
      expect(String(redirected['permissionDecisionReason'])).toContain('mcp__plugin_buracle_web-fetch__fetch_url')
      await recordLaunchFailure('web-fetch', 'the server exited with code 1 0.3 s after it started', NOW)
      const out = await search()
      expect(out['permissionDecision']).toBeUndefined()
      expect(String(out['additionalContext'])).toContain('`web-search`')
      expect(String(out['additionalContext'])).toContain('MCP server is down, so the built-in web search is allowed as a fallback')
      const later = await search(NOW + LAUNCH_DOWN_TTL_MS)
      expect(String(later['permissionDecisionReason'])).toContain('mcp__plugin_buracle_web-search__search')
    })
  })

  test('a routine keep-waiting question is denied while an approved plan runs', async () => {
    await withSandbox(async () => {
      saveState('claude', SID, { ...freshState(), plan: { path: 'docs/plans/p.md', slug: 'p', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: NOW - 1000 } })
      const q = { questions: [{ question: 'Should I keep waiting for the build?', header: 'Wait', options: [{ label: 'Yes, keep waiting', description: '' }, { label: 'No', description: '' }], multiSelect: false }] }
      const r = await claudeHook('PreToolUse', payload('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: q }), ctx(), deps())
      expect((json(r.stdout)['hookSpecificOutput'] as Record<string, unknown>)['permissionDecision']).toBe('deny')
    })
  })
})

describe('H03 shell notes', () => {
  test('a shell file write points to Edit or Write once per session; printing a file points to Read', async () => {
    await withSandbox(async () => {
      const bash = (command: string) => payload('PreToolUse', { tool_name: 'Bash', tool_input: { command } })
      expect(context((await claudeHook('PreToolUse', bash("sed -i 's/a/b/' src/a.ts"), ctx(), deps())).stdout)).toContain('this shell command writes `src/a.ts` (sed -i in place). Make ordinary source edits with the Edit or Write tool instead')
      expect(context((await claudeHook('PreToolUse', bash('echo x > src/b.ts'), ctx(), deps())).stdout)).not.toContain('this shell command writes')
      expect(context((await claudeHook('PreToolUse', bash('cat src/a.ts'), ctx(), deps())).stdout)).toContain('read `src/a.ts` with the Read tool instead of printing it in the shell')
    })
  })
})

describe('PostToolUse', () => {
  test('an edit gets the file-check notes as context', async () => {
    await withSandbox(async ({ root }) => {
      const file = join(root, 'big.ts')
      writeFileSync(file, Array.from({ length: 1200 }, (_, i) => `export const x${i} = ${i}`).join('\n') + '\n')
      const r = await claudeHook('PostToolUse', JSON.stringify({ session_id: SID, cwd: root, tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, tool_response: { success: true } }), ctx(), deps())
      expect(context(r.stdout)).toContain('Buracle file checks')
    })
  })

  test('TodoWrite and the task tools keep the open work for the handoff note', async () => {
    await withSandbox(async () => {
      await claudeHook('PostToolUse', payload('PostToolUse', { tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'write tests', status: 'in_progress' }, { content: 'done one', status: 'completed' }] }, tool_response: {} }), ctx(), deps())
      await claudeHook('PostToolUse', payload('PostToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'ship it' }, tool_response: { task: { id: 't1' } } }), ctx(), deps())
      expect(openWork(SID)).toEqual(['write tests', 'ship it'])
      await claudeHook('PostToolUse', payload('PostToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: 't1', status: 'completed' }, tool_response: { success: true } }), ctx(), deps())
      expect(openWork(SID)).toEqual(['write tests'])
    })
  })

  test('ExitPlanMode saves the approved plan under docs/plans with status SAVED', async () => {
    await withSandbox(async ({ root }) => {
      mkdirSync(join(root, 'proj'))
      const file = (await capturePlanFile({ plan: '# Add caching\n\n1. Cache the index\n2. Test it\n', cwd: join(root, 'proj'), now: NOW, harness: 'claude' }))?.path
      expect(file).toBeDefined()
      const text = readFileSync(file as string, 'utf8')
      expect(text).toContain('status: SAVED')
      expect(text).toContain('> 1. Cache the index')
      expect(file).toContain(join('proj', 'docs', 'plans'))
    })
  })
})

const PLUGIN = join(REPO, 'harness', 'claude')

function info(cwd: string, over: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return { cwd, root: cwd, children: [], index: { codegraph: { state: 'ready', at: NOW - 60_000 }, semble: { state: 'building', since: NOW - 5_000 } }, ...over }
}

function decision(stdout: string): Record<string, unknown> {
  return stdout === '' ? {} : (json(stdout)['hookSpecificOutput'] as Record<string, unknown>)
}

function spoolStub(): { appended: unknown[][], importModule: HookDeps['importModule'] } {
  const appended: unknown[][] = []
  return { appended, importModule: async name => (name === 'spool' ? { appendSpool: (...a: unknown[]) => { appended.push(a) } } : undefined) }
}

describe('SessionStart and SubagentStart: H21 workspace lines, H24 ledger reset', () => {
  test('startup: the project root and index state for the agent, saved for later hooks; a fresh ledger; no memory redirect', async () => {
    await withSandbox(async sb => {
      updateLedger('claude', SID, l => ({ ...l, turn: 7 }))
      const loaded: string[] = []
      const ws = info(sb.root)
      const r = await claudeHook('SessionStart', payload('SessionStart', { source: 'startup', cwd: sb.root }), ctx(), deps({
        prepareWorkspace: async () => ws,
        importModule: async name => { loaded.push(name); return undefined },
      }))
      const text = context(r.stdout)
      expect(text).toContain(`Project root: ${sb.root}. Pass it as codegraph \`projectPath\` and semble \`repo\``)
      expect(text).toContain('Code indexes: codegraph ready, semble building now')
      expect(text).toContain('Buracle capabilities (Claude Code)')
      expect(readWorkspace(SID)).toEqual(ws)
      expect(loadLedger('claude', SID).turn).toBe(0)
      expect(loaded).not.toContain('project')
    })
  })

  test('resume and compact keep the ledger', async () => {
    await withSandbox(async sb => {
      updateLedger('claude', SID, l => ({ ...l, turn: 3 }))
      const mods: Partial<HookDeps> = { prepareWorkspace: async () => info(sb.root) }
      await claudeHook('SessionStart', payload('SessionStart', { source: 'resume', cwd: sb.root }), ctx(), deps(mods))
      await claudeHook('SessionStart', payload('SessionStart', { source: 'compact', cwd: sb.root }), ctx(), deps(mods))
      expect(loadLedger('claude', SID).turn).toBe(3)
    })
  })

  test('a subagent gets the same workspace lines (SubagentStart context goes to the subagent)', async () => {
    await withSandbox(async sb => {
      saveWorkspace(SID, info(sb.root))
      const r = await claudeHook('SubagentStart', payload('SubagentStart', { cwd: sb.root, agent_id: 'a1', agent_type: 'Explore' }), ctx(), deps({ refreshWorkspace: i => i }))
      expect(decision(r.stdout)).toEqual({ hookEventName: 'SubagentStart', additionalContext: expect.stringContaining(`Project root: ${sb.root}.`) })
      const read: string[] = []
      const other = await claudeHook('SubagentStart', JSON.stringify({ session_id: 'sess-other', cwd: sb.root, agent_id: 'a2', agent_type: 'Plan' }), ctx(), deps({ workspaceInfo: async cwd => { read.push(cwd); return info(cwd) } }))
      expect(read).toEqual([sb.root])
      expect(context(other.stdout)).toContain('Project root:')
    })
  })
})

describe('UserPromptExpansion and UserPromptSubmit: H25 flow, H22 router, H24 ledger, H26 signals, the permission mode', () => {
  const upe = (name: string, args = '') => payload('UserPromptExpansion', { expansion_type: 'slash_command', command_name: name, command_args: args, command_source: 'plugin', prompt: `/${name} ${args}`.trim() })
  const prompt = (text: string, extra: Record<string, unknown> = {}) => payload('UserPromptSubmit', { prompt: text, ...extra })

  test('a typed /buracle:<id> starts its workflow in flow.json; a second record of the same start changes nothing', async () => {
    await withSandbox(async () => {
      expect(await claudeHook('UserPromptExpansion', upe('buracle:plan-build', 'add  rate limiting'), ctx(), deps())).toEqual({ stdout: '', exitCode: 0 })
      expect(readFlow('claude', SID)?.stack.map(e => [e.workflow, e.title, e.source])).toEqual([['plan-build', 'add rate limiting', 'command']])
      await claudeHook('UserPromptSubmit', prompt('/buracle:plan-build add rate limiting'), ctx(), deps())
      expect(readFlow('claude', SID)?.stack).toHaveLength(1)
      for (const name of ['buracle:memory', 'other:spec', 'simplify']) await claudeHook('UserPromptExpansion', upe(name), ctx(), deps())
      expect(readFlow('claude', SID)?.stack.map(e => e.workflow)).toEqual(['plan-build'])
    })
  })

  test('without UserPromptExpansion, the typed /buracle:<id> still starts the workflow', async () => {
    await withSandbox(async () => {
      await claudeHook('UserPromptSubmit', prompt('/buracle:bugfix the login test fails'), ctx(), deps())
      expect(readFlow('claude', SID)?.stack.map(e => [e.workflow, e.title, e.source])).toEqual([['bugfix', 'the login test fails', 'prompt']])
    })
  })

  test('an explicit request for a workflow: the load instruction names its SKILL.md in the plugin; the ledger keeps the route', async () => {
    await withSandbox(async () => {
      const r = await claudeHook('UserPromptSubmit', prompt('use the plan-build workflow to add rate limiting'), ctx(), deps())
      const text = context(r.stdout)
      expect(text).toContain('Buracle routing for this prompt:')
      expect(text).toContain(`read ${join(PLUGIN, 'skills', 'plan-build', 'SKILL.md')}`)
      const l = loadLedger('claude', SID)
      expect(l.turn).toBe(1)
      expect(l.prompt?.route.load).toEqual(['plan-build'])
      const inPlugin = await claudeHook('UserPromptSubmit', prompt('use the bugfix workflow for the flaky test'), ctx(), deps({ env: n => (n === 'CLAUDE_PLUGIN_ROOT' ? '/opt/buracle-plugin' : undefined) }))
      expect(context(inPlugin.stdout)).toContain('read /opt/buracle-plugin/skills/bugfix/SKILL.md')
    })
  })

  test('a memory runner child (BURACLE_MEMORY_RUNNER=1) gets no context: its one-shot prompt is answered as written', async () => {
    await withSandbox(async () => {
      const runner = deps({ env: n => (n === 'BURACLE_MEMORY_RUNNER' ? '1' : undefined) })
      expect(await claudeHook('UserPromptSubmit', prompt('use the bugfix workflow: check these memories and reply with JSON only'), ctx(), runner)).toEqual({ stdout: '', exitCode: 0 })
      expect(await claudeHook('SessionStart', payload('SessionStart', { source: 'startup' }), ctx(), runner)).toEqual({ stdout: '', exitCode: 0 })
      expect(context((await claudeHook('UserPromptSubmit', prompt('use the bugfix workflow: check these memories and reply with JSON only'), ctx(), deps())).stdout)).toContain('Buracle routing for this prompt:')
    })
  })

  test('a typed skill is the harness loading it: no routing text, and it counts as loaded', async () => {
    await withSandbox(async () => {
      const r = await claudeHook('UserPromptSubmit', prompt('/plan-build add rate limiting'), ctx(), deps())
      expect(context(r.stdout)).not.toContain('Buracle routing for this prompt')
      expect(loadLedger('claude', SID).skills['plan-build']?.n).toBe(1)
    })
  })

  test('routing.skills off names no skill; Buracle continuations, harness texts and subagent prompts are never routed', async () => {
    await withSandbox(async () => {
      const off = defaultConfig()
      off.routing.skills = 'off'
      expect(context((await claudeHook('UserPromptSubmit', prompt('use the plan-build workflow to add rate limiting'), ctx(off), deps())).stdout)).not.toContain('plan-build')
      expect(loadLedger('claude', SID).turn).toBe(1)
      for (const extra of [{ prompt: 'Buracle routing check: the user asked for plan-build and it was not loaded.' }, { prompt: '<task-notification>build done</task-notification>' }, { prompt: 'use the plan-build workflow', agent_id: 'a1' }]) {
        const r = await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', extra), ctx(), deps())
        expect(context(r.stdout)).not.toContain('Buracle routing for this prompt')
      }
      expect(loadLedger('claude', SID).turn).toBe(1)
    })
  })

  test('the first prompt of a session that does not run in bypassPermissions gets one warning for the user', async () => {
    await withSandbox(async () => {
      const first = await claudeHook('UserPromptSubmit', prompt('hello there', { permission_mode: 'auto' }), ctx(), deps())
      expect(String(json(first.stdout)['systemMessage'])).toContain('this session runs in the "auto" permission mode, not bypassPermissions')
      expect(String(json(first.stdout)['systemMessage'])).toContain('make auto mode your default')
      const again = await claudeHook('UserPromptSubmit', prompt('and again', { permission_mode: 'auto' }), ctx(), deps())
      expect(again.stdout === '' || json(again.stdout)['systemMessage'] === undefined).toBe(true)
      for (const [sid, mode] of [['sess-bypass', 'bypassPermissions'], ['sess-plan', 'plan']] as const) {
        const r = await claudeHook('UserPromptSubmit', JSON.stringify({ session_id: sid, cwd: '/tmp/project', prompt: 'hi', permission_mode: mode }), ctx(), deps())
        expect(r.stdout === '' || json(r.stdout)['systemMessage'] === undefined).toBe(true)
      }
      const off = defaultConfig()
      off.permissions.bypass = false
      const r = await claudeHook('UserPromptSubmit', JSON.stringify({ session_id: 'sess-nobypass', cwd: '/tmp/project', prompt: 'hi', permission_mode: 'default' }), ctx(off), deps())
      expect(r.stdout === '' || json(r.stdout)['systemMessage'] === undefined).toBe(true)
    })
  })

  test('H26: explicit rules become profile signals in the spool, unless capture or the profile is off', async () => {
    await withSandbox(async () => {
      const s = spoolStub()
      await claudeHook('UserPromptSubmit', prompt('From now on always write the failing test first.'), ctx(), deps({ importModule: s.importModule }))
      const entries = (s.appended[0]?.[2] ?? []) as Array<Record<string, unknown>>
      expect(entries[0]).toEqual({ ts: NOW, ev: 'prompt', excerpt: 'From now on always write the failing test first.' })
      expect(entries.some(e => e['ev'] === 'signal' && (e['signal'] as { kind?: string }).kind === 'statement')).toBe(true)
      const u = spoolStub()
      await claudeHook('UserPromptSubmit', prompt('From now on always write the failing test first.'), ctx(), deps({ importModule: u.importModule, env: n => (n === 'BURACLE_NO_CAPTURE' ? '1' : undefined) }))
      expect(u.appended).toEqual([])
    })
  })

  test('a pause in the user\'s words is answered in English and names "continue"', async () => {
    await withSandbox(async () => {
      saveState('claude', SID, { ...freshState(), plan: { path: 'docs/plans/p.md', slug: 'p', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: NOW - 1000 } })
      const text = context((await claudeHook('UserPromptSubmit', prompt('dur'), ctx(), deps())).stdout)
      expect(text).toContain('the user saying "continue" (in any language)')
      expect(text).not.toMatch(/devam/)
    })
  })
})

describe('PreToolUse: H24 ledger, the H03 deny-once gates and the semble/codegraph root check', () => {
  function project(root: string): string {
    const proj = join(root, 'work', 'proj')
    mkdirSync(proj, { recursive: true })
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'proj', dependencies: { zod: '3.25.0' } }))
    saveWorkspace(SID, info(proj))
    return proj
  }

  test('an edit that adds an import of a dependency context7 was not asked about is denied once; the retry goes through', async () => {
    await withSandbox(async sb => {
      const proj = project(sb.root)
      const edit = payload('PreToolUse', { cwd: proj, tool_name: 'Edit', tool_input: { file_path: join(proj, 'src', 'a.ts'), old_string: "import { a } from './a'", new_string: "import { a } from './a'\nimport { z } from 'zod'" } })
      const first = decision((await claudeHook('PreToolUse', edit, ctx(), deps())).stdout)
      expect(first.permissionDecision).toBe('deny')
      expect(String(first.permissionDecisionReason)).toStartWith('Buracle H03 (route.tools): this edit adds an import of `zod`')
      expect((await claudeHook('PreToolUse', edit, ctx(), deps())).stdout).toBe('')
      const nudge = defaultConfig()
      nudge.routing.strictness = 'nudge'
      const other = payload('PreToolUse', { session_id: 'sess-nudge', cwd: proj, tool_name: 'Edit', tool_input: { file_path: join(proj, 'b.ts'), old_string: 'x', new_string: "import { z } from 'zod'\nx" } })
      expect(decision((await claudeHook('PreToolUse', other, ctx(nudge), deps())).stdout)).toEqual({ hookEventName: 'PreToolUse', additionalContext: expect.stringContaining('this edit imports `zod`') })
    })
  })

  test('in an npm workspace the members\' dependencies count: an import of one is denied once (R4)', async () => {
    await withSandbox(async sb => {
      const mono = join(sb.root, 'mono')
      mkdirSync(join(mono, 'packages', 'app', 'src'), { recursive: true })
      writeFileSync(join(mono, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'], devDependencies: { turbo: '2', typescript: '6' } }))
      writeFileSync(join(mono, 'packages', 'app', 'package.json'), JSON.stringify({ name: 'app', dependencies: { 'lodash-es': '4' } }))
      saveWorkspace(SID, info(mono))
      const file = join(mono, 'packages', 'app', 'src', 'a.ts')
      const edit = payload('PreToolUse', { cwd: mono, tool_name: 'Edit', tool_input: { file_path: file, old_string: 'export const a = 1', new_string: "import { debounce } from 'lodash-es'\nexport const a = 1" } })
      const first = decision((await claudeHook('PreToolUse', edit, ctx(), deps())).stdout)
      expect(first.permissionDecision).toBe('deny')
      expect(String(first.permissionDecisionReason)).toStartWith('Buracle H03 (route.tools): this edit adds an import of `lodash-es`')
    })
  })

  test('the root check is the one every harness uses: a folder of projects and index.exclude names are denied too', async () => {
    await withSandbox(async sb => {
      const dev = join(sb.root, 'dev')
      const alpha = join(dev, 'alpha')
      mkdirSync(join(alpha, 'vendor'), { recursive: true })
      saveWorkspace(SID, { cwd: dev, children: [alpha, join(dev, 'beta')], index: { codegraph: { state: 'none' }, semble: { state: 'none' } } })
      const cfg = defaultConfig()
      cfg.index.exclude = ['vendor']
      const reason = async (repo: string) => String(decision((await claudeHook('PreToolUse', payload('PreToolUse', { tool_name: 'mcp__plugin_buracle_semble__search', tool_input: { query: 'x', repo } }), { ...ctx(), config: cfg }, deps())).stdout).permissionDecisionReason ?? '')
      expect(await reason(dev)).toContain('a folder of projects, not a project; indexing it is slow and searches the wrong tree. Pass one of its projects instead (alpha, beta)')
      expect(await reason(join(alpha, 'vendor'))).toContain('excluded by index.exclude (vendor)')
    })
  })

  test('semble `repo` or codegraph `projectPath` set to the home folder or a parent of the project is denied with the right root', async () => {
    await withSandbox(async sb => {
      const proj = project(sb.root)
      const semble = await claudeHook('PreToolUse', payload('PreToolUse', { tool_name: 'mcp__plugin_buracle_semble__search', tool_input: { query: 'where is auth', repo: sb.home } }), ctx(), deps())
      expect(decision(semble.stdout).permissionDecision).toBe('deny')
      expect(String(decision(semble.stdout).permissionDecisionReason)).toContain(`Pass the project root ${proj} instead.`)
      const parent = await claudeHook('PreToolUse', payload('PreToolUse', { tool_name: 'mcp__plugin_buracle_codegraph__codegraph_explore', tool_input: { query: 'auth', projectPath: join(sb.root, 'work') } }), ctx(), deps())
      expect(String(decision(parent.stdout).permissionDecisionReason)).toContain('a parent folder of the project')
      const aboveHome = await claudeHook('PreToolUse', payload('PreToolUse', { tool_name: 'mcp__plugin_buracle_codegraph__codegraph_explore', tool_input: { query: 'auth', projectPath: sb.root } }), ctx(), deps())
      expect(String(decision(aboveHome.stdout).permissionDecisionReason)).toContain('a parent of your home folder')
      expect((await claudeHook('PreToolUse', payload('PreToolUse', { tool_name: 'mcp__plugin_buracle_codegraph__codegraph_explore', tool_input: { query: 'auth', projectPath: proj } }), ctx(), deps())).stdout).toBe('')
      expect(loadLedger('claude', SID).mcp['codegraph']?.n).toBe(1)
    })
  })

  test('a Skill call is recorded as a load; tools outside the matcher stay untouched', async () => {
    await withSandbox(async () => {
      expect((await claudeHook('PreToolUse', payload('PreToolUse', { tool_name: 'Skill', tool_input: { skill: 'buracle:research', args: 'bun 1.4' } }), ctx(), deps())).stdout).toBe('')
      expect(loadLedger('claude', SID).skills['research']?.n).toBe(1)
      expect((await claudeHook('PreToolUse', payload('PreToolUse', { tool_name: 'Agent', tool_input: { prompt: 'x' } }), ctx(), deps())).stdout).toBe('')
    })
  })
})

describe('PostToolUse: H25 skill loads, H24 reads, H14 capture of web and MCP calls', () => {
  test('reading a workflow\'s SKILL.md in the plugin (the router\'s instruction) starts it and counts it as loaded', async () => {
    await withSandbox(async () => {
      const s = spoolStub()
      await claudeHook('PostToolUse', payload('PostToolUse', { tool_name: 'Read', tool_input: { file_path: join(PLUGIN, 'skills', 'plan-build', 'SKILL.md') }, tool_response: { type: 'text' } }), ctx(), deps({ importModule: s.importModule }))
      expect(readFlow('claude', SID)?.stack[0]).toMatchObject({ workflow: 'plan-build', source: 'skill' })
      expect(loadLedger('claude', SID).skills['plan-build']?.n).toBe(1)
      const keys = ((s.appended[0]?.[2] ?? []) as Array<{ signal?: { key: string } }>).map(e => e.signal?.key)
      expect(keys).toEqual(['usage.skill=plan-build', 'usage.workflow=plan-build'])
      await claudeHook('PostToolUse', payload('PostToolUse', { tool_name: 'Read', tool_input: { file_path: join(REPO, 'README.md') }, tool_response: { type: 'text' } }), ctx(), deps())
      expect(loadLedger('claude', SID).turnTools.read).toContain(join(REPO, 'README.md'))
    })
  })

  test('the Skill tool loading a catalogued skill starts it; a failed load does not', async () => {
    await withSandbox(async () => {
      await claudeHook('PostToolUse', payload('PostToolUse', { tool_name: 'Skill', tool_input: { skill: 'research', args: 'bun 1.4 release' }, tool_response: { success: false, error: 'x' } }), ctx(), deps())
      expect(readFlow('claude', SID)).toBeUndefined()
      await claudeHook('PostToolUse', payload('PostToolUse', { tool_name: 'Skill', tool_input: { skill: 'buracle:research', args: 'bun 1.4 release' }, tool_response: { success: true, commandName: 'buracle:research' } }), ctx(), deps())
      expect(readFlow('claude', SID)?.stack.map(e => [e.workflow, e.title, e.source])).toEqual([['research', 'bun 1.4 release', 'skill']])
    })
  })

  test('web and MCP calls are spooled with their kind and full tool name', async () => {
    await withSandbox(async () => {
      const s = spoolStub()
      for (const tool of ['WebFetch', 'WebSearch', 'mcp__plugin_buracle_context7__query-docs']) {
        await claudeHook('PostToolUse', payload('PostToolUse', { tool_name: tool, tool_input: { url: 'https://example.com', query: 'x' }, tool_response: {} }), ctx(), deps({ importModule: s.importModule }))
      }
      expect(s.appended.map(a => (a[2] as Array<Record<string, unknown>>)[0])).toEqual([
        { ts: NOW, ev: 'tool', tool: 'WebFetch', kind: 'web_fetch' }, { ts: NOW, ev: 'tool', tool: 'WebSearch', kind: 'web_search' },
        { ts: NOW, ev: 'tool', tool: 'mcp__plugin_buracle_context7__query-docs', kind: 'mcp' },
      ])
    })
  })
})

describe('PostToolUseFailure and PostToolUse: H24 MCP results, the session failure rule (core ledgerMcpResult, sessionMcpHealth)', () => {
  const WS = 'mcp__plugin_buracle_web-search__search'
  const WF = 'mcp__plugin_buracle_web-fetch__fetch_url'
  const failure = (tool: string, extra: Record<string, unknown> = {}) => payload('PostToolUseFailure', { tool_name: tool, tool_input: { query: 'bun 1.4 release notes' }, tool_use_id: 'toolu_1', error: 'MCP error -32603: search failed (captcha)', ...extra })
  const success = (tool: string) => payload('PostToolUse', { tool_name: tool, tool_input: { query: 'bun 1.4 release notes' }, tool_response: [{ type: 'text', text: 'results' }] })
  const webSearch = async () => decision((await claudeHook('PreToolUse', payload('PreToolUse', { tool_name: 'WebSearch', tool_input: { query: 'bun 1.4 release notes' } }), ctx(), deps())).stdout)

  test('two failing web-search calls send the built-in web search to web-fetch, two failing web-fetch calls let it through with the fallback note; a success resets the count', async () => {
    await withSandbox(async () => {
      const route = async () => context((await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'search the web for the bun 1.4 release notes' }), ctx(), deps())).stdout)
      expect(await route()).toContain('web-search')
      expect(await claudeHook('PostToolUseFailure', failure(WS), ctx(), deps())).toEqual({ stdout: '', exitCode: 0 })
      expect(String((await webSearch()).permissionDecisionReason)).toContain(WS)
      await claudeHook('PostToolUseFailure', failure(WS), ctx(), deps())
      expect(loadLedger('claude', SID).mcpErrors).toEqual({ 'web-search': 2 })
      const redirected = await webSearch()
      expect(redirected.permissionDecision).toBe('deny')
      expect(String(redirected.permissionDecisionReason)).toContain(WF)
      expect(await route()).not.toContain('web-search')
      for (let i = 0; i < 2; i++) await claudeHook('PostToolUseFailure', failure(WF, { tool_input: { url: 'https://html.duckduckgo.com/html/?q=bun+1.4' } }), ctx(), deps())
      const allowed = await webSearch()
      expect(allowed.permissionDecision).toBeUndefined()
      expect(String(allowed.additionalContext)).toContain('MCP server is down, so the built-in web search is allowed as a fallback; mention the fallback in your report.')
      await claudeHook('PostToolUse', success(WS), ctx(), deps())
      expect(loadLedger('claude', SID).mcpErrors).toEqual({ 'web-fetch': 2 })
      const back = await webSearch()
      expect(back.permissionDecision).toBe('deny')
      expect(String(back.permissionDecisionReason)).toContain(WS)
    })
  })

  test('a resumed session\'s capability card leaves out a server that is down for the session; a new one starts with a fresh count', async () => {
    await withSandbox(async sb => {
      for (let i = 0; i < 2; i++) await claudeHook('PostToolUseFailure', failure(WS), ctx(), deps())
      const card = async (source: string) => context((await claudeHook('SessionStart', payload('SessionStart', { source, cwd: sb.root }), ctx(), deps())).stdout)
      expect(await card('startup')).toContain('\n- web-search: ')
      expect(loadLedger('claude', SID).mcpErrors).toBeUndefined()
      for (let i = 0; i < 2; i++) await claudeHook('PostToolUseFailure', failure(WS), ctx(), deps())
      const resumed = await card('resume')
      expect(resumed).toContain('Buracle capabilities (Claude Code)')
      expect(resumed).toContain('\n- web-fetch: ')
      expect(resumed).not.toContain('\n- web-search: ')
    })
  })

  test('an interrupted call, a subagent\'s failure, and the MCP tools of other servers', async () => {
    await withSandbox(async () => {
      await claudeHook('PostToolUseFailure', failure(WS, { is_interrupt: true }), ctx(), deps())
      expect(loadLedger('claude', SID).mcpErrors).toBeUndefined()
      await claudeHook('PostToolUseFailure', failure('mcp__claude_ai_Gmail__search_threads'), ctx(), deps())
      await claudeHook('PostToolUseFailure', payload('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'false' }, error: 'Exit code 1' }), ctx(), deps())
      expect(loadLedger('claude', SID).mcpErrors).toBeUndefined()
      await claudeHook('PostToolUseFailure', failure(WS, { agent_id: 'a1', agent_type: 'Explore' }), ctx(), deps())
      await claudeHook('PostToolUseFailure', failure(WS), ctx(), deps())
      expect(loadLedger('claude', SID).mcpErrors).toEqual({ 'web-search': 2 })
      await claudeHook('PostToolUse', success('mcp__plugin_buracle_context7__query-docs'), ctx(), deps())
      expect(loadLedger('claude', SID).mcpErrors).toEqual({ 'web-search': 2 })
    })
  })
})

describe('Stop: H23 route.audit once per prompt, after the stop guard', () => {
  const stopPayload = payload('Stop', { last_assistant_message: 'Done.', stop_hook_active: false })

  test('an explicitly asked workflow that was not loaded holds the stop once; loading it, or strictness off, lets it through', async () => {
    await withSandbox(async () => {
      await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'use the plan-build workflow to add rate limiting' }), ctx(), deps())
      const first = json((await claudeHook('Stop', stopPayload, ctx(), deps())).stdout)
      expect(first['decision']).toBeUndefined()
      expect(String((first['hookSpecificOutput'] as Record<string, unknown>)['additionalContext'])).toStartWith('Buracle routing check: the user asked for plan-build and it was not loaded.')
      expect(await claudeHook('Stop', stopPayload, ctx(), deps())).toEqual({ stdout: '', exitCode: 0 })

      await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'use the plan-build workflow to add a cache' }), ctx(), deps())
      await claudeHook('PostToolUse', payload('PostToolUse', { tool_name: 'Read', tool_input: { file_path: join(PLUGIN, 'skills', 'plan-build', 'SKILL.md') }, tool_response: { type: 'text' } }), ctx(), deps())
      expect(await claudeHook('Stop', stopPayload, ctx(), deps())).toEqual({ stdout: '', exitCode: 0 })

      const off = defaultConfig()
      off.routing.strictness = 'off'
      await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'use the bugfix workflow for the flaky test' }), ctx(off), deps())
      expect(await claudeHook('Stop', stopPayload, ctx(off), deps())).toEqual({ stdout: '', exitCode: 0 })
    })
  })

  test('a question about earlier work without a memory search holds the stop once', async () => {
    await withSandbox(async () => {
      await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'why did we pick bun over node last time?' }), ctx(), deps())
      expect(String((json((await claudeHook('Stop', stopPayload, ctx(), deps())).stdout)['hookSpecificOutput'] as Record<string, unknown>)['additionalContext'])).toContain('memory was not searched')
    })
  })

  test('only where the plan does not hold the session (core routeAuditAllowed): never after the user paused it, while it waits for the user, or after a runaway release', async () => {
    await withSandbox(async () => {
      const plan = { path: '/tmp/project/docs/plans/p.md', slug: 'p', status: 'IN_PROGRESS' as const, type: 'Feature' as const, phase: 'implement' as const, registeredAt: NOW - 1000 }
      saveState('claude', SID, { ...freshState(), plan })
      await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'Stop. Where were we?' }), ctx(), deps())
      expect(loadState('claude', SID).interaction?.state).toBe('paused')
      expect(await claudeHook('Stop', payload('Stop', { last_assistant_message: 'Stopped after task 2.', stop_hook_active: false }), ctx(), deps())).toEqual({ stdout: '', exitCode: 0 })
      const after = async (why: StopWhy): Promise<Record<string, unknown>> => {
        saveState('claude', SID, { ...freshState(), plan, guard: { blocksForPlan: 3, blocksInChain: 2 } })
        await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'why did we pick bun over node last time?' }), ctx(), deps())
        const release: HookDeps['core']['stopGuardVerdict'] = s => ({ decision: { action: 'allow' }, next: { ...s, guard: { ...s.guard, blocksInChain: 0 } }, why })
        const out = (await claudeHook('Stop', payload('Stop', { stop_hook_active: true }), ctx(), deps({ core: { ...defaultHookDeps.core, stopGuardVerdict: release } }))).stdout
        return out === '' ? {} : json(out)
      }
      for (const why of ['paused', 'awaiting-approval', 'question'] as StopWhy[]) expect({ why, out: await after(why) }).toEqual({ why, out: {} })
      for (const why of ['runaway-plan', 'runaway-chain'] as StopWhy[]) expect({ why, out: await after(why) }).toEqual({ why, out: { systemMessage: runawayNotice(why, defaultConfig().plan) } })
      for (const why of ['finished', 'disabled'] as StopWhy[]) {
        const out = await after(why)
        const context = (out['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['additionalContext']
        expect({ why, decision: out['decision'] }).toEqual({ why, decision: undefined })
        expect(String(context)).toStartWith('Buracle routing check: this prompt asks about earlier work and memory was not searched.')
      }
    })
  })
})

describe('PreToolUse: reviewers run a read-only shell', () => {
  const sub = (command: string) => payload('PreToolUse', { tool_name: 'Bash', tool_input: { command }, agent_id: 'a1', agent_type: 'buracle:changes-review' })
  test('reading is fine, changing is denied', async () => {
    await withSandbox(async () => {
      expect((await claudeHook('PreToolUse', sub('git diff main...HEAD'), ctx(), deps())).stdout).toBe('')
      const r = await claudeHook('PreToolUse', sub('echo x > notes.txt'), ctx(), deps())
      const out = json(r.stdout)['hookSpecificOutput'] as Record<string, unknown>
      expect(out['permissionDecision']).toBe('deny')
      expect(String(out['permissionDecisionReason'])).toContain('read-only reviewer')
    })
  })
})

describe('H28 project assets', () => {
  const skill = '---\nname: deploy\ndescription: Deploy\n---\n'
  test('SessionStart and Stop start the link run for a skill without a .claude/skills link; Claude gets no rule list', async () => {
    await withSandbox(async sb => {
      const { makeRepo, write } = await import('../../workflow/fixture')
      const repo = await makeRepo(sb.root)
      write(join(repo, '.agents', 'skills', 'deploy', 'SKILL.md'), skill)
      write(join(repo, '.claude', 'rules', 'web.md'), '---\npaths: ["src/**/*.tsx"]\n---\n')
      const spawned: Array<{ argv: string[], cwd: string }> = []
      const r = await claudeHook('SessionStart', payload('SessionStart', { source: 'startup', cwd: repo }), ctx(), deps({
        prepareWorkspace: async () => info(repo),
        assetsSpawn: (argv, cwd) => { spawned.push({ argv, cwd }) },
      }))
      expect(spawned.map(s => [s.argv.slice(-4), s.cwd])).toEqual([[['project', 'sync', '--auto', '--quiet'], repo]])
      expect(context(r.stdout)).not.toContain('.claude/rules/web.md')
      const other = await makeRepo(sb.root, 'other')
      write(join(other, '.agents', 'skills', 'deploy', 'SKILL.md'), skill)
      saveWorkspace(SID, info(other))
      await claudeHook('Stop', payload('Stop', { cwd: other }), ctx(), deps({ assetsSpawn: (argv, cwd) => { spawned.push({ argv, cwd }) } }))
      expect(spawned.map(s => s.cwd)).toEqual([repo, other])
    })
  })

  test('PostToolUse after a Write of a path rule the AGENTS.md index lacks adds the index line to add', async () => {
    await withSandbox(async sb => {
      const { makeRepo, write } = await import('../../workflow/fixture')
      const repo = await makeRepo(sb.root)
      write(join(repo, 'AGENTS.md'), '# Demo\n\n## Scoped rules\n\n')
      const file = join(repo, '.claude', 'rules', 'web.md')
      write(file, '---\npaths: ["src/**/*.tsx"]\n---\n')
      saveWorkspace(SID, info(repo))
      const r = await claudeHook('PostToolUse', payload('PostToolUse', { cwd: repo, tool_name: 'Write', tool_input: { file_path: file, content: '---\npaths: ["src/**/*.tsx"]\n---\n' }, tool_response: { type: 'create' } }), ctx({ checkers: { ...defaultConfig().checkers, enabled: false } }), deps())
      expect(context(r.stdout)).toContain('.claude/rules/web.md is not in AGENTS.md')
    })
  })

  test('SessionStart adds a one-line index drift warning when AGENTS.md exists, without the rule list', async () => {
    await withSandbox(async sb => {
      const { makeRepo, write } = await import('../../workflow/fixture')
      const repo = await makeRepo(sb.root)
      write(join(repo, 'AGENTS.md'), '# Demo\n\n## Scoped rules\n\n')
      write(join(repo, '.claude', 'rules', 'web.md'), '---\npaths: ["src/**/*.tsx"]\n---\n')
      const r = await claudeHook('SessionStart', payload('SessionStart', { source: 'startup', cwd: repo }), ctx(), deps({ prepareWorkspace: async () => info(repo) }))
      expect(context(r.stdout)).toContain('1 path rule(s) in .claude/rules are out of step')
      expect(context(r.stdout)).not.toContain('.claude/rules/web.md')
    })
  })
})

describe('w2 plan state on Claude: H10 holds, H09 notes, the H08 receipt, the lane guard and the quiet stop releases', () => {
  const plan = (over: Record<string, unknown> = {}) => ({ path: '/tmp/project/docs/plans/p.md', slug: 'p', status: 'IN_PROGRESS' as const, type: 'Feature' as const, phase: 'implement' as const, registeredAt: NOW - 1000, ...over })
  const deny = (stdout: string): string | undefined => {
    if (stdout === '') return undefined
    const h = json(stdout)['hookSpecificOutput'] as Record<string, unknown> | undefined
    return h?.['permissionDecision'] === 'deny' ? String(h['permissionDecisionReason']) : undefined
  }

  test('a bare "continue" keeps a decision pause and says why; an explicit approval during the result review records it', async () => {
    await withSandbox(async () => {
      saveState('claude', SID, { ...freshState(), plan: plan(), interaction: { state: 'paused', kind: 'decision', since: NOW - 10, reason: 'merge decision' } })
      const r = await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'continue' }), ctx(), deps())
      expect(context(r.stdout)).toContain('stays paused on an open decision ("merge decision")')
      expect(loadState('claude', SID).interaction?.state).toBe('paused')
      saveState('claude', SID, { ...freshState(), plan: plan({ status: 'COMPLETE', phase: 'verify' }), interaction: { state: 'paused', kind: 'decision', since: NOW - 10, reason: 'result review' } })
      const ok = await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'LGTM' }), ctx(), deps())
      expect(context(ok.stdout)).toContain('the user approved the verified result')
      expect(loadState('claude', SID)).toMatchObject({ approvals: { resultApprovedAt: NOW }, interaction: { state: 'running' } })
    })
  })

  test('H09: a real question while the plan runs gets the pause reminder; a routine one at COMPLETE is denied', async () => {
    await withSandbox(async () => {
      saveState('claude', SID, { ...freshState(), plan: plan() })
      const ask = (question: string, options: string[]) => payload('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question, header: 'Q', options: options.map(label => ({ label, description: '' })), multiSelect: false }] } })
      const real = await claudeHook('PreToolUse', ask('Redis or the in-memory store?', ['Redis', 'In-memory']), ctx(), deps())
      expect(context(real.stdout)).toContain('buracle plan pause --kind decision')
      saveState('claude', SID, { ...freshState(), plan: plan({ status: 'COMPLETE', phase: 'verify' }) })
      expect(deny((await claudeHook('PreToolUse', ask('Should I keep waiting for the tests?', ['Keep waiting', 'Stop']), ctx(), deps())).stdout)).toContain('Buracle H09')
    })
  })

  test('H08 receipt: an answered AskUserQuestion during a decision pause holds the next stop once', async () => {
    await withSandbox(async () => {
      saveState('claude', SID, { ...freshState(), plan: plan(), interaction: { state: 'paused', kind: 'decision', since: NOW - 10, reason: 'merge decision' } })
      await claudeHook('PostToolUse', payload('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Merge?' }] }, tool_response: { questions: [{ question: 'Merge?' }], answers: { 'Merge?': 'Squash-merge' } } }), ctx(), deps())
      expect(loadState('claude', SID).interaction?.answeredAt).toBe(NOW)
      const stop = json((await claudeHook('Stop', payload('Stop', { last_assistant_message: 'Merging now.', stop_hook_active: false }), ctx(), deps())).stdout)
      expect(String((stop['hookSpecificOutput'] as Record<string, unknown>)['additionalContext'])).toContain('was answered in the question tool')
      expect(await claudeHook('Stop', payload('Stop', { last_assistant_message: 'Merging now.', stop_hook_active: true }), ctx(), deps())).toEqual({ stdout: '', exitCode: 0 })
    })
  })

  test('H01 lane guard: a subagent cannot change the lead\'s plan state; the lead and read-only commands can', async () => {
    await withSandbox(async () => {
      const bash = (command: string, extra: Record<string, unknown> = {}) => payload('PreToolUse', { tool_name: 'Bash', tool_input: { command }, ...extra })
      const lane = { agent_id: 'agent-1', agent_type: 'general-purpose' }
      expect(deny((await claudeHook('PreToolUse', bash('buracle plan pause --kind decision --reason "merge?"', lane), ctx(), deps())).stdout)).toContain('Buracle lane guard')
      expect(deny((await claudeHook('PreToolUse', bash('buracle flow phase verify', lane), ctx(), deps())).stdout)).toContain('`buracle flow phase`')
      expect(deny((await claudeHook('PreToolUse', bash('buracle plan status --json', lane), ctx(), deps())).stdout)).toBeUndefined()
      expect(deny((await claudeHook('PreToolUse', bash('buracle plan pause --kind decision'), ctx(), deps())).stdout)).toBeUndefined()
    })
  })

  test('Stop: plan mode and a background wait end the turn without a block; a dev server does not count', async () => {
    await withSandbox(async () => {
      saveState('claude', SID, { ...freshState(), plan: plan() })
      const planMode = json((await claudeHook('Stop', payload('Stop', { permission_mode: 'plan', last_assistant_message: 'Here is the plan.' }), ctx(), deps())).stdout)
      expect(planMode).toEqual({ systemMessage: 'Buracle: the session is in plan mode (read-only), so the stop guard lets the turn end. Leave plan mode (shift+tab) to continue the plan.' })
      expect(await claudeHook('Stop', payload('Stop', { permission_mode: 'plan', last_assistant_message: 'Refined the plan.' }), ctx(), deps())).toEqual({ stdout: '', exitCode: 0 })
      saveState('claude', SID, { ...freshState(), plan: plan({ phase: 'plan', status: 'PENDING' }) })
      expect(await claudeHook('Stop', payload('Stop', { permission_mode: 'plan', last_assistant_message: 'Here is the plan.' }), ctx(), deps())).toEqual({ stdout: '', exitCode: 0 })
      saveState('claude', SID, { ...freshState(), plan: plan() })
      const waiting = 'The test suite is running in the background; I will continue once it reports.'
      const bg = await claudeHook('Stop', payload('Stop', { last_assistant_message: waiting, background_tasks: [{ id: 't1', type: 'shell', status: 'running', command: 'bun test', description: 'tests' }], session_crons: [] }), ctx(), deps())
      expect(bg).toEqual({ stdout: '', exitCode: 0 })
      expect(loadState('claude', SID).guard.blocksForPlan).toBe(0)
      const dev = json((await claudeHook('Stop', payload('Stop', { last_assistant_message: waiting, background_tasks: [{ id: 't2', type: 'shell', status: 'running', command: 'bun run dev' }] }), ctx(), deps())).stdout)
      expect(String((dev['hookSpecificOutput'] as Record<string, unknown>)['additionalContext'])).toStartWith('Buracle stop guard:')
    })
  })
})
