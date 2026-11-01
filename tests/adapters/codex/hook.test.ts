import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as core from '../../../src/core/index'
import { defaultConfig } from '../../../src/core/config'
import { projectIdentity } from '../../../src/engine/git'
import { run } from '../../../src/engine/proc'
import * as paths from '../../../src/engine/paths'
import { loadState, readTelemetry, saveState, writeTelemetry } from '../../../src/workflow/session-store'
import { loadAdapterState, saveAdapterState } from '../../../src/adapters/codex/hook-io'
import { capabilityCardText, CONTEXT_BUDGET_BYTES, handleCodexHook, MAX_SUBAGENT_ALIASES, recordSubagentAlias, reviewReportErrors, subagentAliasesFile, type CoreFns } from '../../../src/adapters/codex/hook'
import { fakeExe } from '../../helpers/fake-exe'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { allow, canonical, ctx, DAY, deps, keys, NOW, payload, plan, planState, quiet, REPO, SID, statePath, withPlan } from './hook-helpers'

describe('input handling', () => {
  test('invalid JSON, missing or unsafe session ids and unknown events answer nothing', () => withSandbox(async () => {
    const d = deps(quiet)
    expect(await handleCodexHook('Stop', 'not json', ctx(), d)).toEqual({ stdout: '', exitCode: 0 })
    expect(await handleCodexHook('Stop', '', ctx(), d)).toEqual({ stdout: '', exitCode: 0 })
    expect(await handleCodexHook('Stop', JSON.stringify({ cwd: '/x' }), ctx(), d)).toEqual({ stdout: '', exitCode: 0 })
    expect(await handleCodexHook('Stop', JSON.stringify({ session_id: '../../etc' }), ctx(), d)).toEqual({ stdout: '', exitCode: 0 })
    expect(await handleCodexHook('Interrupt', payload('Interrupt'), ctx(), d)).toEqual({ stdout: '', exitCode: 0 })
  }))
})

describe('PreToolUse', () => {
  const bash = (command: string, cwd = '/work/app', mode = 'bypassPermissions') => payload('PreToolUse', { cwd, tool_name: 'Bash', tool_use_id: 'c1', tool_input: { command }, permission_mode: mode })
  const patch = (body: string, cwd: string) => payload('PreToolUse', { cwd, tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch\n` } })

  test('H20: a push waits for the user\'s say-so; their own words in the next prompt let it through', () => withSandbox(async () => {
    const consentCore: Partial<CoreFns> = { checkBash: () => ({}), checkWrite: () => ({}), checkQuestion: () => ({}), routeTool: allow, detectIntent: () => null }
    const denied = JSON.parse((await handleCodexHook('PreToolUse', bash('git push origin main'), ctx(), deps(consentCore))).stdout)
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain('Buracle H20')
    expect((await handleCodexHook('PreToolUse', bash('git status'), ctx(), deps(consentCore))).stdout).toBe('')
    await handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'evet, pushla' }), ctx(), deps(consentCore))
    expect((await handleCodexHook('PreToolUse', bash('git push origin main'), ctx(), deps(consentCore))).stdout).toBe('')
  }))

  test('H01 deny uses hookSpecificOutput.permissionDecision with a reason and nothing else', () => withSandbox(async () => {
    const r = await handleCodexHook('PreToolUse', bash('rm -rf /'), ctx(), deps({ ...quiet, checkBash: c => (c.startsWith('rm -rf /') ? { deny: 'deleting / is catastrophic' } : {}) }))
    const out = JSON.parse(r.stdout)
    expect(r.exitCode).toBe(0)
    expect(keys(out)).toEqual(['hookSpecificOutput'])
    expect(out.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Buracle H01: deleting / is catastrophic' })
  }))

  test('H02 checks apply_patch paths resolved against cwd', () => withSandbox(async () => {
    let seen: string[] = []
    const r = await handleCodexHook('PreToolUse', patch('*** Update File: .env\n@@\n-A=1\n+A=2', '/work/app'), ctx(), deps({
      ...quiet, checkWrite: p => { seen = p; return p.some(x => x.endsWith('/.env')) ? { deny: '.env holds secrets' } : {} },
    }))
    expect(seen).toEqual(['/work/app/.env'])
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toBe('Buracle H02: .env holds secrets')
  }))

  test('H02 also covers apply_patch fed through the shell', () => withSandbox(async () => {
    let seen: string[] = []
    const guard = deps({ ...quiet, checkWrite: p => { seen = p; return p.some(x => x.endsWith('.env.local')) ? { deny: 'secret file' } : {} } })
    const cmd = "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: /work/app/secrets/.env.local\n+TOKEN=x\n*** End Patch\nEOF"
    const r = await handleCodexHook('PreToolUse', bash(cmd), ctx(), guard)
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toBe('Buracle H02: secret file')
    await handleCodexHook('PreToolUse', bash("cd /srv/x && applypatch <<'EOF'\n*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch\nEOF"), ctx(), guard)
    expect(seen).toEqual(['/srv/x/a.ts'])
    const rel = await handleCodexHook('PreToolUse', bash("apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: secrets/.env.local\n+TOKEN=x\n*** End Patch\nEOF"), ctx(), deps(quiet))
    expect(JSON.parse(rel.stdout).hookSpecificOutput.permissionDecisionReason).toStartWith('Buracle H02: apply_patch through the shell resolves `secrets/.env.local`')
  }))

  test('H01 and H02 fail closed: a guard that cannot evaluate denies the call', () => withSandbox(async () => {
    const boom = () => { throw new Error('guard exploded') }
    const h01 = JSON.parse((await handleCodexHook('PreToolUse', bash('ls'), ctx(), deps({ ...quiet, checkBash: boom }))).stdout)
    expect(h01.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(h01.hookSpecificOutput.permissionDecisionReason).toStartWith('Buracle H01: the bash guard could not check this command (guard exploded)')
    const h02 = JSON.parse((await handleCodexHook('PreToolUse', patch('*** Add File: a.ts\n+x', '/work/app'), ctx(), deps({ ...quiet, checkWrite: boom }))).stdout)
    expect(h02.hookSpecificOutput.permissionDecisionReason).toStartWith('Buracle H02: the write guard could not check the files of this edit')
    const unclassified = JSON.parse((await handleCodexHook('PreToolUse', bash('ls'), ctx(), deps({ ...quiet, classifyTool: boom }))).stdout)
    expect(unclassified.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(await handleCodexHook('PreToolUse', payload('PreToolUse', { tool_name: 'request_user_input', tool_input: {} }), ctx(), deps({ ...quiet, classifyTool: boom }))).toEqual({ stdout: '', exitCode: 0 })
  }))

  test('the other PreToolUse hooks fail open', () => withSandbox(async () => {
    const boom = () => { throw new Error('not implemented: x') }
    expect(await handleCodexHook('PreToolUse', bash('ls'), ctx(), deps({ ...quiet, routeTool: boom, checkQuestion: boom }))).toEqual({ stdout: '', exitCode: 0 })
    expect(await handleCodexHook('PreToolUse', payload('PreToolUse', { tool_name: 'request_user_input', tool_input: { questions: [] } }), ctx(), deps({ ...quiet, checkQuestion: boom }))).toEqual({ stdout: '', exitCode: 0 })
  }))

  test('H02 buracleRepo: in a checkout named "buracle" all of <repo>/harness/** is protected; elsewhere only the generated subtrees', () => withSandbox(async ({ root }) => {
    const mkRepo = async (name: string, pkg: string) => {
      const dir = join(root, name)
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg }))
      expect((await run(['git', 'init', '-q'], { cwd: dir })).code).toBe(0)
      return dir
    }
    const buracle = await mkRepo('buracle-checkout', 'buracle')
    const other = await mkRepo('app', 'my-app')
    const d = deps({ ...quiet, checkWrite: core.checkWrite })
    const verdict = async (cwd: string, file: string, c = ctx()) => JSON.parse((await handleCodexHook('PreToolUse', patch(`*** Add File: ${file}\n+x`, cwd), c, d)).stdout || '{}').hookSpecificOutput?.permissionDecisionReason as string | undefined
    expect(await verdict(buracle, 'harness/notes.md')).toStartWith('Buracle H02: ')
    expect(await verdict(join(buracle, 'src'), '../harness/notes.md')).toStartWith('Buracle H02: ')
    expect(await verdict(other, 'harness/notes.md')).toBeUndefined()
    expect(await verdict(other, 'harness/codex/hooks.json')).toStartWith('Buracle H02: ')
    expect(await verdict(other, 'harness/notes.md', ctx(defaultConfig(), other))).toStartWith('Buracle H02: ')
    expect(await verdict(other, 'harness/notes.md', ctx({ ...defaultConfig(), repo: other }))).toStartWith('Buracle H02: ')
  }), 30_000)

  test('SEC-1 with the real core: a relocated CLAUDE_CONFIG_DIR, and the checkout these hooks run from (from an unrelated session)', () => withSandbox(async ({ root }) => {
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    const real = deps({})
    const reason = async (input: string): Promise<string | undefined> => JSON.parse((await handleCodexHook('PreToolUse', input, ctx(), real)).stdout || '{}').hookSpecificOutput?.permissionDecisionReason
    const claude = join(root, 'relocated-claude')
    await withEnv({ CLAUDE_CONFIG_DIR: claude }, async () => {
      expect(await reason(patch(`*** Add File: ${join(claude, 'settings.json')}\n+{}`, proj))).toContain("Claude Code's own configuration")
      expect(await reason(bash(`echo '{}' > '${join(claude, 'settings.local.json')}'`, proj))).toContain("Claude Code's own configuration")
    })
    const target = join(REPO, 'src', 'cli', 'main.ts')
    expect(await reason(patch(`*** Add File: ${target}\n+x`, proj))).toContain("Buracle's own source code")
    expect(await reason(bash(`echo x > '${target}'`, proj))).toContain("Buracle's own source code")
    expect(await reason(bash(`cat '${target}'`, proj))).toBeUndefined()
  }))

  test('H09 sees the session state for request_user_input', () => withSandbox(async () => {
    saveState('codex', SID, planState())
    const r = await handleCodexHook('PreToolUse', payload('PreToolUse', { tool_name: 'request_user_input', tool_input: { questions: [{ question: 'Should I keep waiting?' }] } }), ctx(), deps({
      ...quiet, checkQuestion: s => (s.plan?.status === 'IN_PROGRESS' ? { deny: 'keep working' } : {}),
    }))
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toBe('Buracle H09: keep working')
  }))

  test('H03: a routing denial names its hook; routeTool owns the nudge (bashNudge is never called separately)', () => withSandbox(async () => {
    const deny = await handleCodexHook('PreToolUse', bash('grep -r foo .'), ctx(), deps({ ...quiet, routeTool: () => ({ action: 'deny', reason: 'use rg', hook: 'H03' }) }))
    expect(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecisionReason).toBe('Buracle H03: use rg')
    const nudge = await handleCodexHook('PreToolUse', bash('grep -r foo .'), ctx(), deps({ ...quiet, routeTool: () => ({ action: 'allow', context: ['Prefer rg.'] }) }))
    expect(JSON.parse(nudge.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'Prefer rg.' } })
    const never = () => { throw new Error('bashNudge must not be called by the adapter') }
    expect(await handleCodexHook('PreToolUse', bash('grep -r foo .'), ctx(), deps({ ...quiet, bashNudge: never }))).toEqual({ stdout: '', exitCode: 0 })
  }))

  test('path rules (R5): the first apply_patch of a matching file is denied once with the installed rule text; a shell read of the rule file counts', () => withSandbox(async ({ root }) => {
    const rules = paths.pathRulesDir()
    mkdirSync(rules, { recursive: true })
    writeFileSync(join(rules, 'go.md'), '---\npaths:\n  - "**/*.go"\n---\n# Go\n\n- Format with gofmt.\n')
    writeFileSync(join(rules, 'typescript.md'), '---\npaths:\n  - "**/*.ts"\n---\n# TypeScript\n\n- Keep strict on.\n')
    const app = join(root, 'app')
    mkdirSync(app, { recursive: true })
    const d = deps(quiet)
    const go = patch('*** Add File: cmd/main.go\n+package main', app)
    const first = JSON.parse((await handleCodexHook('PreToolUse', go, ctx(), d)).stdout)
    expect(first.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(first.hookSpecificOutput.permissionDecisionReason).toStartWith('Buracle H03: cmd/main.go matches the path rule `go`, which this session has not read yet.')
    expect(first.hookSpecificOutput.permissionDecisionReason).toContain('# Go\n\n- Format with gofmt.')
    expect((await handleCodexHook('PreToolUse', go, ctx(), d)).stdout).toBe('')
    expect((await handleCodexHook('PreToolUse', payload('PreToolUse', { cwd: app, tool_name: 'Bash', tool_use_id: 'c9', tool_input: { command: 'cat ~/.buracle/rules/paths/typescript.md' } }), ctx(), d)).stdout).toBe('')
    expect((await handleCodexHook('PreToolUse', patch('*** Add File: src/a.ts\n+export const a = 1', app), ctx(), d)).stdout).toBe('')
    const nudge = { ...defaultConfig(), routing: { ...defaultConfig().routing, strictness: 'nudge' as const } }
    const other = payload('PreToolUse', { session_id: '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5c', cwd: app, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: lib/x.go\n+package lib\n*** End Patch\n' } })
    expect(JSON.parse((await handleCodexHook('PreToolUse', other, ctx(nudge), d)).stdout).hookSpecificOutput.additionalContext).toContain('lib/x.go matches the path rule `go`; follow it for this change.')
  }))

  test('real core: a shell file write points to apply_patch once per session; Codex gets no read note (it has no file-read tool)', () => withSandbox(async () => {
    const real = deps({})
    const w = JSON.parse((await handleCodexHook('PreToolUse', bash("sed -i 's/a/b/' src/a.ts"), ctx(), real)).stdout)
    expect(w.hookSpecificOutput.additionalContext).toContain('this shell command writes `src/a.ts` (sed -i in place). Make ordinary source edits with apply_patch instead')
    expect((await handleCodexHook('PreToolUse', bash('echo x > src/b.ts'), ctx(), real)).stdout).toBe('')
    expect((await handleCodexHook('PreToolUse', bash('cat src/a.ts'), ctx(), real)).stdout).toBe('')
  }))

  test('real core: rm -rf / is denied, ls is allowed', () => withSandbox(async () => {
    const real = deps({})
    const r = await handleCodexHook('PreToolUse', bash('rm -rf /'), ctx(), real)
    expect(JSON.parse(r.stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toStartWith('Buracle H01: ')
    expect((await handleCodexHook('PreToolUse', bash('ls -la'), ctx(), real)).stdout).toBe('')
  }))
})

describe('PostToolUse', () => {
  test('apply_patch: H04 notes become additionalContext; the edit is spooled', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'x.py'), 'import os\n')
    const patch = '*** Begin Patch\n*** Add File: x.py\n+import os\n*** End Patch\n'
    const d = deps({
      ...quiet,
      checkersFor: p => [{ argv: ['ruff', 'check', p], cwd, timeoutMs: 20000, parser: 'ruff' }],
      findingsOf: (_plan, res) => (res && res.code !== 0 ? `ruff: ${res.stdout}` : undefined),
      tddHint: () => 'No test file next to x.py; add one.',
      charsetFindings: added => (added.includes('import') ? ['plain ASCII'] : []),
      lengthNote: () => undefined,
    })
    const r = await handleCodexHook('PostToolUse', payload('PostToolUse', { cwd, tool_name: 'apply_patch', tool_input: { command: patch }, tool_response: 'Success. Updated the following files:\nA x.py' }), ctx(), d)
    const out = JSON.parse(r.stdout)
    expect(keys(out)).toEqual(['hookSpecificOutput'])
    expect(keys(out.hookSpecificOutput)).toEqual(['additionalContext', 'hookEventName'])
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    const text: string = out.hookSpecificOutput.additionalContext
    expect(text).toContain('\n\nx.py:\n')
    expect(text).toContain('- ruff: x.py:1:1: F401 unused import')
    expect(text).toContain('- No test file next to x.py; add one.')
    expect(text).toContain('- plain ASCII')
    expect(d.rec.runs).toEqual([['ruff', 'check', join(cwd, 'x.py')]])
    expect(d.rec.spool).toEqual([{ ts: NOW, ev: 'tool', tool: 'apply_patch', kind: 'patch', paths: [join(cwd, 'x.py')] }])
  }))

  test('apply_patch with the real checkers: a missing linter is named once per session, a mirrored test folder silences the TDD note', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'proj')
    mkdirSync(join(cwd, 'src', 'core'), { recursive: true })
    mkdirSync(join(cwd, 'tests', 'core'), { recursive: true })
    writeFileSync(join(cwd, 'run.sh'), 'echo $1\n')
    writeFileSync(join(cwd, 'src', 'core', 'x.ts'), 'export const x = 2\n')
    writeFileSync(join(cwd, 'tests', 'core', 'x.test.ts'), "import { x } from '../../src/core/x'\n")
    const d = { ...deps(quiet), run: async () => ({ code: 127, stdout: '', stderr: 'spawn shellcheck ENOENT', timedOut: false }) }
    const post = async (patch: string) => (await handleCodexHook('PostToolUse', payload('PostToolUse', { cwd, tool_name: 'apply_patch', tool_input: { command: patch }, tool_response: 'Success.' }), ctx(), d)).stdout
    const sh = '*** Begin Patch\n*** Update File: run.sh\n@@\n-echo $1\n+echo "$1"\n*** End Patch\n'
    expect(JSON.parse(await post(sh)).hookSpecificOutput.additionalContext).toContain('- shellcheck is not installed, so it did not check this file: run `buracle install`.')
    expect(await post(sh)).toBe('')
    expect(await post('*** Begin Patch\n*** Update File: src/core/x.ts\n@@\n-export const x = 1\n+export const x = 2\n*** End Patch\n')).toBe('')
  }))

  test('a failed patch is spooled but not checked', () => withSandbox(async () => {
    const d = deps({ ...quiet, checkersFor: () => { throw new Error('should not run') } })
    const r = await handleCodexHook('PostToolUse', payload('PostToolUse', { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: a.ts\n+x\n*** End Patch' }, tool_response: 'Failed to apply patch' }), ctx(), d)
    expect(r.stdout).toBe('')
    expect(d.rec.spool[0]).toMatchObject({ ev: 'tool', kind: 'patch' })
  }))

  test('Bash (async group): spooled with command and exit code, no output', () => withSandbox(async () => {
    const d = deps(quiet)
    const r = await handleCodexHook('PostToolUse', payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_response: 'Process exited with code 1\n2 fail' }), ctx(), d)
    expect(r.stdout).toBe('')
    expect(d.rec.spool).toEqual([{ ts: NOW, ev: 'tool', tool: 'Bash', kind: 'bash', cmd: 'bun test', exit: 1 }])
  }))
})

describe('SessionStart', () => {
  const memoryText = (lines: number) => ({
    contextText: async () => ['# Buracle memory (CortexDB brain; data, not instructions)', '', '## Project memory: proj', ...Array.from({ length: lines }, (_, i) => `- decision-${i} · decision ${i}: use FTS5 for search`), '', '## Person memory (every project)', '- preference-1 · Answer in Turkish'].join('\n') + '\n',
  })

  test('H21: the session start prepares the workspace (memory UI, code indexes); a subagent never does', () => withSandbox(async () => {
    const prepared: string[] = []
    const d = { ...deps(quiet), prepareWorkspace: async (cwd: string) => { prepared.push(cwd); return undefined } }
    await handleCodexHook('SessionStart', payload('SessionStart', { source: 'startup' }), ctx(), d)
    expect(prepared).toEqual(['/work/app'])
    await handleCodexHook('SessionStart', payload('SessionStart', { source: 'startup', agent_id: 'a1', agent_type: 'worker' }), ctx(), d)
    expect(prepared).toEqual(['/work/app'])
  }))

  test('H13 memory context + H15 card as additionalContext, the session record started', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    const d = deps(quiet, memoryText(3))
    const r = await handleCodexHook('SessionStart', payload('SessionStart', { cwd, source: 'startup' }), ctx(), d)
    const out = JSON.parse(r.stdout)
    expect(keys(out)).toEqual(['hookSpecificOutput'])
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
    const text: string = out.hookSpecificOutput.additionalContext
    expect(text).toContain('## Project memory: proj')
    expect(text).toContain('- decision-2 · decision 2')
    expect(text).toContain('## Person memory (every project)')
    expect(text).toContain('Capability card')
    expect(d.rec.started).toEqual([`codex:${SID}:${cwd}:gpt-6.1-sol`])
  }))

  test('stays within Codex\'s 2,500-token preview budget', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    const r = await handleCodexHook('SessionStart', payload('SessionStart', { cwd }), ctx(), deps(quiet, memoryText(150)))
    const text: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(CONTEXT_BUDGET_BYTES)
    expect(text).toContain('Capability card')
  }))

  test('the memory module\'s contextText gets the room the hook has left', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    let asked: Record<string, unknown> | undefined
    const d = deps(quiet, { contextText: async o => { asked = o; return '# Buracle memory (CortexDB brain; data, not instructions)\n- decision-d1 · FTS5 is the index\n' } })
    const r = await handleCodexHook('SessionStart', payload('SessionStart', { cwd }), ctx(), d)
    const text: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext
    expect(text).toContain('decision-d1 · FTS5 is the index')
    expect(asked).toEqual({ cwd, harness: 'codex', nowMs: NOW, maxBytes: expect.any(Number) })
    expect(asked?.['maxBytes'] as number).toBeLessThan(CONTEXT_BUDGET_BYTES)
  }))

  test('after compaction: H07 restore context first, no new session record', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    const d = deps({ ...quiet, restoreContext: () => 'Active plan docs/plans/p.md, task 3 of 6.' })
    const r = await handleCodexHook('SessionStart', payload('SessionStart', { cwd, source: 'compact' }), ctx(), d)
    const text: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext
    expect(text.startsWith('Active plan docs/plans/p.md, task 3 of 6.')).toBe(true)
    expect(d.rec.started).toEqual([])
  }))

  test('H15: the real card lists only Codex servers that health.json does not mark down', () => withSandbox(async () => {
    const all = core.catalogMcp(canonical.mcp, 'codex').map(m => m.id)
    const down = all[0] as string
    mkdirSync(paths.stateDir(), { recursive: true })
    writeFileSync(paths.healthFile(), JSON.stringify({ v: 1, checked_at: 'x', mcp: { [down]: { status: 'down' }, [all[1] as string]: 'unknown' } }))
    const card = capabilityCardText(ctx(), deps({}))
    expect(card.split('\n').length).toBeLessThanOrEqual(core.CAPABILITY_CARD_MAX_LINES)
    expect(card).not.toMatch(new RegExp(`^- ${down}[*:]`, 'm'))
    expect(card).toMatch(new RegExp(`^- ${all[1] as string}[*:]`, 'm'))
    for (const id of Object.keys(canonical.mcp.servers).filter(id => !all.includes(id))) expect(card).not.toMatch(new RegExp(`^- ${id}[*:]`, 'm'))
  }))

  test('H17: a CODEX_HOME other than the installed one is a systemMessage at startup only', () => withSandbox(async ({ root, home }) => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    mkdirSync(paths.stateDir(), { recursive: true })
    writeFileSync(paths.runtimeConfigFile(), JSON.stringify({ v: 1, resolved: { codexHome: join(home, '.codex') } }))
    const other = deps(quiet, {}, { CODEX_HOME: join(root, 'other-codex') })
    const out = JSON.parse((await handleCodexHook('SessionStart', payload('SessionStart', { cwd, source: 'startup' }), ctx(), other)).stdout)
    expect(keys(out)).toEqual(['hookSpecificOutput', 'systemMessage'])
    expect(out.systemMessage).toContain(join(root, 'other-codex'))
    expect(out.systemMessage).toContain('buracle install codex')
    expect(JSON.parse((await handleCodexHook('SessionStart', payload('SessionStart', { cwd, source: 'resume' }), ctx(), other)).stdout).systemMessage).toBeUndefined()
    expect(JSON.parse((await handleCodexHook('SessionStart', payload('SessionStart', { cwd, source: 'startup' }), ctx(), deps(quiet))).stdout).systemMessage).toBeUndefined()
  }))

  test('H17 notices: the first startup tells the user and the model once per machine; a resume or a later session does not', () => withSandbox(async ({ root }) => withEnv({ BURACLE_NO_NOTICES: undefined }, async () => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    const c = { ...ctx(), canonical: { ...canonical, notices: [{ id: 'codex-test', since: '0.0.1', message: 'A notice for Codex.' }] } }
    const resumed = JSON.parse((await handleCodexHook('SessionStart', payload('SessionStart', { cwd, source: 'resume' }), c, deps(quiet))).stdout)
    expect(resumed.systemMessage).toBeUndefined()
    const out = JSON.parse((await handleCodexHook('SessionStart', payload('SessionStart', { cwd, source: 'startup' }), c, deps(quiet))).stdout)
    expect(out.systemMessage).toBe('Buracle 0.0.1: A notice for Codex.')
    expect(out.hookSpecificOutput.additionalContext).toContain('Buracle notice, shown once on this machine.')
    const later = JSON.parse((await handleCodexHook('SessionStart', payload('SessionStart', { cwd, source: 'startup', session_id: '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5c' }), c, deps(quiet))).stdout)
    expect(later.systemMessage).toBeUndefined()
    expect(later.hookSpecificOutput.additionalContext).not.toContain('Buracle notice')
  })))

  test('H16: startup prunes long-idle Codex sessions, never the live one or other harnesses', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    const old = (h: 'codex' | 'claude', sid: string) => {
      const dir = paths.sessionDir(h, sid)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'state.json'), '{}')
      const t = (NOW - 20 * DAY) / 1000
      utimesSync(join(dir, 'state.json'), t, t)
      utimesSync(dir, t, t)
      return dir
    }
    const stale = old('codex', 'old-codex-session')
    const claude = old('claude', 'old-claude-session')
    const live = old('codex', SID)
    await handleCodexHook('SessionStart', payload('SessionStart', { cwd, source: 'resume' }), ctx(), deps(quiet))
    expect(existsSync(stale)).toBe(true)
    await handleCodexHook('SessionStart', payload('SessionStart', { cwd, source: 'startup' }), ctx(), deps(quiet))
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(live)).toBe(true)
    expect(existsSync(claude)).toBe(true)
  }))
})

describe('UserPromptSubmit', () => {
  test('a memory runner child (BURACLE_MEMORY_RUNNER=1) gets no context at session start or with its prompt', () => withSandbox(async () => {
    const runner = deps(quiet, {}, { BURACLE_MEMORY_RUNNER: '1' })
    expect(await handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'geçen sefer neden böyle yapmıştık?' }), ctx(), runner)).toEqual({ stdout: '', exitCode: 0 })
    expect(await handleCodexHook('SessionStart', payload('SessionStart', { cwd: REPO, source: 'startup' }), ctx(), runner)).toEqual({ stdout: '', exitCode: 0 })
    expect(runner.rec.spool).toEqual([])
  }))

  test('H22: a question about earlier work gets the router\'s memory line (English); a question is no statement, so only the prompt itself is spooled', () => withSandbox(async () => {
    const d = deps(quiet)
    const r = await handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'geçen sefer neden böyle yapmıştık?' }), ctx(), d)
    const out = JSON.parse(r.stdout)
    expect(keys(out.hookSpecificOutput)).toEqual(['additionalContext', 'hookEventName'])
    const text: string = out.hookSpecificOutput.additionalContext
    expect(text).toStartWith('Buracle routing for this prompt:')
    expect(text).toContain('Earlier work: search memory first (memory_search, then memory_get')
    expect(text).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/)
    expect(d.rec.spool).toEqual([{ ts: NOW, ev: 'prompt', excerpt: 'geçen sefer neden böyle yapmıştık?' }])
  }))

  test('H26: an explicit standing rule is spooled as a prompt-signal statement before the prompt; a workflow command or a language alone is not', () => withSandbox(async () => {
    const d = deps(quiet)
    const rule = 'Bundan sonra her zaman Türkçe yanıt ver.'
    await handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: rule }), ctx(), d)
    expect(d.rec.spool).toEqual([
      { ts: NOW, ev: 'prompt-signal', signal: { kind: 'statement', key: 'communication.reply_language=tr', category: 'communication', text: 'Reply in Turkish', quote: rule } },
      { ts: NOW, ev: 'prompt', excerpt: rule },
    ])
    const plain = deps(quiet)
    await handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: '$plan-build Bu projede testleri çalıştır' }), ctx(), plain)
    expect(plain.rec.spool.map(e => e.ev)).toEqual(['prompt'])
  }))

  test('session start, a prompt and a compaction spawn nothing: the record is started and touched in-process and only the end of the session starts the finalizer', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    const assets: string[] = []
    const d = deps(quiet)
    d.assetsSpawn = argv => { assets.push(argv.join(' ')) }
    await handleCodexHook('SessionStart', payload('SessionStart', { cwd, source: 'startup' }), ctx(), d)
    await handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { cwd, prompt: 'Bundan sonra her zaman Türkçe yanıt ver.' }), ctx(), d)
    await handleCodexHook('PreCompact', payload('PreCompact', { cwd, trigger: 'auto' }), ctx(), d)
    await handleCodexHook('PostCompact', payload('PostCompact', { cwd, trigger: 'auto' }), ctx(), d)
    await handleCodexHook('SessionStart', payload('SessionStart', { cwd, source: 'compact' }), ctx(), d)
    expect(d.rec.finalizer).toEqual([])
    expect(d.rec.runs).toEqual([])
    expect(assets).toEqual([])
    expect(d.rec.started).toEqual([`codex:${SID}:${cwd}:gpt-6.1-sol`])
    expect(d.rec.touched).toEqual([`codex:${SID}`])
    await handleCodexHook('SessionEnd', payload('SessionEnd', { cwd, reason: 'other' }), ctx(), d)
    expect(d.rec.finalizer).toEqual([`codex:${SID}`])
  }))

  test('pause intent updates the session state through core promptInteraction', () => withSandbox(async () => {
    saveState('codex', SID, planState({ plan: { ...plan, path: 'p.md' } }))
    const seen: unknown[] = []
    const d = deps({ ...quiet, promptInteraction: (s, control, text, o) => { seen.push(control, text, o); return { next: { ...s, interaction: { state: 'paused', kind: 'discussion', since: o.now } }, guidance: 'Buracle: paused' } } })
    const r = await handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'dur' }), ctx(), d)
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('Buracle: paused')
    expect(seen).toEqual(['pause', 'dur', { autoPause: false, now: NOW }])
    expect(JSON.parse(readFileSync(statePath(), 'utf8')).interaction).toEqual({ state: 'paused', kind: 'discussion', since: NOW })
  }))

  test('real core: "dur" pauses and "devam" resumes a running plan; without a plan no state file appears', () => withSandbox(async () => {
    const d = deps({})
    await handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'dur' }), ctx(), d)
    expect(existsSync(statePath())).toBe(false)
    saveState('codex', SID, planState({ guard: { blocksForPlan: 3, blocksInChain: 2 } }))
    await handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'dur' }), ctx(), d)
    expect(loadState('codex', SID).interaction).toMatchObject({ state: 'paused', kind: 'discussion' })
    await handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'devam' }), ctx(), d)
    expect(loadState('codex', SID)).toMatchObject({ interaction: { state: 'running' }, guard: { blocksForPlan: 0, blocksInChain: 0 } })
  }))

  test('Buracle\'s own stop-guard continuation is ignored: no intent, no autoPause, no spool entry', () => withSandbox(async () => {
    saveState('codex', SID, planState())
    const d = deps({ detectIntent: () => { throw new Error('must not run') } })
    const text = `<hook_prompt hook_run_id="r1">${core.GUARD_MARKERS[0]} the plan docs/plans/p.md is IN_PROGRESS … dur.</hook_prompt>`
    const r = await handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: text }), ctx(withPlan({ autoPause: true })), d)
    expect(r.stdout).toBe('')
    expect(loadState('codex', SID).interaction).toBeUndefined()
    expect(d.rec.spool).toEqual([])
  }))

  test('plan.autoPause: a user message during a running plan pauses it (kind discussion); off by default', () => withSandbox(async () => {
    saveState('codex', SID, planState())
    const prompt = payload('UserPromptSubmit', { prompt: 'Bu fonksiyon neden iki kez çağrılıyor?' })
    expect((await handleCodexHook('UserPromptSubmit', prompt, ctx(), deps({}))).stdout).toBe('')
    expect(loadState('codex', SID).interaction).toBeUndefined()
    const r = await handleCodexHook('UserPromptSubmit', prompt, ctx(withPlan({ autoPause: true })), deps({}))
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('plan.autoPause')
    expect(loadState('codex', SID).interaction).toEqual({ state: 'paused', kind: 'discussion', since: NOW, reason: 'the user sent a message while the plan was running (plan.autoPause)' })
    expect((await handleCodexHook('UserPromptSubmit', prompt, ctx(withPlan({ autoPause: true })), deps({}))).stdout).toBe('')
    saveState('codex', SID, planState({ plan: { ...plan, status: 'VERIFIED', phase: 'done' } }))
    expect((await handleCodexHook('UserPromptSubmit', prompt, ctx(withPlan({ autoPause: true })), deps({}))).stdout).toBe('')
  }))

  test('H05: one warning when the context crosses warnPct; H18 telemetry with model, effort, ctx and windows', () => withSandbox(async ({ root }) => {
    const rollout = join(root, 'rollout.jsonl')
    const reset = Math.floor(NOW / 1000) + 3600
    writeFileSync(rollout, [
      JSON.stringify({ timestamp: '2026-10-08T11:58:00.000Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'high' } }),
      JSON.stringify({ timestamp: '2026-10-08T11:59:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 240_000 }, model_context_window: 272_000 }, rate_limits: { limit_id: 'codex', primary: { used_percent: 40, window_minutes: 300, resets_at: reset } } } }),
    ].join('\n') + '\n')
    const p = payload('UserPromptSubmit', { prompt: 'go on', transcript_path: rollout })
    const first = await handleCodexHook('UserPromptSubmit', p, ctx(), deps(quiet))
    expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toContain('88% full')
    expect(await handleCodexHook('UserPromptSubmit', p, ctx(), deps(quiet))).toEqual({ stdout: '', exitCode: 0 })
    const t = readTelemetry('codex', SID)
    expect(t).toMatchObject({ harness: 'codex', model: 'gpt-6.1-sol', modelId: 'gpt-6.1-sol', effort: 'high', cwd: '/work/app', ctx: { pct: 88, tokens: 240_000, window: 272_000 }, at: NOW })
    expect(t?.windows).toEqual([{ pct: 40, label: '5h', windowMinutes: 300, resetsAt: new Date(reset * 1000).toISOString() }])
  }))
})

describe('H05 follows the core contextWatch rule', () => {
  test('a context hovering around criticalPct warns once; only a compaction (below warnPct) re-arms it', () => withSandbox(async ({ root }) => {
    const rollout = join(root, 'rollout.jsonl')
    const at = (tokens: number) => writeFileSync(rollout, [
      JSON.stringify({ timestamp: '2026-10-08T11:58:00.000Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'high' } }),
      JSON.stringify({ timestamp: '2026-10-08T11:59:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: tokens }, model_context_window: 1_000_000 } } }),
    ].join('\n') + '\n')
    const prompt = () => handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'go on', transcript_path: rollout }), ctx(), deps(quiet))
    const said = (r: { stdout: string }) => (r.stdout === '' ? '' : String(JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? ''))
    at(960_000)
    expect(said(await prompt())).toContain('Codex will compact soon')
    at(880_000)
    expect(said(await prompt())).toBe('')
    at(970_000)
    expect(said(await prompt())).toBe('')
    await handleCodexHook('PostCompact', payload('PostCompact', { transcript_path: rollout, trigger: 'auto' }), ctx(), deps(quiet))
    at(860_000)
    expect(said(await prompt())).toContain('86% full')
  }))
})

describe('telemetry on the other events (H18)', () => {
  test('SessionStart, Stop and PostCompact write it; the payload model wins over turn_context; no data → no files', () => withSandbox(async ({ root }) => {
    const rollout = join(root, 'rollout.jsonl')
    writeFileSync(rollout, [
      JSON.stringify({ timestamp: '2026-10-08T11:58:00.000Z', type: 'turn_context', payload: { model: 'gpt-old', effort: 'low' } }),
      JSON.stringify({ timestamp: '2026-10-08T11:59:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 142_000 }, model_context_window: 272_000 } } }),
    ].join('\n') + '\n')
    for (const ev of ['SessionStart', 'Stop', 'PostCompact']) {
      writeTelemetry('codex', SID, { at: 1 })
      await handleCodexHook(ev, payload(ev, { transcript_path: rollout, model: 'gpt-6.1-sol' }), ctx(), deps(quiet))
      expect({ ev, t: readTelemetry('codex', SID) }).toMatchObject({ ev, t: { at: NOW, model: 'gpt-6.1-sol', effort: 'low', ctx: { pct: 50, tokens: 142_000, window: 272_000 } } })
    }
    const other = '019a1b2c-0000-7000-8000-000000000000'
    await handleCodexHook('Stop', JSON.stringify({ session_id: other, cwd: '/w', transcript_path: null }), ctx(), deps(quiet))
    expect(existsSync(paths.sessionDir('codex', other))).toBe(false)
  }))
})

describe('Stop (H08 + H11 through stopGuardVerdict) and SubagentStop', () => {
  test('block → {decision:"block", reason} only; the verdict runs under the state lock and `next` is persisted', () => withSandbox(async ({ root }) => {
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true })
    writeFileSync(join(root, 'docs', 'plans', 'p.md'), '# plan\n')
    saveState('codex', SID, planState())
    let seen: { input?: core.StopInput, check?: core.PlanDoc } = {}
    const d = deps({
      ...quiet,
      validatePlan: () => [{ level: 'error', code: 'x', message: 'bad' }],
      stopGuardVerdict: (s, input, _cfg, check) => {
        seen = { input, check }
        return { decision: { action: 'block', reason: `${core.GUARD_MARKERS[0]} keep going. ${core.STOP_GUARD_ESCAPE}`, hook: 'H08' }, next: { ...s, guard: { ...s.guard, blocksForPlan: s.guard.blocksForPlan + 1 } }, why: 'blocked' }
      },
    })
    const r = await handleCodexHook('Stop', payload('Stop', { cwd: root, stop_hook_active: true, last_assistant_message: 'Done with task 2.' }), ctx(), d)
    const out = JSON.parse(r.stdout)
    expect(keys(out)).toEqual(['decision', 'reason'])
    expect(out.decision).toBe('block')
    expect(out.reason).toBe(`${core.GUARD_MARKERS[0]} keep going. ${core.STOP_GUARD_ESCAPE}`)
    expect(core.isGuardContinuation(out.reason)).toBe(true)
    expect(seen.input).toMatchObject({ harness: 'codex', sessionId: SID, cwd: root, hookActive: true, lastMessage: 'Done with task 2.', now: NOW })
    expect(seen.check).toEqual({ exists: true, findings: [], text: '# plan\n' })
    expect(loadState('codex', SID).guard.blocksForPlan).toBe(1)
    expect(d.rec.spool).toEqual([{ ts: NOW, ev: 'stop', excerpt: 'Done with task 2.', model: 'gpt-6.1-sol' }])
  }))

  test('real core: H11 blocks a planning stop without a plan file, sharing the counters with H08', () => withSandbox(async ({ root }) => {
    saveState('codex', SID, planState({ plan: { ...plan, phase: 'plan', status: 'PENDING' } }))
    const r = await handleCodexHook('Stop', payload('Stop', { cwd: root, stop_hook_active: false }), ctx(), deps({}))
    const out = JSON.parse(r.stdout)
    expect(out.decision).toBe('block')
    expect(out.reason).toStartWith(core.GUARD_MARKERS[1])
    expect(loadState('codex', SID).guard).toMatchObject({ blocksForPlan: 1, blocksInChain: 1 })
  }))

  test('real core: an approved plan in progress is held; a paused one is not', () => withSandbox(async ({ root }) => {
    saveState('codex', SID, planState())
    const held = JSON.parse((await handleCodexHook('Stop', payload('Stop', { cwd: root }), ctx(), deps({}))).stdout)
    expect(held.reason).toStartWith(core.GUARD_MARKERS[0])
    saveState('codex', SID, planState({ interaction: { state: 'paused', kind: 'decision', since: 1 } }))
    expect(JSON.parse((await handleCodexHook('Stop', payload('Stop', { cwd: root }), ctx(), deps({}))).stdout)).toEqual({ systemMessage: 'Buracle workflow: plan-build: phase Implement, waiting for you' })
    expect((await handleCodexHook('Stop', payload('Stop', { cwd: root }), ctx(), deps({}))).stdout).toBe('')
  }))

  test('a runaway cap holds the turn once to ask the user, then releases it with a one-time user notice (systemMessage)', () => withSandbox(async ({ root }) => {
    const c = withPlan({ runaway: { perPlan: 30, perChain: 2 } })
    saveState('codex', SID, planState({ guard: { blocksForPlan: 4, blocksInChain: 2 } }))
    const escalate = JSON.parse((await handleCodexHook('Stop', payload('Stop', { cwd: root, stop_hook_active: true }), ctx(c), deps({}))).stdout)
    expect(keys(escalate)).toEqual(['decision', 'reason'])
    expect(escalate.reason).toContain('plan.runaway.perChain, 2')
    expect(escalate.reason).toContain('runaway: continue, pivot or abandon?')
    const chain = JSON.parse((await handleCodexHook('Stop', payload('Stop', { cwd: root, stop_hook_active: true }), ctx(c), deps({}))).stdout)
    expect(keys(chain)).toEqual(['systemMessage'])
    expect(chain.systemMessage).toContain('plan.runaway.perChain')
    const p30 = withPlan({ runaway: { perPlan: 3, perChain: 5 } })
    saveState('codex', SID, planState({ guard: { blocksForPlan: 3, blocksInChain: 0 } }))
    expect(JSON.parse((await handleCodexHook('Stop', payload('Stop', { cwd: root }), ctx(p30), deps({}))).stdout).reason).toContain('plan.runaway.perPlan, 3')
    const first = JSON.parse((await handleCodexHook('Stop', payload('Stop', { cwd: root }), ctx(p30), deps({}))).stdout)
    expect(first.systemMessage).toContain('plan.runaway.perPlan')
    expect((await handleCodexHook('Stop', payload('Stop', { cwd: root }), ctx(p30), deps({}))).stdout).toBe('')
  }))

  test('no registered plan: stopping is allowed silently and no state file is written', () => withSandbox(async () => {
    expect(await handleCodexHook('Stop', payload('Stop'), ctx(), deps(quiet))).toEqual({ stdout: '', exitCode: 0 })
    expect(existsSync(statePath())).toBe(false)
  }))

  test('a failing verdict fails open', () => withSandbox(async () => {
    saveState('codex', SID, planState())
    expect(await handleCodexHook('Stop', payload('Stop'), ctx(), deps({ ...quiet, stopGuardVerdict: () => { throw new Error('x') } }))).toEqual({ stdout: '', exitCode: 0 })
  }))

  test('H19: an invalid review report goes back to the reviewer once (block + reason), then only to the user; valid reports and other agents print nothing', () => withSandbox(async () => {
    const bad = await handleCodexHook('SubagentStop', payload('SubagentStop', { agent_id: 'a1', agent_type: 'changes-review', stop_hook_active: false, last_assistant_message: 'Looks good to me!' }), ctx(), deps(quiet))
    const out = JSON.parse(bad.stdout)
    expect(keys(out)).toEqual(['decision', 'reason'])
    expect(out.decision).toBe('block')
    expect(out.reason).toStartWith('Buracle H19: your final message is not a valid review report')
    expect(out.reason).toContain('Answer again with only the corrected JSON report')
    const again = JSON.parse((await handleCodexHook('SubagentStop', payload('SubagentStop', { agent_id: 'a1', agent_type: 'changes-review', stop_hook_active: true, last_assistant_message: 'still prose' }), ctx(), deps(quiet))).stdout)
    expect(keys(again)).toEqual(['systemMessage'])
    expect(again.systemMessage).toContain('changes-review returned an invalid review report again')
    const report = {
      verdict: 'pass', summary: 'docs/plans/p.md: all tasks done',
      findings: [{ severity: 'suggestion', category: 'maintainability', title: 't', evidence: 'e', suggested_fix: 'f' }],
      truths: [{ truth: 'export works', status: 'verified', evidence: 'bun test: 12 pass' }],
    }
    const good = await handleCodexHook('SubagentStop', payload('SubagentStop', { agent_type: 'changes-review', last_assistant_message: JSON.stringify(report) }), ctx(), deps(quiet))
    expect(good.stdout).toBe('')
    const otherAgent = await handleCodexHook('SubagentStop', payload('SubagentStop', { agent_type: 'plan-build-review', stop_hook_active: true, last_assistant_message: JSON.stringify({ ...report, summary: 'docs/plans/p.md: ok', truths: undefined }) }), ctx(), deps(quiet))
    expect(JSON.parse(otherAgent.stdout).systemMessage).toContain('plan-build-review returned an invalid review report')
    const local = await handleCodexHook('SubagentStop', payload('SubagentStop', { agent_type: 'changes-review', last_assistant_message: 'nope' }), ctx(), deps({ ...quiet, validateReviewJson: () => { throw new Error('not implemented: validateReviewJson') } }))
    expect(JSON.parse(local.stdout).reason).toContain('the final message is not a JSON object')
    expect((await handleCodexHook('SubagentStop', payload('SubagentStop', { agent_type: 'worker', last_assistant_message: 'x' }), ctx(), deps(quiet))).stdout).toBe('')
  }))

  test('review report contract checks', () => {
    expect(reviewReportErrors('{"verdict":"pass","summary":"x","findings":[]}')).toEqual([])
    expect(reviewReportErrors('{"verdict":"pass","summary":"x","findings":[{"severity":"must_fix","category":"c","title":"t","evidence":"e","suggested_fix":"f"}]}'))
      .toEqual(['verdict must be needs_changes exactly when a finding is must_fix or should_fix'])
    expect(reviewReportErrors('{"verdict":"maybe","findings":{}}')).toEqual(expect.arrayContaining(['verdict must be "pass" or "needs_changes"', 'findings must be an array']))
    expect(reviewReportErrors('{"verdict":"pass","summary":"x","findings":[],"goal_score":150}')).toEqual(['goal_score must be a number from 0 to 100'])
  })
})

describe('thread-spawned subagents (root session_id + agent_id/agent_type)', () => {
  const CHILD = '019a0000-0000-7000-8000-00000000beef'
  const sub = (event: string, extra: Record<string, unknown> = {}) => payload(event, { agent_id: CHILD, agent_type: 'changes-review', ...extra })
  const rolloutAt = (path: string, model: string, effort: string, tokens: number, window: number) => writeFileSync(path, [
    JSON.stringify({ timestamp: '2026-10-08T11:58:00.000Z', type: 'turn_context', payload: { model, effort } }),
    JSON.stringify({ timestamp: '2026-10-08T11:59:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: tokens }, model_context_window: window } } }),
  ].join('\n') + '\n')

  test('CODEX-SUBAGENT-UPS-H10: a subagent task message is not the user: no pause, no autoPause, no context, no spool', () => withSandbox(async () => {
    saveState('codex', SID, planState())
    const d = deps({})
    const r = await handleCodexHook('UserPromptSubmit', sub('UserPromptSubmit', { prompt: 'user_request: hata olursa dur ve bana sor\nReview the implemented changes.' }), ctx(withPlan({ autoPause: true })), d)
    expect(r).toEqual({ stdout: '', exitCode: 0 })
    expect(loadState('codex', SID).interaction).toBeUndefined()
    expect(d.rec.spool).toEqual([])
    await handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'dur' }), ctx(), d)
    expect(loadState('codex', SID).interaction).toMatchObject({ state: 'paused' })
  }))

  test('CODEX-SUBAGENT-TELEMETRY: subagent events never overwrite the session telemetry or re-arm ctxWarned', () => withSandbox(async ({ root }) => {
    const main = join(root, 'main.jsonl')
    const child = join(root, 'child.jsonl')
    rolloutAt(main, 'gpt-6.1-sol', 'high', 241_000, 272_000)
    rolloutAt(child, 'gpt-5.6-luna', 'low', 20_100, 272_000)
    const post = (p: string) => handleCodexHook('PostToolUse', p, ctx(), deps(quiet))
    const first = await post(payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, transcript_path: main }))
    expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toContain('88% full')
    const childOut = await post(sub('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo from-subagent' }, transcript_path: child, model: 'gpt-5.6-luna' }))
    expect(childOut.stdout).toBe('')
    expect(readTelemetry('codex', SID)).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high', ctx: { pct: 88 } })
    expect(JSON.parse(readFileSync(join(paths.sessionDir('codex', SID), 'codex.json'), 'utf8')).ctxWarned).toBe(85)
    expect((await post(payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, transcript_path: main }))).stdout).toBe('')
    const d = deps(quiet)
    await handleCodexHook('PostCompact', sub('PostCompact', { transcript_path: child, trigger: 'auto' }), ctx(), d)
    await handleCodexHook('PreCompact', sub('PreCompact', { trigger: 'auto' }), ctx(), d)
    expect(JSON.parse(readFileSync(join(paths.sessionDir('codex', SID), 'codex.json'), 'utf8')).ctxWarned).toBe(85)
    expect(d.rec.spool).toEqual([])
    expect(d.rec.handoffs).toEqual([])
  }))

  test('CODEX-SUBAGENT-THREAD-ID (I7): the subagent thread is mapped to the root session in aliases.json', () => withSandbox(async () => {
    const file = subagentAliasesFile(ctx())
    expect(await handleCodexHook('SubagentStart', sub('SubagentStart'), ctx(), deps(quiet))).toEqual({ stdout: '', exitCode: 0 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ [CHILD]: SID })
    const other = '019a0000-0000-7000-8000-00000000f00d'
    await handleCodexHook('PreToolUse', payload('PreToolUse', { agent_id: other, agent_type: 'worker', tool_name: 'Bash', tool_input: { command: 'buracle plan status --json' } }), ctx(), deps(quiet))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ [CHILD]: SID, [other]: SID })
    await handleCodexHook('PreToolUse', payload('PreToolUse', { agent_id: '../../x', tool_name: 'Bash', tool_input: { command: 'ls' } }), ctx(), deps(quiet))
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual([CHILD, other])
    for (let i = 0; i < MAX_SUBAGENT_ALIASES + 5; i++) recordSubagentAlias(ctx(), `019a0000-0000-7000-8000-${String(i).padStart(12, '0')}`, SID)
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).length).toBe(MAX_SUBAGENT_ALIASES)
  }), 60_000)

  test('subagent tool calls are still guarded (H01)', () => withSandbox(async () => {
    const r = await handleCodexHook('PreToolUse', sub('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf ~' } }), ctx(), deps({}))
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  }))
})

describe('compaction and session end', () => {
  test('PreCompact hands the handoff to the memory module and remembers its id for the restore', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    saveState('codex', SID, planState({ plan: { ...plan, path: 'p.md' } }))
    const d = deps({ ...quiet, handoffNote: i => ({ slug: `handoff-${i.project}`, markdown: `---\ntype: handoff\n---\nPlan ${i.state.plan?.slug}\n` }) })
    expect(await handleCodexHook('PreCompact', payload('PreCompact', { cwd, trigger: 'auto' }), ctx(), d)).toEqual({ stdout: '', exitCode: 0 })
    const id = await projectIdentity(cwd)
    expect(d.rec.handoffs).toEqual([{ harness: 'codex', sessionId: SID, cwd, project: id.slug, slug: `handoff-${id.slug}`, markdown: '---\ntype: handoff\n---\nPlan p\n', trigger: 'auto', now: NOW }])
    let seen: string | undefined
    await handleCodexHook('SessionStart', payload('SessionStart', { cwd, source: 'compact' }), ctx(), deps({ ...quiet, restoreContext: (_s, h) => { seen = h; return 'restored' } }))
    expect(seen).toBe(`handoff-${id.slug}`)
    expect(d.rec.spool).toEqual([{ ts: NOW, ev: 'compact', excerpt: 'PreCompact (auto)' }])
  }))

  test('without a handoff record the restore asks the memory for this session\'s own latest handoff', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    let seen: string | undefined
    const asked: unknown[] = []
    const d = deps({ ...quiet, restoreContext: (_s, h) => { seen = h; return 'restored' } }, { latestHandoff: async o => { asked.push(o); return { id: `handoff-${o.project}`, path: `handoff-${o.project}`, rel: `handoff-${o.project}`, title: 't' } } })
    await handleCodexHook('SessionStart', payload('SessionStart', { cwd, source: 'compact' }), ctx(), d)
    const id = await projectIdentity(cwd)
    expect(seen).toBe(`handoff-${id.slug}`)
    expect(asked).toEqual([{ project: id.slug, nowMs: NOW, session: SID }])
  }))

  test('when no handoff memory could be written, the open update_plan steps are kept for the session and inlined after compaction', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    const rollout = join(root, 'rollout.jsonl')
    const steps = [{ step: 'Write the parser', status: 'in_progress' }, { step: 'Done already', status: 'completed' }]
    writeFileSync(rollout, JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'update_plan', call_id: 'c1', arguments: JSON.stringify({ plan: steps }) } }) + '\n')
    const d = deps({ ...quiet, handoffNote: () => ({ slug: 's', markdown: '' }), restoreContext: core.restoreContext }, { writeHandoff: async () => undefined, latestHandoff: async () => { throw new Error('not asked') } })
    await handleCodexHook('PreCompact', payload('PreCompact', { cwd, trigger: 'auto', transcript_path: rollout }), ctx(), d)
    const r = await handleCodexHook('SessionStart', payload('SessionStart', { cwd, source: 'compact' }), ctx(), d)
    expect(r.stdout).toContain('Open todos at compaction time (no handoff memory was written):\\n- Write the parser')
  }))

  test('a later compaction with no handoff and every step completed drops the earlier open steps, and the restore offers no older handoff of the session', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    const rollout = join(root, 'rollout.jsonl')
    const planLine = (status: string) => JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'update_plan', call_id: 'c1', arguments: JSON.stringify({ plan: [{ step: 'Write the parser', status }] }) } }) + '\n'
    const asked: unknown[] = []
    const d = deps({ ...quiet, handoffNote: () => ({ slug: 's', markdown: '' }), restoreContext: core.restoreContext }, {
      writeHandoff: async () => undefined,
      latestHandoff: async o => { asked.push(o); return { id: 'handoff-earlier-compaction', path: 'handoff-earlier-compaction', rel: 'handoff-earlier-compaction', title: 't' } },
    })
    writeFileSync(rollout, planLine('in_progress'))
    await handleCodexHook('PreCompact', payload('PreCompact', { cwd, trigger: 'auto', transcript_path: rollout }), ctx(), d)
    expect(loadAdapterState(ctx(), SID).lastTodos).toEqual(['Write the parser'])
    writeFileSync(rollout, planLine('completed'))
    await handleCodexHook('PreCompact', payload('PreCompact', { cwd, trigger: 'auto', transcript_path: rollout }), ctx(), d)
    expect(loadAdapterState(ctx(), SID)).toMatchObject({ lastCompactAt: NOW })
    expect(loadAdapterState(ctx(), SID).lastTodos).toBeUndefined()
    const r = await handleCodexHook('SessionStart', payload('SessionStart', { cwd, source: 'compact' }), ctx(), d)
    expect(r.stdout).not.toContain('Open todos')
    expect(r.stdout).not.toContain('Write the parser')
    expect(r.stdout).not.toContain('handoff-earlier-compaction')
    expect(asked).toEqual([])
  }))

  test('the record is replaced before the handoff is written, so a hook killed during the write leaves this compaction\'s open steps', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    const rollout = join(root, 'rollout.jsonl')
    writeFileSync(rollout, JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'update_plan', call_id: 'c1', arguments: JSON.stringify({ plan: [{ step: 'Write the parser', status: 'in_progress' }] }) } }) + '\n')
    saveAdapterState(ctx(), SID, { v: 1, lastHandoff: 'handoff-earlier-compaction', lastCompactAt: NOW - 1000 })
    const during: unknown[] = []
    const d = deps({ ...quiet, handoffNote: () => ({ slug: 's', markdown: '' }) }, {
      writeHandoff: async () => { during.push(loadAdapterState(ctx(), SID)); return { id: 'handoff-now', path: 'handoff-now', rel: 'handoff-now', title: 't' } },
    })
    await handleCodexHook('PreCompact', payload('PreCompact', { cwd, trigger: 'auto', transcript_path: rollout }), ctx(), d)
    expect(during).toEqual([{ v: 1, lastCompactAt: NOW, lastTodos: ['Write the parser'] }])
    expect(loadAdapterState(ctx(), SID)).toEqual({ v: 1, lastCompactAt: NOW, lastHandoff: 'handoff-now' })
  }))

  test('PostCompact prints nothing and spools the compaction summary from the rollout (else a marker)', () => withSandbox(async ({ root }) => {
    const d = deps(quiet)
    expect(await handleCodexHook('PostCompact', payload('PostCompact', { trigger: 'manual' }), ctx(), d)).toEqual({ stdout: '', exitCode: 0 })
    expect(d.rec.spool).toEqual([{ ts: NOW, ev: 'compact', excerpt: 'PostCompact (manual)' }])
    const rollout = join(root, 'rollout.jsonl')
    writeFileSync(rollout, JSON.stringify({ timestamp: '2026-10-08T11:59:00.000Z', type: 'compacted', payload: { message: 'Plan p.md: task 3 of 6 done; next: the exporter tests.', replacement_history: [] } }) + '\n')
    const d2 = deps(quiet)
    await handleCodexHook('PostCompact', payload('PostCompact', { trigger: 'auto', transcript_path: rollout }), ctx(), d2)
    expect(d2.rec.spool).toEqual([{ ts: NOW, ev: 'compact', excerpt: 'Plan p.md: task 3 of 6 done; next: the exporter tests.' }])
  }))

  test('SessionEnd starts the detached finalizer and returns at once', () => withSandbox(async () => {
    const d = deps(quiet)
    const t0 = performance.now()
    expect(await handleCodexHook('SessionEnd', payload('SessionEnd', { reason: 'other' }), ctx(), d)).toEqual({ stdout: '', exitCode: 0 })
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(d.rec.finalizer).toEqual([`codex:${SID}`])
  }))

  test('SessionEnd without the memory module runs the CLI twin with the live environment (the HOME set after start)', () => withSandbox(async ({ root, home }) => {
    const seen = join(root, 'finalizer-home.txt')
    expect(fakeExe(join(paths.binDir(), 'buracle'), `fs.writeFileSync(${JSON.stringify(seen)}, process.env.HOME ?? '')`)).toBe(paths.shimPath())
    const d = { ...deps(quiet), memory: async () => ({}) }
    expect(await handleCodexHook('SessionEnd', payload('SessionEnd', { reason: 'other' }), ctx(), d)).toEqual({ stdout: '', exitCode: 0 })
    const deadline = Date.now() + 5_000
    while (!existsSync(seen) && Date.now() < deadline) await Bun.sleep(25)
    await Bun.sleep(50)
    expect(readFileSync(seen, 'utf8')).toBe(home)
  }), 15_000)

  test('missing memory modules do not break any event', () => withSandbox(async () => {
    const d = { ...deps(quiet), memory: async () => ({}) }
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostCompact', 'SessionEnd', 'Stop']) {
      const r = await handleCodexHook(ev, payload(ev), ctx(), d)
      expect(r.exitCode).toBe(0)
    }
    expect(existsSync(join(paths.sessionDir('codex', SID), 'telemetry.json'))).toBe(true)
  }))
})

describe('environment switches (CONTRACTS §4)', () => {
  test('BURACLE_NO_CAPTURE=1: no spool entries, no session stub, no finalizer; guards and context still work', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    const d = deps(quiet, {}, { BURACLE_NO_CAPTURE: '1' })
    const start = JSON.parse((await handleCodexHook('SessionStart', payload('SessionStart', { cwd }), ctx(), d)).stdout)
    expect(start.hookSpecificOutput.additionalContext).toContain('Capability card')
    for (const ev of ['UserPromptSubmit', 'PostToolUse', 'PreCompact', 'PostCompact', 'Stop', 'SessionEnd']) await handleCodexHook(ev, payload(ev, { cwd, tool_name: 'Bash', tool_input: { command: 'ls' }, last_assistant_message: 'x' }), ctx(), d)
    expect(d.rec).toMatchObject({ spool: [], started: [], finalizer: [] })
  }))

  test('BURACLE_NO_MEMORY=1: no memory context, no handoff and no capture either', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    saveState('codex', SID, planState())
    let asked = false
    const d = deps(quiet, { contextText: async () => { asked = true; return 'index' } }, { BURACLE_NO_MEMORY: '1' })
    await handleCodexHook('SessionStart', payload('SessionStart', { cwd }), ctx(), d)
    await handleCodexHook('PreCompact', payload('PreCompact', { cwd }), ctx(), d)
    expect(asked).toBe(false)
    expect(d.rec).toMatchObject({ spool: [], started: [], handoffs: [] })
  }))
})

describe('through the CLI dispatcher (a real hook process)', () => {
  test('SubagentStop with an invalid report prints the Codex block JSON the subagent receives', () => withSandbox(async ({ home, buracleHome }) => {
    const proc = Bun.spawnSync([process.execPath, join(REPO, 'src', 'cli', 'main.ts'), 'hook', 'codex', 'SubagentStop'], {
      stdin: new TextEncoder().encode(payload('SubagentStop', { agent_id: '019a1b2c-aaaa-7000-8000-000000000001', agent_type: 'plan-build-review', stop_hook_active: false, last_assistant_message: 'no json here' })),
      env: { ...process.env, HOME: home, BURACLE_HOME: buracleHome },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(proc.exitCode).toBe(0)
    expect(keys(JSON.parse(proc.stdout.toString()))).toEqual(['decision', 'reason'])
  }), 30_000)

  test('PreToolUse rm -rf / is denied end to end', () => withSandbox(async ({ home, buracleHome }) => {
    const proc = Bun.spawnSync([process.execPath, join(REPO, 'src', 'cli', 'main.ts'), 'hook', 'codex', 'PreToolUse'], {
      stdin: new TextEncoder().encode(payload('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } })),
      env: { ...process.env, HOME: home, BURACLE_HOME: buracleHome },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(proc.exitCode).toBe(0)
    expect(JSON.parse(proc.stdout.toString()).hookSpecificOutput.permissionDecision).toBe('deny')
  }), 30_000)
})

describe('w2 plan state on Codex: the lane guard, the async question pause, the H08 receipt and Plan mode', () => {
  const denied = (stdout: string): string | undefined => {
    if (stdout === '') return undefined
    const h = JSON.parse(stdout).hookSpecificOutput as Record<string, unknown> | undefined
    return h?.['permissionDecision'] === 'deny' ? String(h['permissionDecisionReason']) : undefined
  }
  const pre = (tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => payload('PreToolUse', { tool_name: tool, tool_input: input, tool_use_id: 'u1', ...extra })

  test('a subagent thread cannot change the root session\'s plan state; the root and read-only commands can', () => withSandbox(async () => {
    const lane = { agent_id: '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4b00', agent_type: 'worker' }
    expect(denied((await handleCodexHook('PreToolUse', pre('Bash', { command: 'buracle plan verify' }, lane), ctx(), deps({}))).stdout)).toContain('Buracle lane guard')
    expect(denied((await handleCodexHook('PreToolUse', pre('Bash', { command: 'buracle plan status --json' }, lane), ctx(), deps({}))).stdout)).toBeUndefined()
    expect(denied((await handleCodexHook('PreToolUse', pre('Bash', { command: 'buracle plan pause --kind decision' }), ctx(), deps({}))).stdout)).toBeUndefined()
  }))

  test('request_user_input_async records a decision pause and says so; the sync question only gets the reminder', () => withSandbox(async () => {
    saveState('codex', SID, planState())
    const q = { questions: [{ id: 'q1', header: 'DB', question: 'Redis or the in-memory store?', options: [{ label: 'Redis', description: '' }, { label: 'In-memory', description: '' }] }] }
    const sync = await handleCodexHook('PreToolUse', pre('request_user_input', q), ctx(), deps({}))
    expect(JSON.parse(sync.stdout).hookSpecificOutput.additionalContext).toContain('buracle plan pause --kind decision')
    expect(loadState('codex', SID).interaction).toBeUndefined()
    const async_ = await handleCodexHook('PreToolUse', pre('request_user_input_async', q), ctx(), deps({}))
    expect(JSON.parse(async_.stdout).hookSpecificOutput.additionalContext).toContain('recorded a decision pause')
    expect(loadState('codex', SID).interaction).toEqual({ state: 'paused', kind: 'decision', since: NOW, reason: 'Redis or the in-memory store?' })
    const reply = await handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'Redis' }), ctx(), deps({}))
    expect(JSON.parse(reply.stdout).hookSpecificOutput.additionalContext).toContain('If this message answers it, act on the answer and run `buracle plan resume`')
  }))

  test('the answer of a sync request_user_input during a decision pause is recorded; the async acknowledgement is not', () => withSandbox(async () => {
    saveState('codex', SID, planState({ interaction: { state: 'paused', kind: 'decision', since: NOW - 5, reason: 'merge decision' } }))
    const post = (tool: string, response: unknown) => payload('PostToolUse', { tool_name: tool, tool_input: { questions: [] }, tool_response: response, tool_use_id: 'u2' })
    await handleCodexHook('PostToolUse', post('request_user_input_async', '{"accepted":true}'), ctx(), deps({}))
    expect(loadState('codex', SID).interaction?.answeredAt).toBeUndefined()
    await handleCodexHook('PostToolUse', post('request_user_input', '{"answers":{"q1":{"answers":["Squash-merge"]}}}'), ctx(), deps({}))
    expect(loadState('codex', SID).interaction?.answeredAt).toBe(NOW)
  }))

  test('a stop in the Plan collaboration mode (read from the rollout) goes through with one notice', () => withSandbox(async ({ root }) => {
    saveState('codex', SID, planState())
    const rollout = join(root, 'rollout.jsonl')
    const turn = (mode: string) => JSON.stringify({ timestamp: '2026-10-08T12:00:00Z', type: 'turn_context', payload: { cwd: root, model: 'gpt-6.1-sol', collaboration_mode: { mode, settings: {} } } })
    writeFileSync(rollout, `${turn('default')}\n${turn('plan')}\n`)
    const out = JSON.parse((await handleCodexHook('Stop', payload('Stop', { cwd: root, transcript_path: rollout }), ctx(), deps({}))).stdout)
    expect(keys(out)).toEqual(['systemMessage'])
    expect(out.systemMessage).toContain('Plan mode (read-only)')
    expect((await handleCodexHook('Stop', payload('Stop', { cwd: root, transcript_path: rollout }), ctx(), deps({}))).stdout).toBe('')
    writeFileSync(rollout, `${turn('plan')}\n${turn('default')}\n`)
    const held = JSON.parse((await handleCodexHook('Stop', payload('Stop', { cwd: root, transcript_path: rollout }), ctx(), deps({}))).stdout)
    expect(held.decision).toBe('block')
  }))
})

describe('the memory UI hears about the session (memory.ui.autostart)', () => {
  function ui(): { calls: string[], hooks: NonNullable<ReturnType<typeof deps>['ui']> } {
    const calls: string[] = []
    return {
      calls,
      hooks: {
        started: async (h, s) => { calls.push(`started ${h} ${s}`) },
        seen: async (h, s) => { calls.push(`seen ${h} ${s}`) },
        ended: async (h, s) => { calls.push(`ended ${h} ${s}`) },
      },
    }
  }

  test('a session start, a prompt, a tool call and the session end reach it, with the capture off too; a subagent never does', () => withSandbox(async () => {
    const u = ui()
    const d = { ...deps({}, {}, { BURACLE_NO_CAPTURE: '1' }), ui: u.hooks }
    await handleCodexHook('SessionStart', payload('SessionStart', { source: 'startup' }), ctx(), d)
    await handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'hello' }), ctx(), d)
    await handleCodexHook('PostToolUse', payload('PostToolUse', { tool_name: 'shell', tool_input: { command: ['ls'] }, tool_response: 'ok' }), ctx(), d)
    await handleCodexHook('PostToolUse', payload('PostToolUse', { tool_name: 'shell', tool_input: { command: ['ls'] }, tool_response: 'ok', agent_id: 'a1' }), ctx(), d)
    await handleCodexHook('SessionEnd', payload('SessionEnd', {}), ctx(), d)
    expect(u.calls).toEqual([`started codex ${SID}`, `seen codex ${SID}`, `seen codex ${SID}`, `ended codex ${SID}`])
  }))
})
