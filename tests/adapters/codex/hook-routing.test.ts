import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as core from '../../../src/core/index'
import { defaultConfig } from '../../../src/core/config'
import type { StopWhy } from '../../../src/core/plan/state'
import type { IndexState, WorkspaceInfo } from '../../../src/core/workspace'
import { readFlow, recordFlowStart } from '../../../src/workflow/flow'
import { loadLedger, updateLedger } from '../../../src/workflow/ledger'
import { loadState, saveState } from '../../../src/workflow/session-store'
import { fitParts, handleCodexHook, subagentAliasesFile, type CodexHookDeps } from '../../../src/adapters/codex/hook'
import { loadWorkspaceInfo, readMcpHealth, saveWorkspaceInfo, workspaceFile } from '../../../src/adapters/codex/route'
import * as paths from '../../../src/engine/paths'
import { withSandbox } from '../../helpers/sandbox'
import { ctx, deps, keys, NOW, payload, planState, quiet, SID } from './hook-helpers'

const CHILD = '019a0000-0000-7000-8000-00000000c41d'

describe('routing (H21-H26)', () => {
  const infoAt = (root: string, codegraph: IndexState = { state: 'ready', at: NOW }): WorkspaceInfo => ({ cwd: root, root, children: [], index: { codegraph, semble: { state: 'ready', at: NOW } } })
  const prompt = (text: string, extra: Record<string, unknown> = {}) => payload('UserPromptSubmit', { prompt: text, ...extra })
  const contextOf = (r: { stdout: string }): string => (r.stdout === '' ? '' : String(JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? ''))

  test('H21: the session start records the workspace and names the root to the agent; a subagent gets the read-only info and records nothing', () => withSandbox(async ({ root }) => {
    const proj = join(root, 'proj')
    const seen: string[] = []
    const d: CodexHookDeps = {
      ...deps(quiet),
      prepareWorkspace: async cwd => { seen.push(`prepare ${cwd}`); return infoAt(proj) },
      workspaceInfo: async cwd => { seen.push(`info ${cwd}`); return infoAt(proj) },
    }
    const text = contextOf(await handleCodexHook('SessionStart', payload('SessionStart', { cwd: proj, source: 'startup' }), ctx(), d))
    expect(text).toContain(`Project root: ${proj}. Pass it as codegraph \`projectPath\` and semble \`repo\``)
    expect(text).toContain('Capability card')
    expect(loadWorkspaceInfo(ctx(), SID)).toEqual(infoAt(proj))
    rmSync(workspaceFile(ctx(), SID))
    const sub = contextOf(await handleCodexHook('SubagentStart', payload('SubagentStart', { cwd: proj, turn_id: 'turn-child-1', agent_id: CHILD, agent_type: 'worker' }), ctx(), d))
    expect(sub).toContain(`Project root: ${proj}`)
    expect(seen).toEqual([`prepare ${proj}`, `info ${proj}`])
    expect(loadWorkspaceInfo(ctx(), SID)).toBeUndefined()
  }))

  test('H21: Codex starts a thread-spawned subagent with SubagentStart; the subagent gets the workspace lines, read-only (nothing prepared or recorded)', () => withSandbox(async ({ root }) => {
    const proj = join(root, 'proj')
    const seen: string[] = []
    const d: CodexHookDeps = {
      ...deps(quiet),
      prepareWorkspace: async cwd => { seen.push(`prepare ${cwd}`); return infoAt(proj) },
      workspaceInfo: async cwd => { seen.push(`info ${cwd}`); return infoAt(proj) },
      refreshWorkspace: i => { seen.push(`refresh ${i.cwd}`); return { ...i, index: { ...i.index, codegraph: { state: 'ready', at: NOW } } } },
    }
    const start = () => handleCodexHook('SubagentStart', payload('SubagentStart', { cwd: proj, turn_id: 'turn-child-1', agent_id: CHILD, agent_type: 'worker' }), ctx(), d)
    const out = JSON.parse((await start()).stdout)
    expect(keys(out)).toEqual(['hookSpecificOutput'])
    expect(keys(out.hookSpecificOutput)).toEqual(['additionalContext', 'hookEventName'])
    expect(out.hookSpecificOutput.hookEventName).toBe('SubagentStart')
    expect(out.hookSpecificOutput.additionalContext).toContain(`Project root: ${proj}. Pass it as codegraph \`projectPath\` and semble \`repo\``)
    expect(seen).toEqual([`info ${proj}`])
    expect(loadWorkspaceInfo(ctx(), SID)).toBeUndefined()
    expect(JSON.parse(readFileSync(subagentAliasesFile(ctx()), 'utf8'))).toEqual({ [CHILD]: SID })
    const building = infoAt(proj, { state: 'building', since: NOW - 1000 })
    saveWorkspaceInfo(ctx(), SID, building)
    expect(JSON.parse((await start()).stdout).hookSpecificOutput.additionalContext).toContain(`Project root: ${proj}.`)
    expect(seen).toEqual([`info ${proj}`, `refresh ${proj}`])
    expect(loadWorkspaceInfo(ctx(), SID)).toEqual(building)
  }))

  test('H24: startup and /clear start the usage ledger over; resume and compaction keep it', () => withSandbox(async () => {
    updateLedger('codex', SID, l => ({ ...l, turn: 7 }))
    for (const source of ['resume', 'compact']) {
      await handleCodexHook('SessionStart', payload('SessionStart', { source }), ctx(), deps(quiet))
      expect({ source, turn: loadLedger('codex', SID).turn }).toEqual({ source, turn: 7 })
    }
    await handleCodexHook('SessionStart', payload('SessionStart', { source: 'clear' }), ctx(), deps(quiet))
    expect(loadLedger('codex', SID).turn).toBe(0)
  }))

  test('H22: an explicit ask tells the model to read the skill\'s SKILL.md (context cannot load a skill on Codex); the prompt is in the ledger', () => withSandbox(async () => {
    const text = contextOf(await handleCodexHook('UserPromptSubmit', prompt('use the research skill to compare bun and deno'), ctx(), deps(quiet)))
    expect(text).toContain('The user asked for the research skill')
    expect(text).toContain('read ~/.agents/skills/research/SKILL.md')
    const l = loadLedger('codex', SID)
    expect([l.turn, l.prompt?.route.load]).toEqual([1, ['research']])
  }))

  test('H25: `$plan-build <task>` starts the plan-build run in flow.json and counts as loaded; H26 records the workflow use', () => withSandbox(async () => {
    const d = deps(quiet)
    const text = contextOf(await handleCodexHook('UserPromptSubmit', prompt('$plan-build add rate limiting to the upload API'), ctx(), d))
    expect(text).not.toContain('plan-build')
    expect(readFlow('codex', SID)?.stack[0]).toMatchObject({ workflow: 'plan-build', title: 'add rate limiting to the upload API', source: 'prompt' })
    expect(loadLedger('codex', SID).skills['plan-build']?.n).toBe(1)
    expect(d.rec.spool.filter(e => e.ev === 'signal').map(e => e.signal?.key)).toContain('usage.workflow=plan-build')
    const d2 = deps(quiet)
    await handleCodexHook('UserPromptSubmit', prompt('please run $memory on this'), ctx(), d2)
    expect(readFlow('codex', SID)?.stack.map(e => e.workflow)).toEqual(['plan-build'])
    expect(d2.rec.spool.filter(e => e.ev === 'signal').map(e => e.signal?.key)).toContain('usage.skill=memory')
  }))

  test('routing.skills off drops the skill lines (the memory line stays); routing.strictness off drops the MCP lines', () => withSandbox(async () => {
    const c = defaultConfig()
    c.routing.skills = 'off'
    const text = contextOf(await handleCodexHook('UserPromptSubmit', prompt('use the research skill: what did we decide last time?'), ctx(c), deps(quiet)))
    expect(text).not.toContain('research')
    expect(text).toContain('Earlier work')
  }))

  test('H21: a codegraph index that became ready since the session start is announced once', () => withSandbox(async ({ root }) => {
    const proj = join(root, 'proj')
    saveWorkspaceInfo(ctx(), SID, infoAt(proj, { state: 'building', since: NOW - 1000 }))
    const d: CodexHookDeps = { ...deps(quiet), refreshWorkspace: i => ({ ...i, index: { ...i.index, codegraph: { state: 'ready', at: NOW } } }) }
    expect(contextOf(await handleCodexHook('UserPromptSubmit', prompt('ok'), ctx(), d))).toContain(`The codegraph index of ${proj} is ready now`)
    expect(contextOf(await handleCodexHook('UserPromptSubmit', prompt('ok'), ctx(), d))).toBe('')
  }))

  test('H24/H03: a codegraph projectPath at the home folder is denied naming the project root; the right one is recorded; subagent calls stay out of the session ledger', () => withSandbox(async ({ home, root }) => {
    const proj = join(root, 'proj')
    saveWorkspaceInfo(ctx(), SID, infoAt(proj))
    const mcp = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) => payload('PreToolUse', { tool_name: 'mcp__codegraph__codegraph_explore', tool_input: input, ...extra })
    const denied = JSON.parse((await handleCodexHook('PreToolUse', mcp({ query: 'x', projectPath: home }), ctx(), deps({}))).stdout)
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(denied.hookSpecificOutput.permissionDecisionReason).toStartWith('Buracle H03: codegraph `projectPath`')
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain(`Pass the project root ${proj} instead`)
    expect((await handleCodexHook('PreToolUse', mcp({ query: 'uploadFile', projectPath: proj }), ctx(), deps({}))).stdout).toBe('')
    expect(loadLedger('codex', SID).mcp['codegraph']?.n).toBe(1)
    expect(loadLedger('codex', SID).symbols).toContain('uploadFile')
    await handleCodexHook('PreToolUse', mcp({ query: 'y', projectPath: proj }, { agent_id: 'a1', agent_type: 'worker' }), ctx(), deps({}))
    expect(loadLedger('codex', SID).mcp['codegraph']?.n).toBe(1)
  }))

  test('health.json: a server whose start failed is down until its `until`, then usable again', () => withSandbox(async () => {
    mkdirSync(join(paths.healthFile(), '..'), { recursive: true })
    writeFileSync(paths.healthFile(), JSON.stringify({ v: 1, checked_at: 'x', mcp: { 'web-search': { status: 'down', source: 'launch', until: new Date(NOW + 60_000).toISOString() }, context7: { status: 'ok' } } }))
    expect(readMcpHealth(ctx(), NOW)).toEqual({ 'web-search': 'down', context7: 'ok' })
    expect(readMcpHealth(ctx(), NOW + 60_000)).toEqual({ 'web-search': 'unknown', context7: 'ok' })
  }))

  test('H24: MCP results in PostToolUse feed the session failure rule; H03, the router and the card route by the session\'s health', () => withSandbox(async ({ root }) => {
    const d = deps({})
    const result = (tool: string, isError: boolean, extra: Record<string, unknown> = {}) => handleCodexHook('PostToolUse', payload('PostToolUse', {
      tool_name: tool, tool_input: { query: 'bun 1.4 release notes' }, tool_response: { content: [{ type: 'text', text: isError ? 'search failed (captcha)' : 'results' }], isError }, ...extra,
    }), ctx(), d)
    const search = async (): Promise<Record<string, unknown>> => {
      const out = (await handleCodexHook('PreToolUse', payload('PreToolUse', { tool_name: 'webrun', tool_input: { search_query: [{ q: 'bun 1.4 release notes' }] } }), ctx(), d)).stdout
      return out === '' ? {} : JSON.parse(out).hookSpecificOutput as Record<string, unknown>
    }
    const route = async () => contextOf(await handleCodexHook('UserPromptSubmit', prompt('search the web for the bun 1.4 release notes'), ctx(), d))
    const card = async () => contextOf(await handleCodexHook('SessionStart', payload('SessionStart', { cwd: root, source: 'resume' }), ctx(), d))
    expect(await route()).toContain('web-search')
    expect(await card()).toContain('\n- web-search')
    await result('mcp__web_search__search', true)
    expect(String((await search()).permissionDecisionReason)).toContain('mcp__web_search__search')
    await result('mcp__web_search__search', true, { agent_id: CHILD, agent_type: 'worker' })
    expect(loadLedger('codex', SID).mcpErrors).toEqual({ 'web-search': 2 })
    expect(String((await search()).permissionDecisionReason)).toContain('mcp__web_fetch__fetch_url')
    expect(await route()).not.toContain('web-search')
    for (let i = 0; i < 2; i++) await result('mcp__web_fetch__fetch_url', true)
    const allowed = await search()
    expect(allowed.permissionDecision).toBeUndefined()
    expect(String(allowed.additionalContext)).toContain('MCP server is down, so the built-in web search is allowed as a fallback')
    const resumed = await card()
    expect(resumed).toContain('Buracle capabilities (Codex)')
    expect(resumed).not.toContain('\n- web-search')
    await result('mcp__web_search__search', false)
    expect(loadLedger('codex', SID).mcpErrors).toEqual({ 'web-fetch': 2 })
    expect(String((await search()).permissionDecisionReason)).toContain('mcp__web_search__search')
  }))

  test('H24/H03: the root check is the one every harness uses: a folder of projects, a parent of home and index.exclude names are denied', () => withSandbox(async ({ root }) => {
    const c = defaultConfig()
    c.index.exclude = ['vendor']
    const semble = (repo: string) => handleCodexHook('PreToolUse', payload('PreToolUse', { tool_name: 'mcp__semble__search', tool_input: { query: 'x', repo } }), ctx(c), deps({}))
    const reason = async (repo: string): Promise<string | undefined> => {
      const out = (await semble(repo)).stdout
      return out === '' ? undefined : JSON.parse(out).hookSpecificOutput?.permissionDecisionReason
    }
    const dev = join(root, 'dev')
    const alpha = join(dev, 'alpha')
    mkdirSync(join(alpha, 'vendor'), { recursive: true })
    saveWorkspaceInfo(ctx(c), SID, { cwd: dev, children: [alpha, join(dev, 'beta')], index: { codegraph: { state: 'none' }, semble: { state: 'none' } } })
    expect(await reason(dev)).toContain('a folder of projects, not a project')
    expect(await reason(dev)).toContain('Pass one of its projects instead (alpha, beta)')
    expect(await reason(root)).toContain('a parent of your home folder')
    expect(await reason(join(alpha, 'vendor'))).toContain('excluded by index.exclude (vendor)')
    expect(await reason(alpha)).toBeUndefined()
  }))

  test('H24/H03 for a thread-spawned subagent: the root check and the deny-once gates apply to its calls, on a ledger of its own (never the session\'s turn)', () => withSandbox(async ({ home, root }) => {
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ dependencies: { zod: '^3' } }))
    saveWorkspaceInfo(ctx(), SID, infoAt(proj))
    const sub = { agent_id: CHILD, agent_type: 'worker' }
    const reason = async (p: string): Promise<string | undefined> => {
      const out = (await handleCodexHook('PreToolUse', p, ctx(), deps(quiet))).stdout
      return out === '' ? undefined : JSON.parse(out).hookSpecificOutput?.permissionDecisionReason
    }
    const call = (tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = sub) => payload('PreToolUse', { cwd: proj, tool_name: tool, tool_input: input, ...extra })
    for (let i = 0; i < 2; i++) {
      const why = await reason(call('mcp__semble__search', { query: 'where is auth', repo: home }))
      expect(why).toStartWith(`Buracle H03: semble \`repo\` is ${home}, your home folder`)
      expect(why).toContain(`Pass the project root ${proj} instead.`)
    }
    expect(await reason(call('mcp__codegraph__codegraph_explore', { query: 'auth', projectPath: home }))).toStartWith('Buracle H03: codegraph `projectPath`')
    expect(await reason(call('mcp__semble__search', { query: 'where is auth', repo: proj }))).toBeUndefined()
    const patch = "*** Begin Patch\n*** Add File: src/schema.ts\n+import { z } from 'zod'\n+const user = z.object({})\n*** End Patch\n"
    expect(await reason(call('apply_patch', { command: patch }))).toStartWith('Buracle H03: this edit adds an import of `zod`')
    expect(await reason(call('apply_patch', { command: patch }))).toBeUndefined()
    const l = loadLedger('codex', SID)
    expect([l.mcp, l.usedOnce, l.turnTools.calls]).toEqual([{}, [], 0])
    expect(await reason(call('apply_patch', { command: patch }, {}))).toStartWith('Buracle H03: this edit adds an import of `zod`')
  }))

  test('H24/H23: a Bash read of a SKILL.md loads the skill (profile usage signal); an explicitly requested skill that was not loaded holds the stop once', () => withSandbox(async () => {
    const d = deps(quiet)
    await handleCodexHook('UserPromptSubmit', prompt('use the research skill to compare bun and deno'), ctx(), d)
    const blocked = JSON.parse((await handleCodexHook('Stop', payload('Stop'), ctx(), d)).stdout)
    expect(keys(blocked)).toEqual(['decision', 'reason'])
    expect(blocked.reason).toStartWith('Buracle routing check: the user asked for research')
    expect(core.isGuardContinuation(blocked.reason)).toBe(true)
    expect((await handleCodexHook('Stop', payload('Stop', { stop_hook_active: true }), ctx(), d)).stdout).toBe('')
    await handleCodexHook('UserPromptSubmit', prompt('use the research skill to compare zod and yup'), ctx(), d)
    expect((await handleCodexHook('PreToolUse', payload('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'cat ~/.agents/skills/research/SKILL.md' } }), ctx(), d)).stdout).toBe('')
    expect(loadLedger('codex', SID).skills['research']?.n).toBe(1)
    expect(d.rec.spool.some(e => e.ev === 'signal' && e.signal?.key === 'usage.skill=research')).toBe(true)
    expect((await handleCodexHook('Stop', payload('Stop'), ctx(), d)).stdout).toBe('')
  }))

  test('H23: routing.strictness off never holds a stop', () => withSandbox(async () => {
    const off = defaultConfig()
    off.routing.strictness = 'off'
    const d = deps(quiet)
    await handleCodexHook('UserPromptSubmit', prompt('what did we decide last time about the upload limits?'), ctx(off), d)
    expect((await handleCodexHook('Stop', payload('Stop'), ctx(off), d)).stdout).toBe('')
    saveState('codex', SID, planState({ plan: { path: 'docs/plans/p.md', slug: 'p', status: 'VERIFIED', type: 'Feature', phase: 'done', registeredAt: 1 } }))
    await handleCodexHook('UserPromptSubmit', prompt('what did we decide last time about the cache?'), ctx(off), d)
    expect((await handleCodexHook('Stop', payload('Stop'), ctx(off), d)).stdout).toBe('')
  }))

  test('H23 runs only where the plan does not hold the session (core routeAuditAllowed): never after the user paused it, while it waits for the user, or after a runaway release', () => withSandbox(async ({ root }) => {
    saveState('codex', SID, planState())
    await handleCodexHook('UserPromptSubmit', prompt('Stop. Where were we?'), ctx(), deps({}))
    expect(loadState('codex', SID).interaction?.state).toBe('paused')
    expect((await handleCodexHook('Stop', payload('Stop', { cwd: root, last_assistant_message: 'Stopped after task 2.' }), ctx(), deps({}))).stdout).toBe('')
    const after = async (why: StopWhy): Promise<Record<string, unknown>> => {
      const d = deps({ stopGuardVerdict: s => ({ decision: { action: 'allow' }, next: s, why }) })
      await handleCodexHook('UserPromptSubmit', prompt('why did we pick bun over node last time?'), ctx(), d)
      const out = (await handleCodexHook('Stop', payload('Stop', { cwd: root, stop_hook_active: true }), ctx(), d)).stdout
      return out === '' ? {} : JSON.parse(out) as Record<string, unknown>
    }
    for (const why of ['paused', 'awaiting-approval', 'question'] as StopWhy[]) expect({ why, out: await after(why) }).toEqual({ why, out: {} })
    for (const why of ['runaway-chain', 'runaway-plan'] as StopWhy[]) {
      const out = await after(why)
      expect({ why, keys: keys(out) }).toEqual({ why, keys: ['systemMessage'] })
      expect(String(out['systemMessage'])).toStartWith('Buracle stop guard:')
    }
    for (const why of ['finished', 'disabled'] as StopWhy[]) {
      const out = await after(why)
      expect({ why, decision: out['decision'] }).toEqual({ why, decision: 'block' })
      expect(String(out['reason'])).toStartWith('Buracle routing check: this prompt asks about earlier work and memory was not searched.')
    }
  }))

  test('H25: a workflow the model loads by reading its installed SKILL.md (the router\'s T1 line) starts its run; H26 counts the skill and the workflow', () => withSandbox(async ({ home }) => {
    const d = deps(quiet)
    const text = contextOf(await handleCodexHook('UserPromptSubmit', prompt('plan-build ile yap: add rate limiting to the upload endpoint'), ctx(), d))
    expect(text).toContain('read ~/.agents/skills/plan-build/SKILL.md')
    expect(readFlow('codex', SID)).toBeUndefined()
    const read = (command: string) => handleCodexHook('PreToolUse', payload('PreToolUse', { tool_name: 'Bash', tool_input: { command } }), ctx(), d)
    expect((await read(`cat ${home}/.agents/skills/plan-build/SKILL.md`)).stdout).toBe('')
    expect(readFlow('codex', SID)?.stack).toEqual([{ workflow: 'plan-build', source: 'skill', startedAt: NOW }])
    expect(d.rec.spool.filter(e => e.ev === 'signal' && e.signal?.key.startsWith('usage.')).map(e => e.signal?.key)).toEqual(['usage.skill=plan-build', 'usage.workflow=plan-build'])
    expect((await read('sed -n 1,80p ~/.agents/skills/plan-build/SKILL.md')).stdout).toBe('')
    expect(readFlow('codex', SID)?.stack).toEqual([{ workflow: 'plan-build', source: 'skill', startedAt: NOW }])
    expect((await handleCodexHook('Stop', payload('Stop'), ctx(), d)).stdout).toBe('')
  }))

  test('H25: a subagent\'s read of a workflow skill, or reading a workflow\'s source in a checkout, starts no run', () => withSandbox(async ({ home, root }) => {
    const d = deps(quiet)
    const read = (command: string, extra: Record<string, unknown> = {}) => handleCodexHook('PreToolUse', payload('PreToolUse', { tool_name: 'Bash', tool_input: { command }, ...extra }), ctx(), d)
    await read(`cat ${home}/.agents/skills/bugfix/SKILL.md`, { agent_id: CHILD, agent_type: 'worker' })
    await read(`cat ${join(root, 'buracle', 'canonical', 'skills', 'bugfix', 'SKILL.md')}`)
    expect(readFlow('codex', SID)).toBeUndefined()
    expect(d.rec.spool.filter(e => e.ev === 'signal' && e.signal?.key === 'usage.workflow=bugfix')).toEqual([])
  }))

  test('H24/R4: an apply_patch that imports a project dependency context7 was not asked about is denied once; the retry goes through', () => withSandbox(async ({ root }) => {
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ dependencies: { zod: '^3' } }))
    saveWorkspaceInfo(ctx(), SID, infoAt(proj))
    const patch = "*** Begin Patch\n*** Add File: src/schema.ts\n+import { z } from 'zod'\n+const user = z.object({})\n*** End Patch\n"
    const call = () => handleCodexHook('PreToolUse', payload('PreToolUse', { cwd: proj, tool_name: 'apply_patch', tool_input: { command: patch } }), ctx(), deps(quiet))
    const first = JSON.parse((await call()).stdout)
    expect(first.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(first.hookSpecificOutput.permissionDecisionReason).toStartWith('Buracle H03: this edit adds an import of `zod`')
    expect((await call()).stdout).toBe('')
    const shell = `cd ${proj} && apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: src/b.ts\n+import { describe } from 'vitest-x'\n*** End Patch\nEOF`
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ dependencies: { zod: '^3', 'vitest-x': '1' } }))
    const viaShell = JSON.parse((await handleCodexHook('PreToolUse', payload('PreToolUse', { cwd: proj, tool_name: 'Bash', tool_input: { command: shell } }), ctx(), deps(quiet))).stdout)
    expect(viaShell.hookSpecificOutput.permissionDecisionReason).toStartWith('Buracle H03: this edit adds an import of `vitest-x`')
  }))

  test('PostToolUse (H14): MCP calls are spooled with their tool name, `webrun` as a web search', () => withSandbox(async () => {
    const d = deps(quiet)
    await handleCodexHook('PostToolUse', payload('PostToolUse', { tool_name: 'mcp__context7__query_docs', tool_input: { libraryId: '/colinhacks/zod' }, tool_response: {} }), ctx(), d)
    await handleCodexHook('PostToolUse', payload('PostToolUse', { tool_name: 'webrun', tool_input: { search_query: [{ q: 'bun' }] }, tool_response: {} }), ctx(), d)
    expect(d.rec.spool).toEqual([{ ts: NOW, ev: 'tool', tool: 'mcp__context7__query_docs', kind: 'mcp' }, { ts: NOW, ev: 'tool', tool: 'webrun', kind: 'web_search' }])
  }))

  test('H10 texts are English; the user\'s own words are recognized in any language', () => withSandbox(async () => {
    saveState('codex', SID, planState())
    const text = contextOf(await handleCodexHook('UserPromptSubmit', prompt('dur'), ctx(), deps({})))
    expect(text).toContain('the user saying "continue" (in any language)')
    expect(text).not.toMatch(/devam|[çğıöşü]/)
  }))

  test('H25: a session resumed on an unfinished workflow run says so (user: systemMessage; model: one line); workflow.band off says nothing', () => withSandbox(async () => {
    recordFlowStart('codex', SID, { workflow: 'plan-build', title: 'Rate limit the uploads', source: 'prompt' }, NOW - 60_000)
    const out = JSON.parse((await handleCodexHook('SessionStart', payload('SessionStart', { source: 'resume' }), ctx(), deps(quiet))).stdout)
    expect(out.systemMessage).toStartWith('Buracle: this session has an unfinished workflow run (plan-build (Rate limit the uploads)')
    expect(out.systemMessage).toContain('To go on, say: continue the plan-build run')
    expect(out.hookSpecificOutput.additionalContext).toContain('Continue it only when the user asks.')
    expect(JSON.parse((await handleCodexHook('SessionStart', payload('SessionStart', { source: 'startup' }), ctx(), deps(quiet))).stdout).systemMessage).toBeUndefined()
    const off = defaultConfig()
    off.workflow.band = false
    expect(JSON.parse((await handleCodexHook('SessionStart', payload('SessionStart', { source: 'resume' }), ctx(off), deps(quiet))).stdout).systemMessage).toBeUndefined()
  }))

  test('fitParts keeps whole parts within the per-prompt budget; the first part always stays', () => {
    expect(fitParts(['a'.repeat(10), '', 'b'.repeat(10)], 25)).toEqual(['a'.repeat(10), 'b'.repeat(10)])
    expect(fitParts(['a'.repeat(30), 'b'.repeat(10)], 25)).toEqual(['a'.repeat(30)])
    expect(fitParts(['a'.repeat(10), 'b'.repeat(20), 'c'.repeat(5)], 25)).toEqual(['a'.repeat(10), 'c'.repeat(5)])
  })
})

describe('H28 project assets on Codex', () => {
  const infoAt = (root: string): WorkspaceInfo => ({ cwd: root, root, children: [], index: { codegraph: { state: 'ready', at: NOW }, semble: { state: 'ready', at: NOW } } })
  const contextOf = (r: { stdout: string }): string => (r.stdout === '' ? '' : String(JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? ''))

  test('SessionStart lists the unindexed path rules and the Claude-only skills, and starts the link run; apply_patch of a rule gets its index line; Stop is the backstop', () => withSandbox(async ({ root }) => {
    const { makeRepo, write } = await import('../../workflow/fixture')
    const repo = await makeRepo(root)
    write(join(repo, 'AGENTS.md'), '# Demo\n\n## Scoped rules\n\n')
    write(join(repo, '.claude', 'rules', 'web.md'), '---\npaths: ["src/**/*.tsx"]\n---\n')
    write(join(repo, '.claude', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review a diff\n---\n')
    write(join(repo, '.agents', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Deploy\n---\n')
    const spawned: string[] = []
    const d: CodexHookDeps = { ...deps(quiet), prepareWorkspace: async () => infoAt(repo), assetsSpawn: (argv, cwd) => { spawned.push(`${argv.slice(-4).join(' ')} @ ${cwd}`) } }
    const text = contextOf(await handleCodexHook('SessionStart', payload('SessionStart', { cwd: repo, source: 'startup' }), ctx(), d))
    expect(text).toContain('Buracle project rules (H28)')
    expect(text).toContain('- `.claude/rules/web.md` \u2014 `src/**/*.tsx`')
    expect(text).toContain('- `review`: Review a diff')
    expect(spawned).toEqual([`project sync --auto --quiet @ ${repo}`])
    const rule = join(repo, '.claude', 'rules', 'web.md')
    const patch = `*** Begin Patch\n*** Update File: ${rule}\n@@\n-paths: ["src/**/*.tsx"]\n+paths: ["src/**/*.tsx"]\n*** End Patch`
    const post = contextOf(await handleCodexHook('PostToolUse', payload('PostToolUse', { cwd: repo, tool_name: 'apply_patch', tool_input: { command: patch }, tool_response: 'Done' }), ctx({ ...defaultConfig(), checkers: { ...defaultConfig().checkers, enabled: false } }), d))
    expect(post).toContain('.claude/rules/web.md is not in AGENTS.md')
    const other = await makeRepo(root, 'other')
    write(join(other, '.agents', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Deploy\n---\n')
    saveWorkspaceInfo(ctx(), SID, infoAt(other))
    await handleCodexHook('Stop', payload('Stop', { cwd: other }), ctx(), d)
    expect(spawned).toEqual([`project sync --auto --quiet @ ${repo}`, `project sync --auto --quiet @ ${other}`])
  }))
})
