import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeHook, type HookDeps } from '../../../src/adapters/claude/hook'
import type { AdapterContext } from '../../../src/adapters/registry'
import { defaultConfig } from '../../../src/core/config'
import type { CanonicalBundle } from '../../../src/core/catalog'
import type { Notice } from '../../../src/core/notices'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'
import { writeTelemetry } from '../../../src/workflow/session-store'
import { withEnv, withSandbox } from '../../helpers/sandbox'

const SID = 'sess-session-1'
const NOW = 1_800_000_000_000
const REPO = join(import.meta.dir, '..', '..', '..')
const NOTICE: Notice = { id: 'test-notice', since: '0.0.1', message: 'Hello from the notice test.' }
let base: CanonicalBundle | undefined

function ctx(notices: Notice[] = []): AdapterContext {
  const canonical = { ...(base ??= loadCanonicalSync(join(REPO, 'canonical'))), notices }
  return { repoRoot: REPO, config: defaultConfig(), paths, buracleBin: paths.shimPath(), canonical }
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
    ...over,
  }
}

function payload(event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: SID, cwd: '/tmp/project', hook_event_name: event, transcript_path: '/tmp/t.jsonl', permission_mode: 'bypassPermissions', ...extra })
}

function out(stdout: string): { context: string, system: string, decision?: string } {
  if (stdout === '') return { context: '', system: '' }
  const j = JSON.parse(stdout) as Record<string, unknown>
  const hso = (j['hookSpecificOutput'] ?? {}) as Record<string, unknown>
  return { context: String(hso['additionalContext'] ?? ''), system: String(j['systemMessage'] ?? ''), ...(typeof hso['permissionDecision'] === 'string' ? { decision: hso['permissionDecision'] } : {}) }
}

const bash = (command: string, extra: Record<string, unknown> = {}) => payload('PreToolUse', { tool_name: 'Bash', tool_input: { command }, ...extra })
const pct = (p: number) => writeTelemetry('claude', SID, { at: NOW, ctx: { pct: p, tokens: p * 1000, window: 100_000 } })

describe('H05 mid-turn: the context warning reaches the model with the next PreToolUse answer', () => {
  test('once per band, never with a denial, never in a subagent, and the next prompt does not repeat it', () => withSandbox(async () => {
    pct(87)
    const denied = out((await claudeHook('PreToolUse', bash('rm -rf ~'), ctx(), deps())).stdout)
    expect(denied.decision).toBe('deny')
    expect(denied.context).toBe('')
    const sub = out((await claudeHook('PreToolUse', bash('ls', { agent_id: 'agent-1', agent_type: 'Explore' }), ctx(), deps())).stdout)
    expect(sub.context).not.toContain('context window')
    const first = out((await claudeHook('PreToolUse', bash('ls'), ctx(), deps())).stdout)
    expect(first.decision).toBeUndefined()
    expect(first.context).toContain('Buracle: the context window is 87% full.')
    expect(out((await claudeHook('PreToolUse', bash('ls'), ctx(), deps())).stdout).context).not.toContain('context window')
    expect(out((await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'go on with the next task' }), ctx(), deps())).stdout).context).not.toContain('context window')
    pct(96)
    const critical = out((await claudeHook('PreToolUse', bash('ls'), ctx(), deps())).stdout)
    expect(critical.context).toContain('the context window is 96% full and Claude Code will compact soon')
  }))

  test('a band another hook already claimed is not warned again; dropping back to ok frees both bands', () => withSandbox(async () => {
    const dir = paths.sessionDir('claude', SID)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'context-warned-warn.claim'), '')
    pct(87)
    expect(out((await claudeHook('PreToolUse', bash('ls'), ctx(), deps())).stdout).context).not.toContain('context window')
    pct(96)
    expect(out((await claudeHook('PreToolUse', bash('ls'), ctx(), deps())).stdout).context).toContain('96% full')
    pct(40)
    expect(out((await claudeHook('PreToolUse', bash('ls'), ctx(), deps())).stdout).context).not.toContain('context window')
    expect(['warn', 'critical'].map(b => existsSync(join(dir, `context-warned-${b}.claim`)))).toEqual([false, false])
    pct(88)
    expect(out((await claudeHook('PreToolUse', bash('ls'), ctx(), deps())).stdout).context).toContain('88% full')
  }))

  test.skipIf(process.platform === 'win32')('parallel tool calls: six PreToolUse hook processes at once give the warning exactly once', () => withSandbox(async () => {
    writeTelemetry('claude', SID, { at: Date.now(), ctx: { pct: 87, tokens: 87_000, window: 100_000 } })
    const procs = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, join(REPO, 'src', 'cli', 'main.ts'), 'hook', 'claude', 'PreToolUse'], {
      stdin: new Blob([bash('ls')]), env: { ...process.env }, stdout: 'pipe', stderr: 'pipe',
    }))
    const outs = await Promise.all(procs.map(p => new Response(p.stdout).text()))
    expect(await Promise.all(procs.map(p => p.exited))).toEqual([0, 0, 0, 0, 0, 0])
    expect(outs.filter(o => o.includes('the context window is 87% full'))).toHaveLength(1)
  }), 30_000)

  test('stale telemetry (no status line for 5 minutes, as in print mode) gives no warning', () => withSandbox(async () => {
    writeTelemetry('claude', SID, { at: NOW - 6 * 60_000, ctx: { pct: 97, tokens: 97_000, window: 100_000 } })
    expect(out((await claudeHook('PreToolUse', bash('ls'), ctx(), deps())).stdout).context).not.toContain('context window')
  }))
})

describe('H17 one-time notices at a Claude Code session start', () => {
  test('the first startup claims the notice: one user line, one model line; later sessions, resumes and subagents get nothing', () => withSandbox(() => withEnv({ BURACLE_NO_NOTICES: undefined }, async () => {
    const sub = out((await claudeHook('SessionStart', payload('SessionStart', { source: 'startup', agent_id: 'agent-1' }), ctx([NOTICE]), deps())).stdout)
    expect(sub.system).toBe('')
    const resumed = out((await claudeHook('SessionStart', payload('SessionStart', { source: 'resume' }), ctx([NOTICE]), deps())).stdout)
    expect(resumed.system).toBe('')
    const first = out((await claudeHook('SessionStart', payload('SessionStart', { source: 'startup' }), ctx([NOTICE]), deps())).stdout)
    expect(first.system).toBe('Buracle 0.0.1: Hello from the notice test.')
    expect(first.context).toContain('Buracle notice, shown once on this machine.')
    expect(first.context).toContain('- Hello from the notice test.')
    expect(existsSync(join(paths.noticesDir(), 'test-notice.ack'))).toBe(true)
    const again = out((await claudeHook('SessionStart', payload('SessionStart', { source: 'startup', session_id: 'sess-session-2' }), ctx([NOTICE]), deps())).stdout)
    expect(again.system).toBe('')
    expect(again.context).not.toContain('Buracle notice')
  })))
})

describe('the memory UI hears about the session (memory.ui.autostart)', () => {
  function recorder(): { calls: string[], ui: NonNullable<HookDeps['ui']> } {
    const calls: string[] = []
    return {
      calls,
      ui: {
        started: async (h, s) => { calls.push(`started ${h} ${s}`) },
        seen: async (h, s) => { calls.push(`seen ${h} ${s}`) },
        ended: async (h, s) => { calls.push(`ended ${h} ${s}`) },
      },
    }
  }

  test('a session start, a prompt, a tool call and the session end reach it, with the capture off too', () => withSandbox(async () => {
    await withEnv({ BURACLE_NO_CAPTURE: '1' }, async () => {
      const r = recorder()
      await claudeHook('SessionStart', payload('SessionStart', { source: 'startup' }), ctx(), deps({ ui: r.ui }))
      await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'hello' }), ctx(), deps({ ui: r.ui }))
      await claudeHook('PostToolUse', payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: '' } }), ctx(), deps({ ui: r.ui }))
      await claudeHook('SessionEnd', payload('SessionEnd', { reason: 'exit' }), ctx(), deps({ ui: r.ui }))
      expect(r.calls).toEqual([`started claude ${SID}`, `seen claude ${SID}`, `seen claude ${SID}`, `ended claude ${SID}`])
    })
  }))

  test('a subagent never writes a record; a compaction is no new session', () => withSandbox(async () => {
    const r = recorder()
    await claudeHook('SessionStart', payload('SessionStart', { source: 'startup', agent_id: 'a1' }), ctx(), deps({ ui: r.ui }))
    await claudeHook('PostToolUse', payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {}, agent_id: 'a1' }), ctx(), deps({ ui: r.ui }))
    await claudeHook('SessionStart', payload('SessionStart', { source: 'compact' }), ctx(), deps({ ui: r.ui }))
    expect(r.calls).toEqual([`seen claude ${SID}`])
  }))

  test('a failing UI hook never breaks the session start', () => withSandbox(async () => {
    const boom = async () => { throw new Error('EIO') }
    const res = await claudeHook('SessionStart', payload('SessionStart', { source: 'startup' }), ctx(), deps({ ui: { started: boom, seen: boom, ended: boom } }))
    expect(res.exitCode).toBe(0)
    expect(out(res.stdout).context).toContain('Buracle')
  }))
})
