import { describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../../../src/engine/proc'
import { withSandbox } from '../../helpers/sandbox'
import { GIT_TEST_ENV } from '../../workflow/fixture'

const CLI = join(import.meta.dir, '..', '..', '..', 'src', 'cli', 'main.ts')

function fakeHarness(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  symlinkSync('/bin/sh', path)
  return path
}

const NO_SESSION_VARS = {
  BURACLE_SESSION_ID: undefined, BURACLE_HARNESS: undefined, CLAUDE_CODE_SESSION_ID: undefined,
  CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined, OPENCODE_SESSION_ID: undefined, OMP_SESSION_ID: undefined,
}

async function statusUnder(shell: string, cwd: string, env: Record<string, string | undefined>): Promise<{ code: number, session: unknown, stderr: string }> {
  const r = await run([shell, '-c', `"${process.execPath}" "${CLI}" plan status --json; true`], { cwd, env: { ...GIT_TEST_ENV, BURACLE_NO_MEMORY: '1', ...NO_SESSION_VARS, ...env }, timeoutMs: 60_000 })
  let session: unknown
  try { session = (JSON.parse(r.stdout) as { session?: unknown }).session } catch { session = r.stdout }
  return { code: r.code, session, stderr: r.stderr }
}

const INHERITED_CLAUDE = { BURACLE_SESSION_ID: 'claude-parent', BURACLE_HARNESS: 'claude', CLAUDE_CODE_SESSION_ID: 'claude-parent' }

describe('nested harness shells, end to end', () => {
  test('a Codex started from a Claude Code shell binds to its own session', () => withSandbox(async ({ root, home, buracleHome }) => {
    const codex = fakeHarness(join(root, 'bin-codex'), 'codex')
    const r = await statusUnder(codex, root, { HOME: home, BURACLE_HOME: buracleHome, ...INHERITED_CLAUDE, CODEX_THREAD_ID: 'codex-root', CODEX_SESSION_ID: 'codex-root' })
    expect(r.session).toEqual({ harness: 'codex', id: 'codex-root', source: 'CODEX_SESSION_ID' })
  }), 60_000)

  test('a Claude Code started from a Codex shell binds to the Claude session', () => withSandbox(async ({ root, home, buracleHome }) => {
    const claude = fakeHarness(join(root, 'bin-claude'), 'claude')
    const r = await statusUnder(claude, root, { HOME: home, BURACLE_HOME: buracleHome, ...INHERITED_CLAUDE, CODEX_THREAD_ID: 'codex-root', CODEX_SESSION_ID: 'codex-root' })
    expect(r.session).toEqual({ harness: 'claude', id: 'claude-parent', source: 'BURACLE_SESSION_ID' })
  }), 60_000)

  test('a Codex subagent shell resolves to the root session the hooks use', () => withSandbox(async ({ root, home, buracleHome }) => {
    const codex = fakeHarness(join(root, 'bin-codex'), 'codex')
    const r = await statusUnder(codex, root, { HOME: home, BURACLE_HOME: buracleHome, CODEX_THREAD_ID: 'sub-thread', CODEX_SESSION_ID: 'root-session' })
    expect(r.session).toEqual({ harness: 'codex', id: 'root-session', source: 'CODEX_SESSION_ID' })
  }), 60_000)
})

describe('a removed working directory (WF-11)', () => {
  test('session-only commands still run, from the nearest existing parent, with one warning', () => withSandbox(async ({ root, home, buracleHome }) => {
    const gone = join(root, 'repo', '.worktrees', 'inside-probe')
    mkdirSync(gone, { recursive: true })
    const script = `cd "${gone}" && rmdir "${gone}" && "${process.execPath}" "${CLI}" plan status --json --session wf11 --harness claude`
    const r = await run(['/bin/sh', '-c', script], { cwd: root, env: { ...GIT_TEST_ENV, ...NO_SESSION_VARS, HOME: home, BURACLE_HOME: buracleHome, BURACLE_NO_MEMORY: '1' }, timeoutMs: 60_000 })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ plan: null, session: { harness: 'claude', id: 'wf11' } })
    expect(r.stderr).toContain(`the current directory ${gone} no longer exists`)
    expect(r.stderr).toContain(`running from ${join(root, 'repo', '.worktrees')}`)
    expect(r.stderr).not.toContain('uv_cwd')
  }), 60_000)
})
