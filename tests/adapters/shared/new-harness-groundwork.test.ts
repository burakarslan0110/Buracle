import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { agentDirConflict, type AgentDirProbe } from '../../../src/adapters/shared/agent-dir'
import { adapter as agy } from '../../../src/adapters/agy/index'
import { adapter as pi } from '../../../src/adapters/pi/index'
import { adapter as qwen } from '../../../src/adapters/qwen/index'
import { allAdapters, type Adapter, type AdapterContext } from '../../../src/adapters/registry'
import { HOST_LIMITS, missingEventLimit } from '../../../src/adapters/shared/host-limits'
import { selfPaths } from '../../../src/adapters/shared/self-paths'
import { classifyTool, parseMcpName } from '../../../src/core/events'
import { CANONICAL_EVENTS, HARNESSES, harnessProfile, mcpToolName, mcpToolPattern, missingEvents, parseMcpToolName, type Harness } from '../../../src/core/harness/index'
import { checkWrite } from '../../../src/core/policy/write-guard'
import { denyJsonFor, failClosedOutcome, isGuardEvent } from '../../../src/engine/hook-fail'
import * as paths from '../../../src/engine/paths'
import { MIN_VERSIONS } from '../../../src/engine/update/min-versions'
import { COLLECTORS } from '../../../src/usage/index'
import { runnerArgv } from '../../../src/memory/runner'
import { fakeExe, narrowPath } from '../../helpers/fake-exe'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { fakeAdapter, fakeCli, makeRepo, memoryIO, withDeps } from '../../cli/ops/helpers'
import { run as installRun } from '../../../src/cli/commands/install'

const NEW = ['qwen', 'pi', 'agy'] as const
/** The harnesses whose adapter is still a stub. */
const PENDING = ['qwen', 'agy'] as const
const REPO = join(import.meta.dir, '..', '..', '..')
const read = (f: string) => readFileSync(join(REPO, f), 'utf8')

describe('Qwen Code, Pi and AGY CLI profiles', () => {
  test('they join the harness set after the four, each flagged as waiting for its adapter', () => {
    expect([...HARNESSES].slice(4)).toEqual([...NEW])
    for (const h of PENDING) expect({ h, pending: harnessProfile(h).adapterPending }).toEqual({ h, pending: true })
    // Pi has its adapter (task 6.2), so it no longer waits for one.
    for (const h of [...HARNESSES.slice(0, 4), 'pi' as const]) expect(harnessProfile(h).adapterPending).toBeUndefined()
  })

  test('Qwen: the tool ids classify, in both spellings of the ask, plan and todo tools', () => {
    const k = (tool: string, input: Record<string, unknown> = {}) => classifyTool('qwen', tool, input, '/w').kind
    expect(k('run_shell_command', { command: 'ls' })).toBe('bash')
    expect(k('monitor', { command: 'tail -f x' })).toBe('bash')
    expect(k('edit', { file_path: 'a.ts' })).toBe('edit')
    expect(k('write_file', { file_path: 'a.ts' })).toBe('write')
    expect(k('read_file', { file_path: 'a.ts' })).toBe('read')
    for (const t of ['glob', 'grep_search', 'list_directory']) expect(k(t)).toBe('search')
    expect([k('web_search'), k('web_fetch')]).toEqual(['web_search', 'web_fetch'])
    expect([k('AskUserQuestion'), k('ask_user_question')]).toEqual(['ask_user', 'ask_user'])
    expect([k('ExitPlanMode'), k('exit_plan_mode')]).toEqual(['plan_exit', 'plan_exit'])
    expect([k('TodoWrite'), k('todo_write')]).toEqual(['todo', 'todo'])
    expect(k('agent')).toBe('agent')
    expect(k('something_new')).toBe('other')
  })

  test('Qwen: MCP tools are mcp__<server>__<tool>, with - kept and other characters written as _', () => {
    const d = harnessProfile('qwen').mcp
    expect(mcpToolName(d, 'web-search', 'search')).toBe('mcp__web-search__search')
    expect(mcpToolName(d, 'context7', 'query docs')).toBe('mcp__context7__query_docs')
    expect(mcpToolPattern(d, 'web-search')).toBe('mcp__web-search__*')
    expect(parseMcpToolName(d, 'mcp__web-search__search', ['web', 'web-search'])).toEqual({ server: 'web-search', tool: 'search' })
    expect(parseMcpName('qwen', 'mcp__other__go')).toEqual({ server: 'other', tool: 'go' })
    expect(classifyTool('qwen', 'mcp__context7__query-docs', {}, '/w', ['context7'])).toMatchObject({ kind: 'mcp', mcp: { server: 'context7', tool: 'query-docs' } })
  })

  test('Pi: bash, edit, write, read and the search tools classify; codemode is a shell; the rest is other', () => {
    const k = (tool: string, input: Record<string, unknown> = {}) => classifyTool('pi', tool, input, '/w').kind
    expect(k('bash', { command: 'ls' })).toBe('bash')
    expect(k('codemode', { code: 'x' })).toBe('eval')
    expect(k('edit', { path: 'a.ts' })).toBe('edit')
    expect(k('write', { path: 'a.ts' })).toBe('write')
    expect(k('read', { path: 'a.ts' })).toBe('read')
    for (const t of ['grep', 'find', 'ls']) expect(k(t)).toBe('search')
    expect(k('web_search')).toBe('other')
  })

  test('Pi: MCP tools are mcp__<server>__<tool> with every character other than a letter, digit or _ written as _', () => {
    const d = harnessProfile('pi').mcp
    expect(mcpToolName(d, 'web-search', 'search')).toBe('mcp__web_search__search')
    expect(mcpToolName(d, 'chrome-devtools', 'take_snapshot')).toBe('mcp__chrome_devtools__take_snapshot')
    expect(parseMcpToolName(d, 'mcp__web_search__search', ['web', 'web-search'])).toEqual({ server: 'web-search', tool: 'search' })
    expect(parseMcpToolName(d, 'bash')).toBeUndefined()
    expect(classifyTool('pi', 'mcp__codegraph__codegraph_explore', {}, '/w', ['codegraph'])).toMatchObject({ kind: 'mcp', mcp: { server: 'codegraph', tool: 'codegraph_explore' } })
  })

  test('AGY: run_command, the file tools and the web tools classify', () => {
    const k = (tool: string, input: Record<string, unknown> = {}) => classifyTool('agy', tool, input, '/w').kind
    expect(k('run_command', { CommandLine: 'ls' })).toBe('bash')
    expect(k('write_to_file', { TargetFile: '/w/a.ts' })).toBe('write')
    expect([k('replace_file_content'), k('multi_replace_file_content')]).toEqual(['edit', 'edit'])
    expect([k('view_file'), k('view_file_outline')]).toEqual(['read', 'read'])
    for (const t of ['list_dir', 'grep_search', 'find_by_name', 'codebase_search']) expect(k(t)).toBe('search')
    expect([k('search_web'), k('read_url_content')]).toEqual(['web_search', 'web_fetch'])
    expect(k('invoke_subagent')).toBe('agent')
  })

  test('AGY: the MCP name shape is pinned until a real session confirms it; it writes and reads back', () => {
    const d = harnessProfile('agy').mcp
    expect(mcpToolName(d, 'web-search', 'search')).toBe('mcp_web_search_search')
    expect(parseMcpToolName(d, 'mcp_web_search_search', ['web', 'web-search'])).toEqual({ server: 'web-search', tool: 'search' })
    expect(parseMcpToolName(d, 'mcp__web_search__search')).toBeUndefined()
  })

  test('the minimum versions are plain releases the hosts were checked on (Qwen: the first line with `qwen plugins`)', () => {
    expect([MIN_VERSIONS.qwen, MIN_VERSIONS.pi, MIN_VERSIONS.agy]).toEqual(['1.0.0', '1.5.2', '1.5.9'])
  })

  test('the config folders: QWEN_HOME and PI_CODING_AGENT_DIR relocate theirs, AGY has one fixed folder', () => withSandbox(({ home }) => {
    expect([paths.harnessConfigDir('qwen'), paths.harnessConfigDir('pi'), paths.harnessConfigDir('agy')]).toEqual([join(home, '.qwen'), join(home, '.pi', 'agent'), join(home, '.gemini', 'config')])
    return withEnv({ QWEN_HOME: join(home, 'q'), PI_CODING_AGENT_DIR: join(home, 'shared') }, () => {
      expect(paths.qwenHome()).toBe(join(home, 'q'))
      expect(paths.piAgentDir()).toBe(join(home, 'shared'))
      expect(paths.ompAgentDir()).toBe(join(home, 'shared'))
      expect(paths.agentDirShared()).toBe(join(home, 'shared'))
    })
  }))
})

describe('the event maps and the host limits', () => {
  test('Qwen and Pi map every canonical event; AGY lacks two, and both have their record', () => {
    expect(missingEvents(harnessProfile('qwen'))).toEqual([])
    expect(missingEvents(harnessProfile('pi'))).toEqual([])
    expect(missingEvents(harnessProfile('agy'))).toEqual(['preCompact', 'sessionEnd'])
    expect(missingEventLimit('agy', 'preCompact')?.id).toBe('agy.no-compaction-event')
    expect(missingEventLimit('agy', 'sessionEnd')?.id).toBe('agy.no-session-end')
    for (const h of NEW) for (const e of CANONICAL_EVENTS) {
      const names = harnessProfile(h).events.map[e]
      expect({ h, e, recorded: missingEventLimit(h, e) !== undefined }).toEqual({ h, e, recorded: names === null })
    }
  })

  test('Pi has no session_stop: its stop guard runs on agent_before_settle, which may ask for one more turn', () => {
    expect(harnessProfile('pi').events.map.stop).toEqual(['agent_before_settle'])
    expect(harnessProfile('pi').events.native).not.toContain('session_stop')
  })

  test('AGY: PreCompact and SessionEnd are null in the event map, and the compaction hooks are unsupported cells', () => {
    const raw = parseYaml(read('canonical/hooks.yaml')) as { hooks: Array<{ id: string, bindings: Record<string, Record<string, unknown>> }> }
    const cell = (id: string, h: Harness) => raw.hooks.find(x => x.id === id)?.bindings[h]
    expect(cell('H06', 'agy')).toHaveProperty('unsupported')
    expect(cell('H07', 'agy')).toHaveProperty('unsupported')
    expect(HOST_LIMITS.filter(l => l.harness === 'agy').map(l => l.event).sort()).toEqual(['preCompact', 'sessionEnd'])
  })

  test('Pi: the tool table has no question, plan or subagent tool, so the hooks that need one are unsupported cells', () => {
    const raw = parseYaml(read('canonical/hooks.yaml')) as { hooks: Array<{ id: string, bindings: Record<string, Record<string, unknown>> }> }
    const unsupported = raw.hooks.filter(h => 'unsupported' in (h.bindings['pi'] ?? {})).map(h => h.id)
    expect(unsupported).toEqual(['H09', 'H12', 'H19'])
    const kinds = new Set(Object.values(harnessProfile('pi').tools.kinds))
    for (const kind of ['ask_user', 'plan_exit', 'plan_enter', 'agent'] as const) expect(kinds.has(kind)).toBe(false)
  })

  test('AGY: no binding is async, and a failed guard answers with the decision shape AGY reads', () => {
    const raw = parseYaml(read('canonical/hooks.yaml')) as { hooks: Array<{ id: string, bindings: Record<string, { async?: boolean, also?: Array<{ async?: boolean }> }> }> }
    for (const h of raw.hooks) {
      const b = h.bindings['agy']
      expect({ id: h.id, async: [b?.async, ...(b?.also ?? []).map(a => a.async)].some(x => x === true) }).toEqual({ id: h.id, async: false })
    }
    expect(JSON.parse(denyJsonFor('agy', 'no'))).toEqual({ decision: 'deny', reason: 'no' })
    expect(JSON.parse(denyJsonFor('qwen', 'no'))).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } })
    expect(isGuardEvent('qwen', 'PreToolUse')).toBe(true)
    expect(isGuardEvent('agy', 'PreToolUse')).toBe(true)
    expect(isGuardEvent('pi', 'tool_call')).toBe(false)
    expect(JSON.parse(failClosedOutcome('agy', 'PreToolUse', 'boom')?.stdout ?? '{}')).toMatchObject({ decision: 'deny' })
    expect(failClosedOutcome('agy', 'Stop', 'boom')).toBeUndefined()
  })

  test('every hook has a cell for each of the three, and the events they name are real native events', () => {
    const raw = parseYaml(read('canonical/hooks.yaml')) as { hooks: Array<{ id: string, bindings: Record<string, { event?: string, also?: Array<{ event: string }> }> }> }
    for (const h of raw.hooks) for (const name of NEW) {
      const b = h.bindings[name]
      expect({ id: h.id, name, present: b !== undefined }).toEqual({ id: h.id, name, present: true })
      for (const ev of [b?.event, ...(b?.also ?? []).map(a => a.event)]) if (ev !== undefined) expect({ id: h.id, name, ev, native: harnessProfile(name).events.native.includes(ev) }).toEqual({ id: h.id, name, ev, native: true })
    }
  })
})

describe('the stub adapters', () => {
  const STUBS: Record<(typeof PENDING)[number], Adapter> = { qwen, agy }
  const ctx = (): AdapterContext => ({ repoRoot: REPO, config: undefined as never, canonical: undefined as never, paths, buracleBin: '/x/buracle' })

  test('the registry holds them after the four, in profile order', () => {
    expect(allAdapters().slice(4).map(a => a.harness)).toEqual([...NEW])
    for (const h of PENDING) expect(allAdapters().find(a => a.harness === h)).toBe(STUBS[h])
    expect(allAdapters().find(a => a.harness === 'pi')).toBe(pi)
  })

  test('build and the install plan are empty; doctor answers one warning', async () => {
    for (const h of PENDING) {
      const a = STUBS[h]
      expect(await a.build(ctx())).toEqual([])
      expect(await a.installPlan(ctx())).toEqual({ id: h, harness: h, ops: [] })
      expect(a.uninstallPlan).toBeUndefined()
      expect(a.hook).toBeUndefined()
      expect(await a.doctor(ctx())).toEqual([{ level: 'warn', check: `${h}.support`, detail: `Buracle support for ${harnessProfile(h).label} is not installed yet` }])
    }
  })

  test('detect finds each program on PATH and its version', () => withSandbox(async ({ root }) => {
    const bin = join(root, 'bin')
    const outputs: Record<string, string> = { qwen: '1.0.0-preview.1', pi: '1.5.2', agy: '1.5.9' }
    const adapters: Record<(typeof NEW)[number], Adapter> = { qwen, pi, agy }
    const exe = Object.fromEntries(Object.entries(outputs).map(([name, out]) => [name, fakeExe(join(bin, name), `console.log(${JSON.stringify(out)})`)]))
    await withEnv({ PATH: narrowPath(bin) }, async () => {
      for (const h of NEW) expect(await adapters[h].detect()).toEqual({ installed: true, version: outputs[h] as string, path: exe[h] as string })
    })
    await withEnv({ PATH: join(root, 'empty') }, async () => {
      for (const h of NEW) expect(await adapters[h].detect()).toEqual({ installed: false })
    })
  }))

  test('an install run over them writes nothing into any host folder', () => withSandbox(async ({ root, home }) => {
    const bin = join(root, 'bin')
    for (const name of PENDING) fakeExe(join(bin, name), 'console.log("1.0.0")')
    const repo = makeRepo(root)
    await withEnv({ PATH: narrowPath(bin) }, () => withDeps({ repoRoot: () => repo, adapters: async () => [qwen, agy, fakeAdapter('claude', { installed: false })], runCli: fakeCli().runCli }, async () => {
      const io = memoryIO({ json: true })
      expect(await installRun(['--yes', '--json'], io)).toBe(0)
      for (const dir of ['.qwen', '.pi', '.gemini']) expect({ dir, exists: existsSync(join(home, dir)) }).toEqual({ dir, exists: false })
      const result = JSON.parse(io.out()) as { harnesses: Array<{ harness: string, ops?: unknown }> }
      for (const name of PENDING) expect({ name, listed: result.harnesses.some(h => h.harness === name) }).toEqual({ name, listed: true })
    }))
  }))

  test('the usage collectors answer an entry with no windows; the memory runner has an argv for Qwen and Pi, and AGY has none', async () => {
    for (const h of NEW) expect(await COLLECTORS[h]({ nowMs: 0 })).toEqual({ harness: h, computed_at: new Date(0).toISOString(), windows: [] })
    expect(runnerArgv('qwen', 'm1')).toEqual(['qwen', '-p', '--model', 'm1', '--no-session-persistence', '--tools', ''])
    expect(runnerArgv('pi')).toEqual(['pi', '-p', '--no-session', '--no-tools', '--no-skills', '--no-extensions', '--no-mcp', '--no-prompt-templates', '--no-context-files'])
    expect(harnessProfile('agy').noStdinPrint).toBe(true)
    const { harnessRunner } = await import('../../../src/memory/runner')
    expect(await harnessRunner('agy')('hi', { maxOutputTokens: 10, timeoutMs: 1000 })).toMatchObject({ ok: false, unavailable: true })
  })
})

describe('Pi and omp read one PI_CODING_AGENT_DIR', () => {
  const probe = (shared: string | undefined, installed: string[]): AgentDirProbe => ({ shared: () => shared, installed: async bin => installed.includes(bin) })

  test('each has its own default folder, so nothing conflicts without the variable', async () => {
    expect(await agentDirConflict(probe(undefined, ['pi', 'omp']))).toBeUndefined()
  })

  test('with the variable set, a conflict needs both hosts installed; omp keeps the folder and Pi is left out', async () => {
    expect(await agentDirConflict(probe('/d', ['pi']))).toBeUndefined()
    expect(await agentDirConflict(probe('/d', ['omp']))).toBeUndefined()
    const c = await agentDirConflict(probe('/d', ['pi', 'omp']))
    expect(c).toMatchObject({ dir: '/d', skipped: 'pi' })
    expect(c?.message).toContain('PI_CODING_AGENT_DIR points Pi and Oh My Pi at one folder (/d)')
  })

  test('the Pi doctor reports only the conflict (and writes nothing)', () => withSandbox(async ({ root, home }) => {
    const bin = join(root, 'bin')
    fakeExe(join(bin, 'pi'), 'console.log("1.5.2")')
    fakeExe(join(bin, 'omp'), 'console.log("omp/18.8.3")')
    await withEnv({ PATH: narrowPath(bin), PI_CODING_AGENT_DIR: join(home, 'shared') }, async () => {
      const rows = await pi.doctor({ repoRoot: REPO, config: undefined as never, canonical: undefined as never, paths, buracleBin: '/x' })
      expect(rows.map(r => r.check)).toEqual(['pi.agent-dir'])
      expect(rows[0]?.level).toBe('warn')
      expect(existsSync(join(home, 'shared'))).toBe(false)
    })
  }))
})

describe('the shared guards know the three folders', () => {
  test('self-protection covers each host\'s configuration, and the paths source names them', () => withSandbox(({ home }) => {
    const self = selfPaths()
    expect([self.qwenHome, self.piAgentDir, self.agyDir]).toEqual([join(home, '.qwen'), join(home, '.pi', 'agent'), join(home, '.gemini', 'config')])
    const ctx = { cwd: join(home, 'proj'), home, vault: join(home, 'Documents', 'Buracle'), protect: [] as string[], selfPaths: self }
    for (const f of [join(home, '.qwen', 'settings.json'), join(home, '.pi', 'agent', 'extensions', 'x.ts'), join(home, '.gemini', 'config', 'hooks.json')]) {
      expect({ f, denied: checkWrite([f], ctx).deny !== undefined }).toEqual({ f, denied: true })
    }
    expect(checkWrite([join(home, 'proj', 'a.ts')], ctx)).toEqual({})
  }))
})
