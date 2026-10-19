import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { CM_HIDDEN_TOOLS, CM_RESTORE_MAX_BYTES, CM_TOOLS, cmPromptEvent, cmToolEvent, type CmEvent } from '../../../src/core/context-mode'
import { defaultConfig, type BuracleConfig } from '../../../src/core/config'
import type { CmBridgeOptions, CmForwardResult } from '../../../src/adapters/shared/context-mode/bridge'
import { cmRunOp } from '../../../src/adapters/shared/context-mode/session'
import { loadLedger } from '../../../src/workflow/ledger'
import { saveState } from '../../../src/workflow/session-store'
import { capabilityCardText, CONTEXT_BUDGET_BYTES, handleCodexHook, type CodexHookDeps, type CoreFns } from '../../../src/adapters/codex/hook'
import { bridgePostPayload, isContextModeName, loadContextModeFns, sandboxPatchDenial, type ContextModeFns } from '../../../src/adapters/codex/context-mode'
import { installCmFixture, stopCmFixture } from '../../fixtures/context-mode/fixture'
import { processRunning } from '../../helpers/processes'
import { narrowPath } from '../../helpers/fake-exe'
import { makeSandboxDirs, withSandbox } from '../../helpers/sandbox'
import { ctx, deps, NOW, payload, planState, quiet, REPO, SID } from './hook-helpers'

const CHILD = '019a0000-0000-7000-8000-00000000c41d'

const cm = (tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => payload('PreToolUse', { tool_name: `mcp__context_mode__${tool}`, tool_use_id: 'c1', tool_input: input, ...extra })
const off = (): BuracleConfig => ({ ...defaultConfig(), contextMode: { enabled: false, capture: true } })
const contextOf = (r: { stdout: string }): string => (r.stdout === '' ? '' : String(JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? ''))

async function decide(input: string, d: CodexHookDeps = deps({}), config?: BuracleConfig): Promise<Record<string, unknown>> {
  const r = await handleCodexHook('PreToolUse', input, ctx(config), d)
  return r.stdout === '' ? {} : JSON.parse(r.stdout).hookSpecificOutput as Record<string, unknown>
}
const reason = (o: Record<string, unknown>): string => String(o['permissionDecisionReason'] ?? '')

describe('context-mode guards at PreToolUse (any strictness, before the generic MCP handling)', () => {
  test('H01: shell code and every batch command go through checkBash; the reason names the hook', () => withSandbox(async () => {
    const one = await decide(cm('ctx_execute', { language: 'shell', code: 'rm -rf ~' }))
    expect(one['permissionDecision']).toBe('deny')
    expect(reason(one)).toStartWith('Buracle H01: `rm -rf ~` would delete your home directory')
    const batch = await decide(cm('ctx_batch_execute', { commands: [{ label: 'list', command: 'ls' }, { label: 'wipe', command: 'rm -rf ~' }], queries: ['files'] }))
    expect(reason(batch)).toStartWith('Buracle H01: ')
    const loose = defaultConfig()
    loose.routing.strictness = 'off'
    expect(reason(await decide(cm('ctx_execute', { language: 'shell', code: 'rm -rf ~' }), deps({}), loose))).toStartWith('Buracle H01: ')
    expect((await decide(cm('ctx_execute', { language: 'shell', code: 'ls -la' })))['permissionDecision']).toBeUndefined()
    expect((await decide(cm('ctx_search', { queries: ['parser'] })))['permissionDecision']).toBeUndefined()
  }))

  test('the allowlist: hidden and unknown tools, unknown input fields and unreadable languages are denied (H01)', () => withSandbox(async () => {
    expect(reason(await decide(cm('ctx_upgrade', {})))).toStartWith('Buracle H01: ')
    expect(reason(await decide(cm('ctx_upgrade', {})))).toContain('buracle update --yes context-mode')
    expect(reason(await decide(cm('ctx_doctor', {})))).toContain('buracle doctor context-mode')
    expect(reason(await decide(cm('ctx_teleport', {})))).toContain('does not know')
    expect(reason(await decide(cm('ctx_execute', { language: 'shell', code: 'ls', env: { X: '1' } })))).toContain('the input field `env`')
    expect(reason(await decide(cm('ctx_execute', { language: 'go', code: 'package main' })))).toContain('run it as shell, JavaScript or Python')
    for (const t of CM_TOOLS) expect(isContextModeName(`mcp__context_mode__${t}`)).toBe(true)
  }))

  test('H02: code that writes a secret, a credential read into the index, and a sandbox apply_patch', () => withSandbox(async ({ home }) => {
    expect(reason(await decide(cm('ctx_execute', { language: 'python', code: "open('.env', 'w').write('X=1')" })))).toStartWith('Buracle H02: ')
    expect(reason(await decide(cm('ctx_execute_file', { path: join(home, '.ssh', 'id_rsa'), language: 'python', code: 'print(len(FILE_CONTENT))' })))).toStartWith('Buracle H02: ')
    const patch = "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: x.txt\n+x\n*** End Patch\nEOF"
    expect(reason(await decide(cm('ctx_execute', { language: 'shell', code: patch })))).toStartWith('Buracle H02: ')
  }))

  test('H02: Codex\'s hidden apply_patch entry point in a sandbox command or in code it spawns (core checkSandbox denies it on every harness; the Codex check catches every other form)', () => withSandbox(async () => {
    const flag = "codex --codex-run-as-apply-patch '*** Begin Patch\n*** Add File: x.txt\n+x\n*** End Patch'"
    const shell = await decide(cm('ctx_execute', { language: 'shell', code: flag }))
    expect(reason(shell)).toStartWith("Buracle H02: context-mode's sandbox would run ")
    expect(sandboxPatchDenial([flag])).toStartWith("context-mode's sandbox would run Codex's apply_patch")
    const py = await decide(cm('ctx_execute', { language: 'python', code: "import subprocess\nsubprocess.run(['codex', '--codex-run-as-apply-patch', open('p').read()])" }))
    expect(reason(py)).toStartWith("Buracle H02: context-mode's sandbox would run ")
    expect(reason(await decide(cm('ctx_batch_execute', { commands: ['ls', 'cat p.diff | applypatch'], queries: ['x'] })))).toStartWith('Buracle H02: ')
    expect(sandboxPatchDenial(['rg -n "apply_patch" src/', 'git log --oneline'])).toBeUndefined()
    expect((await decide(cm('ctx_execute', { language: 'shell', code: 'rg -n apply_patch src/adapters/codex' })))['permissionDecision']).toBeUndefined()
  }))

  test('the server\'s folder is the real path of the session cwd (cmProjectDir); nothing is pinned into the call', () => withSandbox(async ({ root }) => {
    const real = join(root, 'proj')
    mkdirSync(real)
    const link = join(root, 'proj-link')
    symlinkSync(real, link)
    const seen: Array<Parameters<CoreFns['checkSandbox']>[1]> = []
    const d = deps({ checkSandbox: (_call, opts) => { seen.push(opts); return {} } })
    const out = await decide(cm('ctx_execute', { language: 'shell', code: 'ls' }, { cwd: link }), d)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.serverDir).toBe(realpathSync(link))
    expect(seen[0]?.bash.cwd).toBe(link)
    expect(seen[0]?.write.cwd).toBe(link)
    expect(seen[0]?.pinnedDir).toBeUndefined()
    expect(out['updatedInput']).toBeUndefined()
    await decide(payload('PreToolUse', { tool_name: 'mcp__codegraph__codegraph_explore', tool_input: { query: 'x', projectPath: link }, cwd: link }), d)
    expect(seen).toHaveLength(1)
  }))

  test('R9: the guards fail closed; a failed classification denies context-mode calls only', () => withSandbox(async () => {
    const boom = () => { throw new Error('guard exploded') }
    const failed = await decide(cm('ctx_execute', { language: 'shell', code: 'ls' }), deps({ checkSandbox: boom }))
    expect(failed['permissionDecision']).toBe('deny')
    expect(reason(failed)).toStartWith('Buracle H01: the guards could not check this context-mode call (guard exploded)')
    expect(reason(await decide(cm('ctx_execute', { language: 'shell', code: 'ls' }), deps({ cmCall: boom })))).toStartWith('Buracle H01: the guards could not check')
    expect(reason(await decide(cm('ctx_search', { queries: ['x'] }), deps({ sandboxShellCommands: boom })))).toStartWith('Buracle H01: the guards could not check')
    const unclassified = deps({ classifyTool: boom })
    expect(reason(await decide(cm('ctx_execute', { language: 'shell', code: 'ls' }), unclassified))).toStartWith('Buracle H01: the guards could not check')
    expect(reason(await decide(cm('ctx_search', { queries: ['x'] }), unclassified))).toStartWith('Buracle H01: ')
    expect(reason(await decide(payload('PreToolUse', { tool_name: 'context-mode_ctx_batch_execute', tool_input: {} }), unclassified))).toStartWith('Buracle H01: ')
    expect(await handleCodexHook('PreToolUse', payload('PreToolUse', { tool_name: 'mcp__codegraph__codegraph_explore', tool_input: {} }), ctx(), unclassified)).toEqual({ stdout: '', exitCode: 0 })
    expect((await decide(payload('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), deps({ cmCall: boom })))['permissionDecision']).toBeUndefined()
  }))

  test('R9: an execution tool the classification does not tie to Buracle\'s server is denied; its other tools are ordinary MCP calls', () => withSandbox(async () => {
    const foreign = await decide(payload('PreToolUse', { tool_name: 'mcp__my_context_mode__ctx_execute', tool_input: { language: 'shell', code: 'rm -rf build' } }))
    expect(foreign['permissionDecision']).toBe('deny')
    expect(reason(foreign)).toContain('not one of Buracle\'s context-mode server')
    expect((await decide(payload('PreToolUse', { tool_name: 'mcp__my_context_mode__ctx_search', tool_input: { queries: ['x'] } })))['permissionDecision']).toBeUndefined()
  }))

  test('H01 lane guard: a subagent thread cannot change the root session\'s plan state through context-mode; the root and read-only commands can', () => withSandbox(async () => {
    const lane = { agent_id: CHILD, agent_type: 'worker' }
    const shell = await decide(cm('ctx_execute', { language: 'shell', code: 'buracle plan resume' }, lane))
    expect(shell['permissionDecision']).toBe('deny')
    expect(reason(shell)).toContain('Buracle lane guard')
    expect(reason(await decide(cm('ctx_batch_execute', { commands: ['ls', 'buracle worktree cleanup x --discard'], queries: ['x'] }, lane)))).toContain('`buracle worktree cleanup`')
    expect(reason(await decide(cm('ctx_execute', { language: 'python', code: "import subprocess\nsubprocess.run(['buracle', 'flow', 'end', '--outcome', 'done'])" }, lane)))).toContain('`buracle flow end`')
    expect((await decide(cm('ctx_execute', { language: 'shell', code: 'buracle plan status --json' }, lane)))['permissionDecision']).toBeUndefined()
    expect((await decide(cm('ctx_execute', { language: 'shell', code: 'buracle plan resume' })))['permissionDecision']).toBeUndefined()
  }))

  test('review agents may search and run read-only commands, nothing else; a failing reviewer check denies only subagents', () => withSandbox(async () => {
    const reviewer = { agent_id: CHILD, agent_type: 'plan-build-review' }
    expect(reason(await decide(cm('ctx_execute', { language: 'python', code: 'print(1)' }, reviewer)))).toContain('plan-build-review is a read-only reviewer')
    expect(reason(await decide(cm('ctx_batch_execute', { commands: ['git diff', 'touch x'], queries: ['x'] }, reviewer)))).toContain('`touch`')
    expect(reason(await decide(cm('ctx_purge', { confirm: true }, reviewer)))).toContain('read-only reviewer')
    expect((await decide(cm('ctx_batch_execute', { commands: ['git diff', 'rg -n parser src'], queries: ['parser'] }, reviewer)))['permissionDecision']).toBeUndefined()
    expect((await decide(cm('ctx_search', { queries: ['x'] }, reviewer)))['permissionDecision']).toBeUndefined()
    expect((await decide(cm('ctx_execute', { language: 'python', code: 'print(1)' }, { agent_id: CHILD, agent_type: 'worker' })))['permissionDecision']).toBeUndefined()
    expect(reason(await decide(cm('ctx_execute', { language: 'shell', code: 'rm -rf ~' }, { agent_id: CHILD, agent_type: 'worker' })))).toStartWith('Buracle H01: ')
    const boom = () => { throw new Error('reviewer check exploded') }
    expect(reason(await decide(cm('ctx_search', { queries: ['x'] }, reviewer), deps({ cmReviewerDenial: boom })))).toStartWith('Buracle H01: the guards could not check')
    expect((await decide(cm('ctx_search', { queries: ['x'] }), deps({ cmReviewerDenial: boom })))['permissionDecision']).toBeUndefined()
  }))

  test('H20: each command a call runs needs the user\'s consent, as in Bash; ctx_purge counts as a database drop', () => withSandbox(async () => {
    const batch = cm('ctx_batch_execute', { commands: ['git status', 'git push origin main'], queries: ['pushed'] })
    const held = await decide(batch)
    expect(held['permissionDecision']).toBe('deny')
    expect(reason(held)).toStartWith('Buracle H20: ')
    await handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'evet, pushla' }), ctx(), deps(quiet))
    expect((await decide(batch))['permissionDecision']).toBeUndefined()
    expect(reason(await decide(cm('ctx_purge', { confirm: true })))).toStartWith('Buracle H20: ')
    expect((await decide(cm('ctx_purge', { confirm: false })))['permissionDecision']).toBeUndefined()
  }))
})

describe('H24 and the switch', () => {
  test('a failing context-mode execution call never counts toward the server being down; its other tools do', () => withSandbox(async () => {
    const result = (tool: string) => handleCodexHook('PostToolUse', payload('PostToolUse', {
      tool_name: `mcp__context_mode__${tool}`, tool_input: {}, tool_response: { content: [{ type: 'text', text: 'Error: exit 1' }], isError: true },
    }), ctx(), deps({}))
    await result('ctx_execute')
    await result('ctx_batch_execute')
    expect(loadLedger('codex', SID).mcpErrors).toBeUndefined()
    await result('ctx_search')
    await result('ctx_search')
    expect(loadLedger('codex', SID).mcpErrors).toEqual({ 'context-mode': 2 })
  }))

  test('contextMode.enabled false: the card, the prompt router and H03 treat context-mode as down at once', () => withSandbox(async ({ root }) => {
    const cardOn = capabilityCardText(ctx(), deps({}), SID)
    expect(cardOn).toMatch(/^- context-mode[*:]/m)
    for (const card of [capabilityCardText(ctx(off()), deps({}), SID), capabilityCardText(ctx(off()), deps({}))]) {
      expect(card).not.toMatch(/^- context-mode[*:]/m)
      expect(card).toMatch(/^- codegraph[*:]/m)
    }
    const start = (c: BuracleConfig) => handleCodexHook('SessionStart', payload('SessionStart', { cwd: root, source: 'resume' }), ctx(c), deps(quiet))
    expect(contextOf(await start(defaultConfig()))).toContain('Capability card')
    const prompt = payload('UserPromptSubmit', { prompt: 'summarize the test output of the last CI run' })
    expect(contextOf(await handleCodexHook('UserPromptSubmit', prompt, ctx(), deps({})))).toContain('context-mode')
    expect(contextOf(await handleCodexHook('UserPromptSubmit', prompt, ctx(off()), deps({})))).not.toContain('context-mode')
    const build = payload('PreToolUse', { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: './gradlew build' } })
    expect(contextOf(await handleCodexHook('PreToolUse', build, ctx(), deps({})))).toContain('mcp__context_mode__ctx_execute')
    expect(contextOf(await handleCodexHook('PreToolUse', build, ctx(off()), deps({})))).not.toContain('mcp__context_mode__')
    expect(reason(await decide(cm('ctx_execute', { language: 'shell', code: 'rm -rf ~' }), deps({}), off()))).toStartWith('Buracle H01: ')
  }))
})

interface Forwarded { event: string, payload: Record<string, unknown>, opts: CmBridgeOptions }

function recorder(text = '') {
  const calls: Forwarded[] = []
  const pruned: number[] = []
  const fns: ContextModeFns = {
    forward: async (event, p, opts): Promise<CmForwardResult> => {
      calls.push({ event, payload: p, opts })
      const fits = new TextEncoder().encode(text).length <= (opts.maxBytes ?? CM_RESTORE_MAX_BYTES)
      return event === 'SessionStart' && (p['source'] === 'compact' || p['source'] === 'resume') ? { action: 'restore', text: fits ? text : '' } : { action: 'capture' }
    },
    prune: now => { pruned.push(now) },
  }
  return { calls, pruned, load: async () => fns }
}

describe('H27: the session bridge on every bound event', () => {
  test('SessionStart: startup and clear open the session (H16 prunes at startup); a subagent never forwards', () => withSandbox(async ({ root }) => {
    const b = recorder()
    const d = { ...deps(quiet), contextMode: b.load }
    await handleCodexHook('SessionStart', payload('SessionStart', { cwd: root, source: 'startup' }), ctx(), d)
    expect(b.calls.map(c => [c.event, c.payload['source']])).toEqual([['SessionStart', 'startup']])
    expect(b.calls[0]?.opts.config).toEqual(defaultConfig())
    expect(b.calls[0]?.opts.env?.['HOME']).toBeString()
    expect(b.pruned).toEqual([NOW])
    await handleCodexHook('SessionStart', payload('SessionStart', { cwd: root, source: 'clear' }), ctx(), d)
    expect(b.calls.map(c => c.payload['source'])).toEqual(['startup', 'clear'])
    expect(b.pruned).toEqual([NOW])
    await handleCodexHook('SessionStart', payload('SessionStart', { cwd: root, source: 'startup', agent_id: CHILD, agent_type: 'worker' }), ctx(), d)
    expect(b.calls).toHaveLength(2)
  }))

  test('SessionStart(compact|resume): the restore text follows H07, within the budget', () => withSandbox(async ({ root }) => {
    const restore = '<context_mode_restore source="compact">\nLast request (the user\'s words): "Rename the parser."\n</context_mode_restore>'
    const b = recorder(restore)
    const d = { ...deps({ ...quiet, restoreContext: () => 'Active plan docs/plans/p.md, task 3 of 6.' }), contextMode: b.load }
    const text = contextOf(await handleCodexHook('SessionStart', payload('SessionStart', { cwd: root, source: 'compact' }), ctx(), d))
    expect(text.startsWith('Active plan docs/plans/p.md, task 3 of 6.')).toBe(true)
    expect(text.indexOf(restore)).toBeGreaterThan(0)
    expect(text.indexOf(restore)).toBeLessThan(text.indexOf('Capability card'))
    const asked = b.calls[0]?.opts.maxBytes ?? -1
    expect(asked).toBeGreaterThan(0)
    expect(asked).toBeLessThanOrEqual(CM_RESTORE_MAX_BYTES)
    const resumed = contextOf(await handleCodexHook('SessionStart', payload('SessionStart', { cwd: root, source: 'resume' }), ctx(), { ...deps(quiet), contextMode: b.load }))
    expect(resumed.startsWith(restore)).toBe(true)
    expect(b.pruned).toEqual([])
  }))

  test('SessionStart: a long H07 restore leaves the context-mode restore only the room that is left; the card stays whole', () => withSandbox(async ({ root }) => {
    const bytes = (s: string): number => new TextEncoder().encode(s).length
    const h07 = Array.from({ length: 200 }, (_, i) => `- plan step ${i}: keep the parser tests green`).join('\n')
    const left = CONTEXT_BUDGET_BYTES - bytes(`${h07}\n\nCapability card`)
    expect(left).toBeLessThan(CM_RESTORE_MAX_BYTES)
    const short = '<context_mode_restore source="compact">\nshort\n</context_mode_restore>'
    const b = recorder(short)
    const d = { ...deps({ ...quiet, restoreContext: () => h07 }), contextMode: b.load }
    const text = contextOf(await handleCodexHook('SessionStart', payload('SessionStart', { cwd: root, source: 'compact' }), ctx(), d))
    const asked = b.calls[0]?.opts.maxBytes ?? -1
    expect(asked).toBeGreaterThan(bytes(short))
    expect(asked).toBeLessThanOrEqual(left)
    expect(text).toContain(short)
    expect(bytes(text)).toBeLessThanOrEqual(CONTEXT_BUDGET_BYTES)
    expect(text.endsWith('Capability card')).toBe(true)
    const big = recorder(`<context_mode_restore source="compact">\n${'x'.repeat(left)}\n</context_mode_restore>`)
    const none = contextOf(await handleCodexHook('SessionStart', payload('SessionStart', { cwd: root, source: 'compact' }), ctx(), { ...d, contextMode: big.load }))
    expect(none).not.toContain('<context_mode_restore')
    expect(none.endsWith('Capability card')).toBe(true)
  }))

  test('UserPromptSubmit: the user\'s own prompts only (never a guard continuation or a subagent\'s task)', () => withSandbox(async () => {
    saveState('codex', SID, planState())
    const b = recorder()
    const d = { ...deps(quiet), contextMode: b.load }
    await handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'Rename the parser, then fix the callers.' }), ctx(), d)
    await handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'Buracle stop guard: the plan docs/plans/p.md is IN_PROGRESS; continue with task 3.' }), ctx(), d)
    await handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'Review the diff.', agent_id: CHILD, agent_type: 'plan-build-review' }), ctx(), d)
    expect(b.calls.map(c => [c.event, c.payload['prompt']])).toEqual([['UserPromptSubmit', 'Rename the parser, then fix the callers.']])
  }))

  test('PostToolUse: shell commands and patches of the main session; a shell-fed patch as the patch it applies (headers only, anchored at its cd)', () => withSandbox(async () => {
    const b = recorder()
    const d = { ...deps(quiet), contextMode: b.load }
    const post = (extra: Record<string, unknown>) => handleCodexHook('PostToolUse', payload('PostToolUse', extra), ctx(), d)
    await post({ tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_response: ' 3 pass\n 0 fail' })
    await post({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch\n' }, tool_response: 'Success.' })
    await post({ tool_name: 'Bash', tool_input: { command: "cd /srv/x && apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: a.ts\n+export const a = 1\n*** Update File: /srv/y/b.ts\n@@\n-x\n+y\n*** End Patch\nEOF" }, tool_response: 'Success.' })
    await post({ tool_name: 'Bash', tool_input: { command: 'cat fix.diff | apply_patch' }, tool_response: '' })
    await post({ tool_name: 'mcp__codegraph__codegraph_explore', tool_input: { query: 'x' }, tool_response: { content: [] } })
    await post({ tool_name: 'webrun', tool_input: { search_query: [{ q: 'x' }] }, tool_response: 'results' })
    await post({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'a.ts', agent_id: CHILD, agent_type: 'worker' })
    expect(b.calls.map(c => c.payload['tool_name'])).toEqual(['Bash', 'apply_patch', 'apply_patch'])
    expect(b.calls[0]?.payload['tool_input']).toEqual({ command: 'bun test' })
    const shellPatch = String((b.calls[2]?.payload['tool_input'] as Record<string, unknown>)['command'])
    expect(shellPatch).toContain('*** Add File: /srv/x/a.ts')
    expect(shellPatch).toContain('*** Update File: /srv/y/b.ts')
    expect(b.calls.every(c => c.event === 'PostToolUse')).toBe(true)
  }))

  test('PreCompact forwards the snapshot; Stop and a subagent\'s compaction forward nothing', () => withSandbox(async () => {
    const b = recorder()
    const d = { ...deps(quiet), contextMode: b.load }
    await handleCodexHook('PreCompact', payload('PreCompact', { trigger: 'auto' }), ctx(), d)
    await handleCodexHook('PreCompact', payload('PreCompact', { trigger: 'auto', agent_id: CHILD, agent_type: 'worker' }), ctx(), d)
    await handleCodexHook('Stop', payload('Stop', { stop_hook_active: false, last_assistant_message: 'Done.' }), ctx(), d)
    expect(b.calls.map(c => c.event)).toEqual(['PreCompact'])
  }))

  test('fails open: a bridge that throws, or no bridge at all, changes no hook output', () => withSandbox(async ({ root }) => {
    const broken: ContextModeFns = { forward: async () => { throw new Error('bridge exploded') }, prune: () => { throw new Error('prune exploded') } }
    const d = { ...deps(quiet), contextMode: async () => broken }
    const plain = deps(quiet)
    for (const source of ['startup', 'compact']) {
      const ev = payload('SessionStart', { cwd: root, source })
      expect(await handleCodexHook('SessionStart', ev, ctx(), d)).toEqual(await handleCodexHook('SessionStart', ev, ctx(), plain))
    }
    const failing = { ...deps(quiet), contextMode: async (): Promise<ContextModeFns> => { throw new Error('module missing') } }
    expect(await handleCodexHook('PostToolUse', payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'a' }), ctx(), failing)).toEqual({ stdout: '', exitCode: 0 })
    expect(await handleCodexHook('PreCompact', payload('PreCompact', { trigger: 'manual' }), ctx(), d)).toEqual({ stdout: '', exitCode: 0 })
    const fns = await loadContextModeFns()
    expect(typeof fns.forward).toBe('function')
    expect(typeof fns.prune).toBe('function')
  }))

  test('end to end through the real bridge: a resumed session gets the restore of its own events (fixture package)', () => withSandbox(async sb => {
    stopCmFixture()
    const pkg = installCmFixture(sb)
    const dir = join(sb.root, 'app')
    mkdirSync(dir)
    const target = { harness: 'codex' as const, sessionId: SID, projectDir: realpathSync(dir) }
    const events = [
      cmPromptEvent('Add input validation to src/app.ts, then run the tests.'),
      cmToolEvent('apply_patch', { command: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** End Patch' }, '', 'ok'),
      cmToolEvent('Bash', { command: 'bun test src/app.test.ts' }, 'error: expected 1 to be 2', 'error'),
    ].filter((e): e is CmEvent => e !== undefined)
    expect((await cmRunOp({ op: 'capture', target, events }, { config: defaultConfig(), env: {}, pkg })).ok).toBe(true)
    const d: CodexHookDeps = { ...deps(quiet), contextMode: loadContextModeFns }
    const text = contextOf(await handleCodexHook('SessionStart', payload('SessionStart', { cwd: dir, source: 'resume' }), ctx(), d))
    expect(text).toContain('<context_mode_restore source="resume">')
    expect(text).toContain('Last request (the user\'s words): "Add input validation to src/app.ts, then run the tests."')
    expect(text).toContain('mcp__context_mode__ctx_search(queries: [...], source: "session-events")')
    expect(text.indexOf('<context_mode_restore')).toBeLessThan(text.indexOf('Capability card'))
    const noCapture = { ...defaultConfig(), contextMode: { enabled: true, capture: false } }
    expect(contextOf(await handleCodexHook('SessionStart', payload('SessionStart', { cwd: dir, source: 'resume' }), ctx(noCapture), d))).not.toContain('<context_mode_restore')
    const kept = { ...defaultConfig(), memory: { ...defaultConfig().memory, exclude: [realpathSync(dir)] } }
    expect(contextOf(await handleCodexHook('SessionStart', payload('SessionStart', { cwd: dir, source: 'resume' }), ctx(kept), d))).not.toContain('<context_mode_restore')
    stopCmFixture()
  }))
})

describe('through the CLI dispatcher (a real hook process, hook-data.json canonical)', () => {
  const hook = (event: string, input: string, sb: { home: string, buracleHome: string }, env: Record<string, string | undefined> = process.env) => Bun.spawnSync([process.execPath, join(REPO, 'src', 'cli', 'main.ts'), 'hook', 'codex', event], {
    stdin: new TextEncoder().encode(input), env: { ...env, HOME: sb.home, BURACLE_HOME: sb.buracleHome }, stdout: 'pipe', stderr: 'pipe',
  })
  const cmStores = (buracleHome: string): string[] => {
    const root = join(buracleHome, 'context-mode')
    if (!existsSync(root)) return []
    return readdirSync(root, { recursive: true }).map(p => String(p).replace(/\\/g, '/')).filter(p => basename(p) === 'sessions' || p.endsWith('.db')).sort()
  }
  const settle = async (projectDir: string): Promise<void> => {
    const pattern = `ctx session [a-z]+ .*--project-dir ${projectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
    for (const deadline = Date.now() + 20_000; Date.now() < deadline; await Bun.sleep(50)) {
      if (!processRunning(pattern)) return
    }
    throw new Error('detached context-mode children still running after 20 s')
  }

  test('a destructive sandbox command and an unconsented push in a batch are denied end to end', () => withSandbox(async sb => {
    const wipe = hook('PreToolUse', cm('ctx_execute', { language: 'shell', code: 'rm -rf ~' }), sb)
    expect(wipe.exitCode).toBe(0)
    expect(JSON.parse(wipe.stdout.toString()).hookSpecificOutput.permissionDecisionReason).toStartWith('Buracle H01: ')
    const push = hook('PreToolUse', cm('ctx_batch_execute', { commands: ['git status', 'git push origin main'], queries: ['pushed'] }), sb)
    expect(JSON.parse(push.stdout.toString()).hookSpecificOutput.permissionDecisionReason).toStartWith('Buracle H20: ')
    const ok = hook('PreToolUse', cm('ctx_search', { queries: ['parser'] }), sb)
    expect(ok.exitCode).toBe(0)
    expect(ok.stdout.toString() === '' || JSON.parse(ok.stdout.toString()).hookSpecificOutput.permissionDecision === undefined).toBe(true)
  }), 60_000)

  test('the bridge stands down without context-mode in the toolchain: SessionStart still answers, PostToolUse prints nothing, no session store appears; with the toolchain copy the same events create one', () => withSandbox(async sb => {
    const { BURACLE_NO_CAPTURE: _quiet, ...captureOn } = process.env
    const events = (): void => {
      const start = hook('SessionStart', payload('SessionStart', { cwd: sb.home, source: 'startup' }), sb, captureOn)
      expect(start.exitCode).toBe(0)
      expect(JSON.parse(start.stdout.toString()).hookSpecificOutput.additionalContext).toContain('Buracle capabilities (Codex)')
      const post = hook('PostToolUse', payload('PostToolUse', { cwd: sb.home, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'a.ts' }), sb, captureOn)
      expect(post.exitCode).toBe(0)
      expect(post.stdout.toString()).toBe('')
    }
    events()
    await settle(sb.home)
    expect(cmStores(sb.buracleHome)).toEqual([])
    installCmFixture(sb)
    events()
    for (const deadline = Date.now() + 20_000; !cmStores(sb.buracleHome).some(p => p.endsWith('.db')) && Date.now() < deadline;) await Bun.sleep(50)
    await settle(sb.home)
    expect(cmStores(sb.buracleHome)).toEqual([expect.stringMatching(/^codex\/home-[0-9a-f]+\/sessions$/), expect.stringMatching(/^codex\/home-[0-9a-f]+\/sessions\/[0-9a-f]+\.db$/)])
  }), 60_000)
})

describe('bridgePostPayload and the name helpers', () => {
  test('only Codex\'s shell tool is rewritten; other payloads go as they came', () => {
    const p = { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** End Patch' } }
    expect(bridgePostPayload(p)).toBe(p)
    const bash = { tool_name: 'Bash', tool_input: { command: 'git status' } }
    expect(bridgePostPayload(bash)).toBe(bash)
    expect(bridgePostPayload({ tool_name: 'Bash', tool_input: { command: "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: /a/b.ts\n+x\n*** End Patch\nEOF" } })).toEqual({
      tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: /a/b.ts\n+x\n*** End Patch' },
    })
  })

  test('context-mode names: Codex\'s spelling of every tool, any harness\'s spelling of the execution tools', () => {
    for (const t of [...CM_TOOLS, ...CM_HIDDEN_TOOLS]) expect(isContextModeName(`mcp__context_mode__${t}`)).toBe(true)
    expect(isContextModeName('mcp__plugin_buracle_context-mode__ctx_execute')).toBe(true)
    expect(isContextModeName('mcp__context_mode_ctx_batch_execute')).toBe(true)
    expect(isContextModeName('mcp__codegraph__codegraph_explore')).toBe(false)
    expect(isContextModeName('Bash')).toBe(false)
  })
})

const REAL = process.env['BURACLE_CM_SMOKE']

describe.skipIf(REAL === undefined || REAL === '')('OPT-IN: the Codex hooks with a real context-mode package (BURACLE_CM_SMOKE)', () => {
  test('the bound events capture through detached children; the restore after compaction renders them; all inside a sandbox', async () => {
    const sb = makeSandboxDirs('buracle-cm-codex-')
    for (const d of ['xdg-config', 'xdg-data', 'xdg-cache', 'tmp', 'cmdir', 'proj/src', 'home/.codex', 'home/.claude', 'home/.buracle/state', 'tc/node_modules']) mkdirSync(join(sb.root, d), { recursive: true })
    symlinkSync(realpathSync(REAL as string), join(sb.root, 'tc', 'node_modules', 'context-mode'))
    writeFileSync(join(sb.buracleHome, 'state', 'toolchain.json'), JSON.stringify({
      v: 1, updated_at: 'x', system: {},
      packages: { 'npm:context-mode': { registry: 'npm', name: 'context-mode', version: 'real', dir: join(sb.root, 'tc'), bins: {}, installed_at: 'x' } },
    }))
    const env: Record<string, string> = {
      PATH: process.env['PATH'] ?? narrowPath(), HOME: sb.home, BURACLE_HOME: sb.buracleHome, CLAUDE_CONFIG_DIR: join(sb.home, '.claude'),
      CODEX_HOME: join(sb.home, '.codex'), XDG_CONFIG_HOME: join(sb.root, 'xdg-config'), XDG_DATA_HOME: join(sb.root, 'xdg-data'),
      XDG_CACHE_HOME: join(sb.root, 'xdg-cache'), TMPDIR: join(sb.root, 'tmp'), CONTEXT_MODE_DIR: join(sb.root, 'cmdir'),
      PI_CODING_AGENT_DIR: join(sb.home, '.omp', 'agent'), BURACLE_NO_MEMORY: '1', BURACLE_NO_TOOLCHAIN: '1', BURACLE_NO_AUTOSTART: '1', BURACLE_NO_NOTIFY: '1',
    }
    const proj = join(sb.root, 'proj')
    const base = { session_id: SID, turn_id: 't1', transcript_path: null, cwd: proj, model: 'gpt-6.1-sol', permission_mode: 'bypassPermissions' }
    const hook = async (event: string, extra: Record<string, unknown>): Promise<string> => {
      const p = Bun.spawn([process.execPath, join(REPO, 'src', 'cli', 'main.ts'), 'hook', 'codex', event], {
        cwd: proj, env, stdin: new Blob([JSON.stringify({ ...base, hook_event_name: event, ...extra })]), stdout: 'pipe', stderr: 'pipe',
      })
      const out = await new Response(p.stdout).text()
      expect(await p.exited).toBe(0)
      return out
    }
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 150; i++) {
        if (!processRunning(`ctx session [a-z]+ .*project-dir ${proj}`)) return
        await Bun.sleep(100)
      }
      throw new Error('detached context-mode children still running after 15 s')
    }
    try {
      await hook('SessionStart', { source: 'startup' })
      await hook('UserPromptSubmit', { prompt: 'Export the report as CSV, keep the header row.' })
      await hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'c1', tool_input: { command: 'bun test' }, tool_response: 'error: expected 3 columns, got 2' })
      await hook('PostToolUse', { tool_name: 'apply_patch', tool_use_id: 'c2', tool_input: { command: '*** Begin Patch\n*** Add File: src/csv.ts\n+export const PATCH_BODY_MARKER = 1\n*** End Patch\n' }, tool_response: 'Success. Updated the following files:\nA src/csv.ts' })
      await settle()
      await hook('PreCompact', { trigger: 'auto' })
      await settle()
      const out = JSON.parse(await hook('SessionStart', { source: 'compact' })) as { hookSpecificOutput: { additionalContext: string } }
      const text = out.hookSpecificOutput.additionalContext
      expect(text).toContain('<context_mode_restore source="compact">')
      expect(text).toContain('Last request (the user\'s words): "Export the report as CSV, keep the header row."')
      expect(text).toContain('src/csv.ts')
      expect(text).toContain('mcp__context_mode__ctx_search(queries: [...], source: "session-events")')
      expect(text).not.toContain('PATCH_BODY_MARKER')
      const roots = readdirSync(join(sb.buracleHome, 'context-mode', 'codex'))
      expect(roots.length).toBe(1)
      expect(roots[0]).toStartWith('proj-')
      expect(readdirSync(join(sb.buracleHome, 'context-mode', 'tmp')).filter(f => f.startsWith('in-'))).toEqual([])
    } finally {
      await settle().catch(() => undefined)
      rmSync(sb.root, { recursive: true, force: true })
    }
  }, 60_000)
})
