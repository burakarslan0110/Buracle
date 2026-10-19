import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeHook, defaultHookDeps, GUARD_FAILED, readConsent, type HookDeps } from '../../../src/adapters/claude/hook'
import { CM_POST_ONLY_TOOLS } from '../../../src/adapters/claude/hook-cm'
import type { AdapterContext } from '../../../src/adapters/registry'
import type { CmForwardResult } from '../../../src/adapters/shared/context-mode/bridge'
import { cmRunOp } from '../../../src/adapters/shared/context-mode/session'
import type { CanonicalBundle } from '../../../src/core/catalog'
import { defaultConfig, type BuracleConfig } from '../../../src/core/config'
import { CM_RESTORE_MAX_BYTES, cmPromptEvent, cmToolEvent, type CmEvent } from '../../../src/core/context-mode'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import { cmSessionsDir, cmStorageRoot } from '../../../src/engine/context-mode'
import * as paths from '../../../src/engine/paths'
import { loadLedger } from '../../../src/workflow/ledger'
import { installCmFixture } from '../../fixtures/context-mode/fixture'
import { withEnv, withSandbox } from '../../helpers/sandbox'

const SID = 'sess-cm-1'
const NOW = 1_800_000_000_000
const REPO = join(import.meta.dir, '..', '..', '..')
const CWD = '/tmp/project'
let bundle: CanonicalBundle | undefined

const CM = (tool: string): string => `mcp__plugin_buracle_context-mode__${tool}`

function config(over: (c: BuracleConfig) => void = () => undefined): BuracleConfig {
  const c = defaultConfig()
  over(c)
  return c
}

function ctx(cfg: BuracleConfig = defaultConfig()): AdapterContext {
  return {
    repoRoot: REPO, config: cfg, paths, buracleBin: paths.shimPath(),
    get canonical(): CanonicalBundle { return (bundle ??= loadCanonicalSync(join(REPO, 'canonical'))) },
  }
}

interface Forwarded { event: string; payload: Record<string, unknown>; maxBytes?: number }

function stubBridge(answer: (event: string, opts?: { maxBytes?: number }) => CmForwardResult = () => ({ action: 'none', skipped: 'stub' })): { calls: Forwarded[], cmForward: HookDeps['cmForward'] } {
  const calls: Forwarded[] = []
  return {
    calls,
    cmForward: async (event, payload, _ctx, opts) => {
      calls.push({ event, payload, ...(opts?.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}) })
      return answer(event, opts)
    },
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
  return JSON.stringify({ session_id: SID, cwd: CWD, hook_event_name: event, transcript_path: '/tmp/t.jsonl', permission_mode: 'bypassPermissions', ...extra })
}

function pre(tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return payload('PreToolUse', { tool_name: CM(tool), tool_input: input, ...extra })
}

function hookOut(stdout: string): Record<string, unknown> {
  return stdout === '' ? {} : (JSON.parse(stdout) as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput ?? {}
}

function reason(stdout: string): string {
  return String(hookOut(stdout)['permissionDecisionReason'] ?? '')
}

function context(stdout: string): string {
  return String(hookOut(stdout)['additionalContext'] ?? '')
}

describe('PreToolUse: the sandbox guards for context-mode calls (H01/H02, any strictness, fail closed)', () => {
  test('dangerous shell, unknown and hidden tools, unreadable calls and unreadable languages are denied with the guard that refused them', async () => {
    await withSandbox(async sb => {
      const denied: Array<[string, Record<string, unknown>, string, string]> = [
        ['ctx_execute', { language: 'shell', code: 'rm -rf ~' }, 'Buracle H01 (guard.bash): ', 'rm -rf'],
        ['ctx_batch_execute', { commands: [{ label: 'list', command: 'ls' }, { label: 'wipe', command: 'rm -rf /' }], queries: ['x'] }, 'Buracle H01 (guard.bash): ', 'rm -rf'],
        ['ctx_upgrade', {}, 'Buracle H01 (guard.bash): ', '`buracle update --yes context-mode`'],
        ['ctx_doctor', {}, 'Buracle H01 (guard.bash): ', '`buracle doctor context-mode`'],
        ['ctx_shell_session', { code: 'ls' }, 'Buracle H01 (guard.bash): ', 'does not know'],
        ['ctx_execute', { language: 'shell', code: 'ls', env: { PATH: '/tmp' } }, 'Buracle H01 (guard.bash): ', 'the input field `env`'],
        ['ctx_execute', { language: 'go', code: 'package main' }, 'Buracle H01 (guard.bash): ', 'run it as shell, JavaScript or Python'],
        ['ctx_execute_file', { path: join(sb.home, '.ssh', 'id_ed25519'), language: 'shell', code: 'wc -l' }, 'Buracle H02 (guard.write): ', 'search index'],
        ['ctx_execute', { language: 'shell', code: "apply_patch '*** Begin Patch'" }, 'Buracle H02 (guard.write): ', 'apply_patch'],
      ]
      for (const strictness of ['enforce', 'nudge', 'off'] as const) {
        const c = ctx(config(x => { x.routing.strictness = strictness }))
        for (const [tool, input, prefix, needle] of denied) {
          const r = await claudeHook('PreToolUse', pre(tool, input), c, deps())
          const out = hookOut(r.stdout)
          expect({ strictness, tool, decision: out['permissionDecision'], updated: out['updatedInput'] }).toEqual({ strictness, tool, decision: 'deny', updated: undefined })
          expect(reason(r.stdout)).toStartWith(prefix)
          expect(reason(r.stdout)).toContain(needle)
        }
      }
    })
  })

  test('H01 lane guard: a subagent cannot change the lead\'s plan state through context-mode either; the lead and read-only commands can', async () => {
    await withSandbox(async () => {
      const lane = { agent_id: 'agent-1', agent_type: 'general-purpose' }
      for (const input of [
        { language: 'shell', code: 'buracle plan resume' },
        { language: 'javascript', code: "require('child_process').execSync('buracle plan pause --kind decision')" },
      ]) {
        const r = await claudeHook('PreToolUse', pre('ctx_execute', input, lane), ctx(), deps())
        expect({ language: input.language, decision: hookOut(r.stdout)['permissionDecision'] }).toEqual({ language: input.language, decision: 'deny' })
        expect(reason(r.stdout)).toContain('Buracle lane guard')
      }
      const batch = await claudeHook('PreToolUse', pre('ctx_batch_execute', { commands: [{ label: 'st', command: 'buracle plan status --json' }, { label: 'sync', command: 'buracle worktree sync x' }], queries: ['x'] }, lane), ctx(), deps())
      expect(reason(batch.stdout)).toContain('`buracle worktree sync`')
      expect(hookOut((await claudeHook('PreToolUse', pre('ctx_execute', { language: 'shell', code: 'buracle plan status --json' }, lane), ctx(), deps())).stdout)['permissionDecision']).toBeUndefined()
      expect(hookOut((await claudeHook('PreToolUse', pre('ctx_execute', { language: 'shell', code: 'buracle plan resume' }), ctx(), deps())).stdout)['permissionDecision']).toBeUndefined()
    })
  })

  test('review bypass A: code told to run in another folder is judged there (a relative delete from / is refused)', async () => {
    await withSandbox(async () => {
      for (const input of [
        { language: 'python', code: "import shutil; shutil.rmtree('usr')", cwd: '/' },
        { language: 'javascript', code: "require('fs').rmSync('Users', { recursive: true, force: true })", cwd: '/' },
      ]) {
        const r = await claudeHook('PreToolUse', pre('ctx_execute', input), ctx(), deps())
        expect({ language: input.language, decision: hookOut(r.stdout)['permissionDecision'] }).toEqual({ language: input.language, decision: 'deny' })
        expect(reason(r.stdout)).toStartWith('Buracle H01 (guard.bash): ')
      }
      const own = await claudeHook('PreToolUse', pre('ctx_execute', { language: 'python', code: "import shutil; shutil.rmtree('usr')" }), ctx(), deps())
      expect(hookOut(own.stdout)).toEqual({ hookEventName: 'PreToolUse', updatedInput: { language: 'python', code: "import shutil; shutil.rmtree('usr')", cwd: CWD } })
    })
  })

  test("review bypass B: a cwd naming Buracle's checkout from an unrelated project keeps the checkout protected", async () => {
    await withSandbox(async sb => {
      const proj = join(sb.root, 'proj')
      mkdirSync(proj, { recursive: true })
      const repo = paths.repoRoot()
      for (const input of [
        { language: 'shell', code: 'echo x > package.json', cwd: repo },
        { language: 'python', code: "open('src/cli/main.ts', 'w').write('x')", cwd: repo },
      ]) {
        const r = await claudeHook('PreToolUse', pre('ctx_execute', input, { cwd: proj }), ctx(), deps())
        expect(reason(r.stdout)).toContain("Buracle's own source code")
      }
      const batch = await claudeHook('PreToolUse', pre('ctx_batch_execute', { commands: ['git status', 'cp /tmp/evil.ts src/cli/main.ts'], queries: ['x'], cwd: repo }, { cwd: proj }), ctx(), deps())
      expect(reason(batch.stdout)).toContain("Buracle's own source code")
    })
  }, 20_000)

  test('a call without cwd is judged in the pinned session folder and in the server folder (CLAUDE_PROJECT_DIR)', async () => {
    await withSandbox(async sb => {
      const proj = join(sb.root, 'proj')
      mkdirSync(proj, { recursive: true })
      const code = "import shutil; shutil.rmtree('usr')"
      const call = pre('ctx_execute', { language: 'python', code }, { cwd: proj })
      const atRoot = deps({ env: n => (n === 'CLAUDE_PROJECT_DIR' ? '/' : undefined) })
      expect(reason((await claudeHook('PreToolUse', call, ctx(), atRoot)).stdout)).toStartWith('Buracle H01 (guard.bash): ')
      const file = pre('ctx_execute_file', { path: 'notes.txt', language: 'python', code }, { cwd: proj })
      expect(reason((await claudeHook('PreToolUse', file, ctx(), atRoot)).stdout)).toStartWith('Buracle H01 (guard.bash): ')
      for (const d of [deps({ env: n => (n === 'CLAUDE_PROJECT_DIR' ? proj : undefined) }), deps()]) {
        expect(hookOut((await claudeHook('PreToolUse', call, ctx(), d)).stdout)).toEqual({ hookEventName: 'PreToolUse', updatedInput: { language: 'python', code, cwd: proj } })
      }
    })
  })

  test('the guard fails closed: a throwing checkSandbox denies the call', async () => {
    await withSandbox(async () => {
      const r = await claudeHook('PreToolUse', pre('ctx_execute', { language: 'shell', code: 'ls' }), ctx(), deps({ core: { ...defaultHookDeps.core, checkSandbox: () => { throw new Error('boom') } } }))
      expect(hookOut(r.stdout)).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: GUARD_FAILED })
    })
  })

  test("the names are recognized without the plugin's server list, and in another plugin's spelling (R9)", async () => {
    await withSandbox(async sb => {
      const empty = join(sb.root, 'empty-plugin')
      mkdirSync(empty, { recursive: true })
      const noServers = deps({ env: n => (n === 'CLAUDE_PLUGIN_ROOT' ? empty : undefined) })
      expect(reason((await claudeHook('PreToolUse', pre('ctx_execute', { language: 'shell', code: 'rm -rf ~' }), ctx(), noServers)).stdout)).toStartWith('Buracle H01 (guard.bash): ')
      const other = payload('PreToolUse', { tool_name: 'mcp__plugin_cm_context-mode__ctx_batch_execute', tool_input: { commands: ['rm -rf ~'], queries: ['x'] } })
      expect(reason((await claudeHook('PreToolUse', other, ctx(), deps())).stdout)).toStartWith('Buracle H01 (guard.bash): ')
    })
  })

  test('the tools that run nothing pass the guards untouched (no pin, nothing to say)', async () => {
    await withSandbox(async () => {
      for (const [tool, input] of [['ctx_search', { queries: ['auth flow'] }], ['ctx_stats', {}], ['ctx_index', { content: 'notes', source: 'notes' }]] as const) {
        expect({ tool, out: await claudeHook('PreToolUse', pre(tool, input), ctx(), deps()) }).toEqual({ tool, out: { stdout: '', exitCode: 0 } })
      }
    })
  })
})

describe('PreToolUse: the reviewers stay read-only in the sandbox', () => {
  const sub = (tool: string, input: Record<string, unknown>) => pre(tool, input, { agent_id: 'a1', agent_type: 'buracle:changes-review' })

  test('search and read-only shell commands are fine; code, writes and tools that change the index are denied', async () => {
    await withSandbox(async () => {
      expect((await claudeHook('PreToolUse', sub('ctx_search', { queries: ['x'] }), ctx(), deps())).stdout).toBe('')
      const read = await claudeHook('PreToolUse', sub('ctx_batch_execute', { commands: ['git diff main...HEAD'], queries: ['x'] }), ctx(), deps())
      expect(hookOut(read.stdout)['permissionDecision']).toBeUndefined()
      for (const [tool, input] of [
        ['ctx_batch_execute', { commands: ['echo x > notes.txt'], queries: ['x'] }],
        ['ctx_execute', { language: 'python', code: 'print(1)' }],
        ['ctx_index', { content: 'x', source: 'x' }],
      ] as const) {
        const r = await claudeHook('PreToolUse', sub(tool, input), ctx(), deps())
        expect({ tool, decision: hookOut(r.stdout)['permissionDecision'] }).toEqual({ tool, decision: 'deny' })
        expect(reason(r.stdout)).toContain('read-only reviewer')
      }
    })
  })
})

describe('PreToolUse: H20 judges every command a context-mode call runs', () => {
  const batch = (...commands: string[]) => pre('ctx_batch_execute', { commands: commands.map((command, i) => ({ label: `c${i}`, command })), queries: ['x'] })

  test('a push inside a batch is held for the user; after a yes the whole batch runs and uses the grant once', async () => {
    await withSandbox(async () => {
      const denied = await claudeHook('PreToolUse', batch('git status', 'git push origin feature'), ctx(), deps())
      expect(reason(denied.stdout)).toStartWith('Buracle H20 (consent.gate): ')
      expect(reason(denied.stdout)).toContain('git push origin feature')
      expect(readConsent(SID).pending?.kind).toBe('push')
      await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'yes' }), ctx(), deps())
      const uses = readConsent(SID).grants.find(g => g.kind === 'push')?.uses ?? 0
      expect(uses).toBeGreaterThan(1)
      const allowed = await claudeHook('PreToolUse', batch('git status', 'git push origin feature'), ctx(), deps())
      expect(hookOut(allowed.stdout)['permissionDecision']).toBeUndefined()
      expect(readConsent(SID).grants.find(g => g.kind === 'push')?.uses).toBe(uses - 1)
    })
  })

  test('nothing is used up unless every command may run; ctx_purge needs consent like a database drop', async () => {
    await withSandbox(async () => {
      await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'push it to origin' }), ctx(), deps())
      const before = readConsent(SID).grants.find(g => g.kind === 'push')?.uses
      expect(before).toBeDefined()
      const mixed = await claudeHook('PreToolUse', batch('git push origin feature', 'git reset --hard HEAD~1'), ctx(), deps())
      expect(reason(mixed.stdout)).toContain('git reset --hard HEAD~1')
      expect(readConsent(SID).grants.find(g => g.kind === 'push')?.uses).toBe(before)
      const purge = await claudeHook('PreToolUse', pre('ctx_purge', { confirm: true }), ctx(), deps())
      expect(reason(purge.stdout)).toStartWith('Buracle H20 (consent.gate): ')
      expect(reason(purge.stdout)).toContain('ctx_purge --scope project')
      expect((await claudeHook('PreToolUse', pre('ctx_purge', {}), ctx(), deps())).stdout).toBe('')
    })
  })
})

describe('PreToolUse: the cwd pin of ctx_execute and ctx_batch_execute', () => {
  test('a call without cwd runs in the session folder: updatedInput with the input as it was plus cwd, and no permission decision', async () => {
    await withSandbox(async () => {
      const exec = await claudeHook('PreToolUse', pre('ctx_execute', { language: 'shell', code: 'bun test 2>&1 | tail -5', timeout: 60000 }), ctx(), deps())
      expect(JSON.parse(exec.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { language: 'shell', code: 'bun test 2>&1 | tail -5', timeout: 60000, cwd: CWD } } })
      const commands = [{ label: 'tests', command: 'bun test' }]
      const b = await claudeHook('PreToolUse', pre('ctx_batch_execute', { commands, queries: ['fail'] }), ctx(), deps())
      expect(JSON.parse(b.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { commands, queries: ['fail'], cwd: CWD } } })
    })
  })

  test('a call that names its cwd, and ctx_execute_file (no cwd parameter), are left as they are', async () => {
    await withSandbox(async () => {
      expect((await claudeHook('PreToolUse', pre('ctx_execute', { language: 'shell', code: 'ls', cwd: 'src' }), ctx(), deps())).stdout).toBe('')
      expect((await claudeHook('PreToolUse', pre('ctx_execute_file', { path: 'build.log', language: 'shell', code: 'wc -l' }), ctx(), deps())).stdout).toBe('')
    })
  })

  test('the pin rides along with the usage gate\'s context, and with no context when that step fails', async () => {
    await withSandbox(async () => {
      await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'why did we pick bun over node last time?' }), ctx(), deps())
      const r = await claudeHook('PreToolUse', pre('ctx_execute', { language: 'shell', code: 'git log --oneline | head -5' }), ctx(), deps())
      const out = hookOut(r.stdout)
      expect(out['permissionDecision']).toBeUndefined()
      expect(out['updatedInput']).toEqual({ language: 'shell', code: 'git log --oneline | head -5', cwd: CWD })
      expect(String(out['additionalContext'])).toContain('asks about earlier work')
      const broken = 'sess-cm-broken'
      mkdirSync(join(paths.sessionDir('claude', broken), '..'), { recursive: true })
      writeFileSync(paths.sessionDir('claude', broken), 'not a folder')
      const r2 = await claudeHook('PreToolUse', JSON.stringify({ session_id: broken, cwd: CWD, tool_name: CM('ctx_execute'), tool_input: { language: 'shell', code: 'ls' } }), ctx(), deps())
      expect(JSON.parse(r2.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { language: 'shell', code: 'ls', cwd: CWD } } })
      expect(readFileSync(paths.logFile(), 'utf8')).toContain('claude hook: H24 usage failed')
    })
  })
})

describe('contextMode.enabled false: context-mode is down for routing, the router, the reminders and the card', () => {
  const off = (): AdapterContext => ctx(config(c => { c.contextMode.enabled = false }))

  test('the capability card, the WebFetch redirect, the curl hint and the prompt router stop naming it', async () => {
    await withSandbox(async () => {
      const card = async (c: AdapterContext) => context((await claudeHook('SessionStart', payload('SessionStart', { source: 'resume' }), c, deps())).stdout)
      expect(await card(ctx())).toContain('\n- context-mode: ')
      expect(await card(off())).not.toContain('context-mode')
      const fetch = payload('PreToolUse', { tool_name: 'WebFetch', tool_input: { url: 'https://example.com/guide', prompt: 'x' } })
      expect(reason((await claudeHook('PreToolUse', fetch, ctx(), deps())).stdout)).toContain(CM('ctx_fetch_and_index'))
      const offFetch = reason((await claudeHook('PreToolUse', fetch, off(), deps())).stdout)
      expect(offFetch).toContain('mcp__plugin_buracle_web-fetch__fetch_url')
      expect(offFetch).not.toContain('context-mode')
      const curl = payload('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'curl https://example.com/api/items' } })
      expect(context((await claudeHook('PreToolUse', curl, ctx(), deps())).stdout)).toContain(CM('ctx_fetch_and_index'))
      expect((await claudeHook('PreToolUse', curl, off(), deps())).stdout).toBe('')
      const prompt = payload('UserPromptSubmit', { prompt: 'please analyze the test output of the last run' })
      expect(context((await claudeHook('UserPromptSubmit', prompt, ctx(), deps())).stdout)).toContain('context-mode sandbox')
      expect(context((await claudeHook('UserPromptSubmit', prompt, off(), deps())).stdout)).not.toContain('context-mode')
    })
  })

  test('the guards stay on while it is switched off', async () => {
    await withSandbox(async () => {
      const r = await claudeHook('PreToolUse', pre('ctx_execute', { language: 'shell', code: 'rm -rf ~' }), off(), deps())
      expect(reason(r.stdout)).toStartWith('Buracle H01 (guard.bash): ')
    })
  })
})

describe('H24: a failing execution call is its code\'s failure, not the server\'s', () => {
  test('two failing ctx_execute calls leave context-mode up; two failing ctx_search calls mark it down for the session', async () => {
    await withSandbox(async () => {
      const failure = (tool: string) => payload('PostToolUseFailure', { tool_name: CM(tool), tool_input: { language: 'shell', code: 'exit 1', queries: ['x'] }, error: 'MCP error: exit code 1' })
      for (let i = 0; i < 2; i++) await claudeHook('PostToolUseFailure', failure('ctx_execute'), ctx(), deps())
      for (let i = 0; i < 2; i++) await claudeHook('PostToolUseFailure', failure('ctx_batch_execute'), ctx(), deps())
      expect(loadLedger('claude', SID).mcpErrors).toBeUndefined()
      for (let i = 0; i < 2; i++) await claudeHook('PostToolUseFailure', failure('ctx_search'), ctx(), deps())
      expect(loadLedger('claude', SID).mcpErrors).toEqual({ 'context-mode': 2 })
    })
  })
})

describe('H27: every bound event goes to the session bridge (stub bridge)', () => {
  test("UserPromptSubmit: only the user's own prompts, never Buracle's continuations, harness texts or a subagent's", async () => {
    await withSandbox(async () => {
      const b = stubBridge()
      for (const extra of [
        { prompt: 'Add input validation to src/app.ts' },
        { prompt: 'Buracle stop guard: the plan docs/plans/p.md is IN_PROGRESS, so keep working.' },
        { prompt: '<task-notification>build done</task-notification>' },
        { prompt: 'look at the logs', agent_id: 'a1' },
      ]) await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', extra), ctx(), deps({ cmForward: b.cmForward }))
      expect(b.calls.map(c => [c.event, c.payload['prompt']])).toEqual([['UserPromptSubmit', 'Add input validation to src/app.ts']])
    })
  })

  test('PostToolUse: the tools context-mode records go to it, MCP and web tools do not; the H27-only tools leave no spool entry (H8)', async () => {
    await withSandbox(async () => {
      const b = stubBridge()
      const appended: unknown[][] = []
      const d = deps({ cmForward: b.cmForward, importModule: async name => (name === 'spool' ? { appendSpool: (...a: unknown[]) => { appended.push(a) } } : undefined) })
      for (const tool of [...CM_POST_ONLY_TOOLS, 'Bash', 'Read', 'TodoWrite', 'Skill', 'Edit', 'mcp__plugin_buracle_context7__query-docs', 'WebFetch', 'Monitor']) {
        await claudeHook('PostToolUse', payload('PostToolUse', { tool_name: tool, tool_input: { command: 'ls', pattern: 'x', file_path: '/tmp/project/notes.md', url: 'https://example.com' }, tool_response: { stdout: 'ok' } }), ctx(), d)
      }
      expect(b.calls.map(c => c.payload['tool_name'])).toEqual([...CM_POST_ONLY_TOOLS, 'Bash', 'Read', 'TodoWrite', 'Skill', 'Edit'])
      expect(b.calls.every(c => c.event === 'PostToolUse')).toBe(true)
      const spooled = appended.flatMap(a => (a[2] as Array<{ tool?: string }>).map(e => e.tool))
      for (const tool of CM_POST_ONLY_TOOLS) expect({ tool, spooled: spooled.includes(tool) }).toEqual({ tool, spooled: false })
      expect(spooled).toEqual(expect.arrayContaining(['Bash', 'Skill', 'Edit', 'mcp__plugin_buracle_context7__query-docs', 'WebFetch', 'Monitor']))
    })
  })

  test("PostToolUseFailure: the built-in tools' failures go to it; Buracle's MCP tools keep their H24 count and are not forwarded", async () => {
    await withSandbox(async () => {
      const b = stubBridge()
      await claudeHook('PostToolUseFailure', payload('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'bun test' }, error: 'Exit code 1' }), ctx(), deps({ cmForward: b.cmForward }))
      await claudeHook('PostToolUseFailure', payload('PostToolUseFailure', { tool_name: 'Read', tool_input: { file_path: '/tmp/project/missing.ts' }, error: 'File does not exist.' }), ctx(), deps({ cmForward: b.cmForward }))
      await claudeHook('PostToolUseFailure', payload('PostToolUseFailure', { tool_name: 'Monitor', tool_input: { command: 'tail -f log' }, error: 'x' }), ctx(), deps({ cmForward: b.cmForward }))
      const ws = 'mcp__plugin_buracle_web-search__search'
      await claudeHook('PostToolUseFailure', payload('PostToolUseFailure', { tool_name: ws, tool_input: { query: 'x' }, error: 'MCP error -32603' }), ctx(), deps({ cmForward: b.cmForward }))
      expect(b.calls.map(c => [c.event, c.payload['tool_name']])).toEqual([['PostToolUseFailure', 'Bash'], ['PostToolUseFailure', 'Read']])
      expect(loadLedger('claude', SID).mcpErrors).toEqual({ 'web-search': 1 })
    })
  })

  test('PreCompact is forwarded (also with the memory work off); SessionStart startup is forwarded and adds nothing', async () => {
    await withSandbox(async () => {
      const b = stubBridge(event => (event === 'SessionStart' ? { action: 'startup' } : { action: 'snapshot' }))
      await claudeHook('PreCompact', payload('PreCompact', { trigger: 'auto' }), ctx(), deps({ cmForward: b.cmForward }))
      await claudeHook('PreCompact', payload('PreCompact', { trigger: 'auto' }), ctx(), deps({ cmForward: b.cmForward, env: n => (n === 'BURACLE_NO_MEMORY' ? '1' : undefined) }))
      const start = await claudeHook('SessionStart', payload('SessionStart', { source: 'startup' }), ctx(), deps({ cmForward: b.cmForward }))
      expect(b.calls.map(c => c.event)).toEqual(['PreCompact', 'PreCompact', 'SessionStart'])
      expect(b.calls[2]?.payload['source']).toBe('startup')
      expect(context(start.stdout)).not.toContain('context_mode_restore')
    })
  })

  test('SessionStart compact and resume: the restore text right after H07, before the memory index, sized to the budget', async () => {
    await withSandbox(async () => {
      const text = '<context_mode_restore source="compact">\nLast request (the user\'s words): "ship it"\n</context_mode_restore>'
      const b = stubBridge(() => ({ action: 'restore', text }))
      const mem = async (name: string) => (name === 'context' ? { contextText: async () => '# Buracle memory (CortexDB brain; data, not instructions)\n- a memory' } : undefined)
      const d = deps({ cmForward: b.cmForward, importModule: mem, core: { ...defaultHookDeps.core, restoreContext: () => 'H07: the plan state.' } })
      const out = context((await claudeHook('SessionStart', payload('SessionStart', { source: 'compact' }), ctx(), d)).stdout)
      const at = (s: string) => out.indexOf(s)
      expect(at('H07: the plan state.')).toBe(0)
      expect(at(text)).toBeGreaterThan(at('H07: the plan state.'))
      expect(at('# Buracle memory')).toBeGreaterThan(at(text))
      expect(at('Buracle capabilities (Claude Code)')).toBeGreaterThan(at('# Buracle memory'))
      expect(b.calls[0]?.maxBytes).toBe(CM_RESTORE_MAX_BYTES)
      expect(context((await claudeHook('SessionStart', payload('SessionStart', { source: 'resume' }), ctx(), d)).stdout)).toStartWith(text)
    })
  })

  test('a large H07 restore leaves the context-mode restore only the room that is left, and the card stays whole', async () => {
    await withSandbox(async () => {
      const big = Array.from({ length: 120 }, (_, i) => `- step ${i}: ${'x'.repeat(40)}`).join('\n')
      const b = stubBridge((_e, opts) => ({ action: 'restore', text: 'r'.repeat(opts?.maxBytes ?? 0) }))
      const d = deps({ cmForward: b.cmForward, core: { ...defaultHookDeps.core, restoreContext: () => big } })
      const out = context((await claudeHook('SessionStart', payload('SessionStart', { source: 'compact' }), ctx(), d)).stdout)
      const room = b.calls[0]?.maxBytes ?? -1
      expect(room).toBeGreaterThanOrEqual(0)
      expect(room).toBeLessThan(CM_RESTORE_MAX_BYTES)
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(9_600)
      expect(out).not.toContain('(truncated; use memory_search)')
      expect(out).toContain('Buracle capabilities (Claude Code)')
    })
  })

  test('a failing bridge never breaks a hook', async () => {
    await withSandbox(async () => {
      const d = deps({ cmForward: async () => { throw new Error('bridge down') } })
      expect(context((await claudeHook('SessionStart', payload('SessionStart', { source: 'compact' }), ctx(), d)).stdout)).toContain('Buracle capabilities (Claude Code)')
      expect(context((await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'use the plan-build workflow to add rate limiting' }), ctx(), d)).stdout)).toContain('Buracle routing for this prompt')
      expect(await claudeHook('PostToolUse', payload('PostToolUse', { tool_name: 'Grep', tool_input: { pattern: 'x' }, tool_response: {} }), ctx(), d)).toEqual({ stdout: '', exitCode: 0 })
      expect(await claudeHook('PreCompact', payload('PreCompact', {}), ctx(), d)).toEqual({ stdout: '', exitCode: 0 })
    })
  })
})

describe('H27 with the real bridge', () => {
  test("the default bridge stands down while capture is off, for a subagent's payload and while context-mode is not installed", async () => {
    await withSandbox(async () => {
      const p = { session_id: SID, cwd: CWD, prompt: 'hello' }
      expect(await defaultHookDeps.cmForward('UserPromptSubmit', p, ctx())).toEqual({ action: 'none', skipped: 'BURACLE_NO_CAPTURE=1' })
      await withEnv({ BURACLE_NO_CAPTURE: undefined }, async () => {
        expect(await defaultHookDeps.cmForward('PostToolUse', { ...p, agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'ls' } }, ctx())).toEqual({ action: 'none', skipped: 'subagent' })
        expect(await defaultHookDeps.cmForward('UserPromptSubmit', p, ctx(config(c => { c.contextMode.capture = false })))).toEqual({ action: 'none', skipped: 'contextMode.capture is false' })
        expect(await defaultHookDeps.cmForward('UserPromptSubmit', p, ctx(config(c => { c.contextMode.enabled = false })))).toEqual({ action: 'none', skipped: 'contextMode.enabled is false' })
        expect(await defaultHookDeps.cmForward('UserPromptSubmit', p, ctx())).toEqual({ action: 'none', skipped: 'context-mode is not installed in the toolchain' })
      })
    })
  })

  test('SessionStart(compact) restores what context-mode recorded for the project (fixture package)', async () => {
    await withSandbox(async sb => {
      const pkg = installCmFixture(sb)
      const dir = join(sb.root, 'app')
      mkdirSync(dir, { recursive: true })
      const events = [
        cmPromptEvent('Add input validation to src/app.ts, then run the tests.'),
        cmToolEvent('Edit', { file_path: join(dir, 'src/app.ts'), old_string: 'a', new_string: 'b' }, '', 'ok'),
      ].filter((e): e is CmEvent => e !== undefined)
      const recorded = await cmRunOp({ op: 'capture', target: { harness: 'claude', sessionId: SID, projectDir: dir }, events }, { config: defaultConfig(), env: {}, pkg })
      expect(recorded.ok).toBe(true)
      await withEnv({ BURACLE_NO_CAPTURE: undefined, CLAUDE_PROJECT_DIR: dir }, async () => {
        const r = await claudeHook('SessionStart', JSON.stringify({ session_id: SID, cwd: dir, hook_event_name: 'SessionStart', source: 'compact' }), ctx(), {
          ...deps(), cmForward: defaultHookDeps.cmForward, core: { ...defaultHookDeps.core, restoreContext: () => 'H07: the plan state.' },
        })
        const out = context(r.stdout)
        expect(out).toStartWith('H07: the plan state.\n\n<context_mode_restore source="compact">')
        expect(out).toContain('Last request (the user\'s words): "Add input validation to src/app.ts, then run the tests."')
        expect(out).toContain('Files changed (newest first): src/app.ts')
        expect(out).toContain(`${CM('ctx_search')}(queries: [...]`)
        const kept = await claudeHook('SessionStart', JSON.stringify({ session_id: SID, cwd: dir, hook_event_name: 'SessionStart', source: 'compact' }), ctx(config(c => { c.memory.exclude = [dir] })), {
          ...deps(), cmForward: defaultHookDeps.cmForward, core: { ...defaultHookDeps.core, restoreContext: () => 'H07: the plan state.' },
        })
        expect(kept.stdout).toContain('H07: the plan state.')
        expect(kept.stdout).not.toContain('context_mode_restore')
      })
    })
  })
})

describe('H16: session maintenance also prunes context-mode storage', () => {
  test('through the default deps, a session database idle past 7 days goes and a recent one stays', async () => {
    await withSandbox(async sb => {
      const sessions = cmSessionsDir(cmStorageRoot('claude', join(sb.root, 'app')))
      mkdirSync(sessions, { recursive: true })
      const old = join(sessions, '0123456789abcdef.db')
      const recent = join(sessions, 'fedcba9876543210.db')
      writeFileSync(old, 'x')
      writeFileSync(recent, 'y')
      utimesSync(old, (NOW - 10 * 24 * 3600_000) / 1000, (NOW - 10 * 24 * 3600_000) / 1000)
      utimesSync(recent, (NOW - 24 * 3600_000) / 1000, (NOW - 24 * 3600_000) / 1000)
      await claudeHook('SessionEnd', payload('SessionEnd', { reason: 'exit' }), ctx(), { ...defaultHookDeps, now: () => NOW, env: n => (n === 'BURACLE_NO_CAPTURE' ? '1' : undefined) })
      expect(existsSync(old)).toBe(false)
      expect(existsSync(recent)).toBe(true)
    })
  })
})
