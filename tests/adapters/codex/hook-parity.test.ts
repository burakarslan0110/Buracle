import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handleCodexHook, type CoreFns } from '../../../src/adapters/codex/hook'
import { buracleHooksFile, POST_ANSWER_MATCHER, POST_CAPTURE_MATCHER, POST_MASK_MATCHER, POST_PATCH_MATCHER } from '../../../src/adapters/codex/hooks-config'
import { codexArtifacts } from '../../../src/adapters/codex/generate'
import { configTomlOps } from '../../../src/adapters/codex/install'
import { defaultConfig } from '../../../src/core/config'
import { handoffNote } from '../../../src/core/compact'
import { projectIdentity } from '../../../src/engine/git'
import { saveState } from '../../../src/workflow/session-store'
import { withSandbox } from '../../helpers/sandbox'
import { allow, canonical, ctx, deps, keys, payload, plan, planState, quiet, SID } from './hook-helpers'

const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE'

function callLine(name: string, callId: string, args: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: '2026-10-08T12:00:00.000Z', type: 'response_item', payload: { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId } })
}

describe('PostToolUseMask (guards.redact)', () => {
  const post = (extra: Record<string, unknown>) => payload('PostToolUse', { tool_use_id: 'c1', ...extra })

  test('a shell result with a secret is replaced by the masked output (block + reason), with a notice for the user', () => withSandbox(async () => {
    const r = await handleCodexHook('PostToolUseMask', post({ tool_name: 'Bash', tool_input: { command: 'cat .env' }, tool_response: `KEY=${AWS_KEY}\nPORT=8080` }), ctx(), deps(quiet))
    const out = JSON.parse(r.stdout) as Record<string, unknown>
    expect(keys(out)).toEqual(['decision', 'reason', 'systemMessage'])
    expect(out['decision']).toBe('block')
    expect(String(out['reason'])).not.toContain(AWS_KEY)
    expect(String(out['reason'])).toContain('PORT=8080')
    expect(String(out['reason'])).toContain('[REDACTED:aws]')
    expect(String(out['reason'])).toMatch(/the call itself ran/i)
    expect(out['systemMessage']).toBe('Buracle: 1 secret value hidden from the model')
  }))

  test('an MCP result is rendered from its text content, other parts named', () => withSandbox(async () => {
    const response = { content: [{ type: 'text', text: `token ${AWS_KEY}` }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }], isError: false }
    const r = await handleCodexHook('PostToolUseMask', post({ tool_name: 'mcp__context7__query_docs', tool_input: { q: 'x' }, tool_response: response }), ctx(), deps(quiet))
    const reason = String((JSON.parse(r.stdout) as Record<string, unknown>)['reason'])
    expect(reason).not.toContain(AWS_KEY)
    expect(reason).toContain('token [REDACTED:aws]')
    expect(reason).toContain('[image content not shown]')
  }))

  test('nothing for clean output, other tools, or guards.redact: false', () => withSandbox(async () => {
    const none = { stdout: '', exitCode: 0 }
    expect(await handleCodexHook('PostToolUseMask', post({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'a.txt b.txt nothing secret' }), ctx(), deps(quiet))).toEqual(none)
    expect(await handleCodexHook('PostToolUseMask', post({ tool_name: 'apply_patch', tool_input: { command: AWS_KEY }, tool_response: AWS_KEY }), ctx(), deps(quiet))).toEqual(none)
    const c = defaultConfig()
    const off = { ...c, guards: { ...c.guards, redact: false } }
    expect(await handleCodexHook('PostToolUseMask', post({ tool_name: 'Bash', tool_input: { command: 'cat .env' }, tool_response: AWS_KEY }), ctx(off), deps(quiet))).toEqual(none)
  }))

  test('hooks.json gets a synchronous PostToolUse group for the mask, after the existing groups (their trust keys keep their indexes)', () => {
    const groups = buracleHooksFile().hooks.PostToolUse ?? []
    expect(groups.map(g => g.matcher)).toEqual([POST_PATCH_MATCHER, POST_CAPTURE_MATCHER, POST_MASK_MATCHER, POST_ANSWER_MATCHER])
    const mask = groups[2]
    expect(mask?.hooks[0]?.async).toBeUndefined()
    expect(mask?.hooks[0]?.command).toMatch(/hook codex PostToolUseMask$/)
    expect(POST_MASK_MATCHER).toBe('^(Bash|mcp__.+)$')
  })
})

describe('G11: exec_command workdir for H01', () => {
  test('the guard judges a shell command in the workdir the model passed (from the rollout); without one, in the session folder', () => withSandbox(async ({ root, home }) => {
    const rollout = join(root, 'rollout.jsonl')
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    writeFileSync(rollout, [
      callLine('exec_command', 'call_home', { cmd: 'find . -delete', workdir: home }),
      callLine('exec_command', 'call_rel', { cmd: 'ls', workdir: 'sub' }),
      callLine('exec_command', 'call_none', { cmd: 'ls' }),
    ].join('\n') + '\n')
    const seen: string[] = []
    const d = deps({ ...quiet, checkBash: (_c, o) => { seen.push((o as { cwd?: string } | undefined)?.cwd ?? '?'); return {} } })
    const pre = (id: string, command: string) => payload('PreToolUse', { cwd, transcript_path: rollout, tool_name: 'Bash', tool_use_id: id, tool_input: { command } })
    await handleCodexHook('PreToolUse', pre('call_home', 'find . -delete'), ctx(), d)
    await handleCodexHook('PreToolUse', pre('call_rel', 'ls'), ctx(), d)
    await handleCodexHook('PreToolUse', pre('call_none', 'ls'), ctx(), d)
    await handleCodexHook('PreToolUse', pre('call_unknown', 'ls'), ctx(), d)
    expect(seen).toEqual([home, join(cwd, 'sub'), cwd, cwd])
  }))

  test('with the real guard: `rm -rf .buracle` in a workdir of the home folder is refused (Buracle\'s own folder)', () => withSandbox(async ({ root, home }) => {
    const rollout = join(root, 'rollout.jsonl')
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    writeFileSync(rollout, callLine('exec_command', 'call_h', { cmd: 'rm -rf .buracle', workdir: home }) + '\n')
    const core: Partial<CoreFns> = { routeTool: allow, checkQuestion: () => ({}) }
    const inProject = await handleCodexHook('PreToolUse', payload('PreToolUse', { cwd, tool_name: 'Bash', tool_use_id: 'call_x', tool_input: { command: 'rm -rf .buracle' } }), ctx(), deps(core))
    expect(inProject.stdout).not.toContain('Buracle H01')
    const inHome = await handleCodexHook('PreToolUse', payload('PreToolUse', { cwd, transcript_path: rollout, tool_name: 'Bash', tool_use_id: 'call_h', tool_input: { command: 'rm -rf .buracle' } }), ctx(), deps(core))
    const out = JSON.parse(inHome.stdout)
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('Buracle H01')
  }))
})

describe('P3: update_plan items as the handoff note\'s open todos', () => {
  test('the latest update_plan checklist (open steps) goes into the H06 note; a note is written at every compaction, with or without a plan or open steps', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    const rollout = join(root, 'rollout.jsonl')
    writeFileSync(rollout, [
      callLine('update_plan', 'call_p1', { plan: [{ step: 'Old step', status: 'pending' }] }),
      callLine('update_plan', 'call_p2', { explanation: 'x', plan: [{ step: 'Write the parser', status: 'completed' }, { step: 'Add the tests', status: 'in_progress' }, { step: 'Update the docs', status: 'pending' }] }),
    ].join('\n') + '\n')
    const todos: Array<string[] | undefined> = []
    const d = deps({ ...quiet, handoffNote: i => { todos.push(i.todo); return handoffNote(i) } })
    await handleCodexHook('PreCompact', payload('PreCompact', { cwd, trigger: 'auto', transcript_path: rollout }), ctx(), d)
    expect(todos).toEqual([['Add the tests', 'Update the docs']])
    expect(String(d.rec.handoffs[0]?.['markdown'])).toContain('- [ ] Add the tests')
    saveState('codex', SID, planState({ plan: { ...plan, path: 'p.md' } }))
    await handleCodexHook('PreCompact', payload('PreCompact', { cwd, trigger: 'auto', transcript_path: rollout }), ctx(), d)
    expect(todos.length).toBe(2)
    const id = await projectIdentity(cwd)
    expect(d.rec.handoffs.map(h => h['project'])).toEqual([id.slug, id.slug])
    const sub = join(root, 'other')
    mkdirSync(sub)
    const empty = join(root, 'empty.jsonl')
    writeFileSync(empty, callLine('update_plan', 'call_p3', { plan: [{ step: 'Done', status: 'completed' }] }) + '\n')
    const d2 = deps({ ...quiet, handoffNote: i => handoffNote(i) })
    await handleCodexHook('PreCompact', payload('PreCompact', { session_id: '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5c', cwd: sub, trigger: 'auto', transcript_path: empty }), ctx(), d2)
    expect(d2.rec.handoffs.map(h => h['project'])).toEqual([(await projectIdentity(sub)).slug])
    expect(String(d2.rec.handoffs[0]?.['markdown'])).toContain('None.')
    expect(String(d2.rec.handoffs[0]?.['markdown'])).toContain('None recorded.')
  }))
})

describe('M12: Codex native memories stay off', () => {
  test('the install plan writes `features.memories = false` as a soft key (a value the user set is kept)', () => {
    const a = codexArtifacts({ canonical, buracle: '/bin/buracle', pathRulesDir: '~/.buracle/rules/paths', config: defaultConfig() })
    const ops = configTomlOps('/h/.codex/config.toml', a)
    const op = ops.find(o => o.kind === 'toml-tables' && o.keys !== undefined && 'features.memories' in o.keys)
    expect(op).toMatchObject({ keys: { 'features.memories': false }, soft: ['features.memories'] })
  })
})
