import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { adapter } from '../../../src/adapters/qwen/index'
import { qwenMcpServers } from '../../../src/adapters/qwen/settings'
import * as paths from '../../../src/engine/paths'
import { run } from '../../../src/engine/proc'
import { applyPlans } from '../../../src/engine/txn'
import { withSandbox } from '../../helpers/sandbox'
import { canonical, ctx, REPO } from './helpers'

// The real `qwen` program, started with HOME and QWEN_HOME in the sandbox. It needs no login for what is checked here:
// the settings load, the MCP servers list, and the hooks that fire before a model is asked (SessionStart, UserPromptSubmit,
// SessionEnd) reach Buracle. The hooks that need a model turn (PreToolUse, PostToolUse, Stop) cannot run without a login
// and a model, so they are checked on the same command line with a payload in the shape the docs give (hook.test.ts, doctor.test.ts).
const QWEN = Bun.which('qwen') ?? undefined
const live = QWEN === undefined ? test.skip : test
const NOTE = QWEN === undefined ? ' (skipped: qwen is not on PATH)' : ''

function shim(): string {
  const bin = join(paths.buracleHome(), 'bin')
  mkdirSync(bin, { recursive: true })
  const file = join(bin, 'buracle')
  writeFileSync(file, `#!/bin/sh\nexec ${process.execPath} ${join(REPO, 'src', 'cli', 'main.ts')} "$@"\n`)
  chmodSync(file, 0o755)
  return file
}

function qwenEnv(home: string): Record<string, string | undefined> {
  return { ...process.env, HOME: home, QWEN_HOME: join(home, '.qwen'), TERM: 'dumb', NO_COLOR: '1', BURACLE_NO_AUTOSTART: '1' }
}

async function installed(home: string): Promise<void> {
  mkdirSync(join(home, '.qwen'), { recursive: true })
  // The user's own keys: a login-free provider choice, so the program starts a session and fires its hooks, then stops at the model.
  writeFileSync(join(home, '.qwen', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'openai' } }, model: { name: 'mock' } }, null, 2))
  shim()
  const r = await applyPlans([await adapter.installPlan(ctx())])
  expect(r.conflicts).toEqual([])
}

describe(`the real qwen program${NOTE}`, () => {
  live('reads the settings Buracle wrote: every shipped MCP server is listed, and no hook config is rejected', () => withSandbox(async ({ home }) => {
    await installed(home)
    const list = await run([QWEN as string, 'mcp', 'list'], { cwd: home, env: qwenEnv(home), timeoutMs: 60_000 })
    expect(list.code).toBe(0)
    for (const id of Object.keys(qwenMcpServers(canonical, ctx().buracleBin))) expect({ id, listed: list.stdout.includes(`${id}:`) }).toEqual({ id, listed: true })
    const p = await run([QWEN as string, '-p', 'hi', '--no-session-persistence'], { cwd: home, env: qwenEnv(home), timeoutMs: 60_000 })
    expect(p.stderr + p.stdout).not.toMatch(/error loading hook configs/i)
  }), 120_000)

  live('fires the hooks: SessionStart and UserPromptSubmit reach Buracle, which records the session and the prompt', () => withSandbox(async ({ home }) => {
    await installed(home)
    const p = await run([QWEN as string, '-p', 'hello from the smoke test', '--no-session-persistence'], { cwd: home, env: qwenEnv(home), timeoutMs: 90_000 })
    expect(p.stderr + p.stdout).not.toMatch(/error loading hook configs/i)
    // The workspace file is written by Buracle's SessionStart; the program ends before a model answers, which is expected here.
    const sessions = existsSync(paths.sessionsDir('qwen')) ? readdirSync(paths.sessionsDir('qwen')) : []
    expect(sessions.length).toBeGreaterThan(0)
    expect(existsSync(join(paths.sessionDir('qwen', sessions[0] as string), 'workspace.json'))).toBe(true)
  }), 120_000)

  live('the command the settings register denies a catastrophic shell command, run as the program runs it (a shell line)', () => withSandbox(async ({ home }) => {
    await installed(home)
    const settings = JSON.parse(readFileSync(join(home, '.qwen', 'settings.json'), 'utf8')) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } }
    const command = settings.hooks.PreToolUse[0]?.hooks[0]?.command as string
    const payload = JSON.stringify({ session_id: 'smoke-1', cwd: home, hook_event_name: 'PreToolUse', permission_mode: 'default', tool_name: 'run_shell_command', tool_input: { command: 'rm -rf ~' } })
    const r = await run(['/bin/sh', '-c', command], { stdin: payload, cwd: home, env: qwenEnv(home), timeoutMs: 60_000 })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } })
  }), 120_000)
})
