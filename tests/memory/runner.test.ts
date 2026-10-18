import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness } from '../../src/core/events'
import { harnessRunner, runnerArgv, runnerModelId, sessionModel } from '../../src/memory/runner'
import { writeTelemetry } from '../../src/workflow/session-store'
import { withEnv, withSandbox } from '../helpers/sandbox'

const SID = '0199a213-81c0-7800-8aa1-bbab2a035a53'

function fakeCli(dir: string, name: string, opts: { exit?: number, stderr?: string } = {}): void {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, [
    '#!/bin/sh',
    'printf "%s\\n" "$@" > "$FAKE_LOG/argv"',
    'pwd -P > "$FAKE_LOG/cwd"',
    'printf "%s" "$PWD" > "$FAKE_LOG/pwd"',
    'env | grep "^BURACLE_NO_" | sort > "$FAKE_LOG/env"',
    'cat > "$FAKE_LOG/stdin"',
    'if [ -f .opencode/agents/buracle-memory-runner.md ]; then cp .opencode/agents/buracle-memory-runner.md "$FAKE_LOG/agent"; fi',
    opts.exit !== undefined ? `printf '%s' '${opts.stderr ?? ''}' >&2; exit ${opts.exit}` : 'echo "ANSWER from $(basename "$0")"',
    '',
  ].join('\n'))
  chmodSync(path, 0o755)
}

const CALL = { maxOutputTokens: 100, timeoutMs: 10_000 }

describe('runner', () => {
  test('each harness runs its own CLI headless, with the model it is given', () => {
    expect(runnerArgv('claude', 'claude-opus-5-5')).toEqual(['claude', '-p', '--model', 'claude-opus-5-5', '--no-session-persistence', '--tools', ''])
    expect(runnerArgv('codex', 'gpt-6-luna')).toEqual(['codex', 'exec', '--model', 'gpt-6-luna', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '-'])
    expect(runnerArgv('opencode', 'opencode/big-pickle')).toEqual(['opencode', 'run', '--agent', 'buracle-memory-runner', '--model', 'opencode/big-pickle'])
    expect(runnerArgv('omp', 'anthropic/claude-opus-5-5')).toEqual(['omp', '-p', '--model', 'anthropic/claude-opus-5-5', '--no-session', '--no-tools', '--no-skills', '--no-rules', '--no-lsp', '--no-title'])
    expect(runnerArgv('codex')).not.toContain('--model')
    for (const bad of ['--dangerously-skip-permissions', 'a b', '', '$(rm -rf ~)', undefined, 42]) {
      expect(runnerModelId(bad)).toBeUndefined()
      expect(runnerArgv('claude', bad as string)).not.toContain('--model')
    }
    expect(runnerModelId('claude-opus-5-5[1m]')).toBe('claude-opus-5-5[1m]')
  })

  test('the session model comes from the telemetry the harness wrote (its CLI id, not the display name)', async () => {
    await withSandbox(() => {
      expect(sessionModel('claude', SID)).toBeUndefined()
      writeTelemetry('claude', SID, { at: 1, model: 'Opus 5.5' })
      expect(sessionModel('claude', SID)).toBeUndefined()
      writeTelemetry('claude', SID, { at: 2, modelId: 'claude-opus-5-5' })
      expect(sessionModel('claude', SID)).toBe('claude-opus-5-5')
      writeTelemetry('omp', SID, { at: 3, modelId: '--evil' })
      expect(sessionModel('omp', SID)).toBeUndefined()
    })
  })

  test('the child gets the prompt on stdin and every Buracle switch that keeps it out of the memory', async () => {
    await withSandbox(async sb => {
      const bin = join(sb.root, 'bin')
      const log = join(sb.root, 'log')
      mkdirSync(log)
      for (const h of ['claude', 'codex', 'omp'] as Harness[]) fakeCli(bin, h)
      await withEnv({ PATH: `${bin}:/usr/bin:/bin`, FAKE_LOG: log }, async () => {
        for (const h of ['claude', 'codex', 'omp'] as Harness[]) {
          const out = await harnessRunner(h)('Distill this session.', { ...CALL, model: 'm-1' })
          expect(out).toEqual({ ok: true, text: `ANSWER from ${h}\n` })
          expect(readFileSync(join(log, 'argv'), 'utf8').split('\n').slice(0, -1)).toEqual(runnerArgv(h, 'm-1').slice(1))
          expect(readFileSync(join(log, 'stdin'), 'utf8')).toBe('Distill this session.')
          expect(readFileSync(join(log, 'cwd'), 'utf8').trim()).toBe(sb.home)
          expect(readFileSync(join(log, 'pwd'), 'utf8')).toBe(sb.home)
          expect(readFileSync(join(log, 'env'), 'utf8').trim().split('\n')).toEqual(expect.arrayContaining([
            'BURACLE_NO_AUTOSTART=1', 'BURACLE_NO_CAPTURE=1', 'BURACLE_NO_DISTILL=1', 'BURACLE_NO_MEMORY=1', 'BURACLE_NO_NOTIFY=1', 'BURACLE_NO_REFLECT=1', 'BURACLE_NO_VERIFY=1',
          ]))
        }
      })
    })
  })

  test('OpenCode runs in a throwaway folder whose agent denies every tool, and the folder goes afterwards', async () => {
    await withSandbox(async sb => {
      const bin = join(sb.root, 'bin')
      const log = join(sb.root, 'log')
      mkdirSync(log)
      fakeCli(bin, 'opencode')
      await withEnv({ PATH: `${bin}:/usr/bin:/bin`, FAKE_LOG: log }, async () => {
        const out = await harnessRunner('opencode')('p', { ...CALL, model: 'opencode/big-pickle' })
        expect(out.ok).toBe(true)
        const cwd = readFileSync(join(log, 'cwd'), 'utf8').trim()
        expect(cwd).not.toBe(sb.home)
        expect(existsSync(cwd)).toBe(false)
        const pwd = readFileSync(join(log, 'pwd'), 'utf8')
        expect(pwd.endsWith(cwd.split('/').pop() as string)).toBe(true)
        expect(pwd).not.toBe(process.cwd())
        const agent = readFileSync(join(log, 'agent'), 'utf8')
        expect(agent).toContain('mode: "primary"')
        expect(agent).toContain('- { action: "*", resource: "*", effect: "deny" }')
      })
    })
  })

  test('a harness that refuses or is missing gives a failed answer naming the harness (never another harness)', async () => {
    await withSandbox(async sb => {
      const bin = join(sb.root, 'bin')
      const log = join(sb.root, 'log')
      mkdirSync(log)
      fakeCli(bin, 'opencode', { exit: 1, stderr: '\u001b[91m\u001b[1mError: \u001b[0mfree tier only inside OpenCode' })
      await withEnv({ PATH: `${bin}:/usr/bin:/bin`, FAKE_LOG: log }, async () => {
        expect(await harnessRunner('opencode')('p', CALL)).toEqual({ ok: false, text: '', error: 'opencode: Error: free tier only inside OpenCode' })
        const missing = await harnessRunner('claude')('p', CALL)
        expect(missing.ok).toBe(false)
        expect(missing.error).toStartWith('claude: ')
      })
    })
  })
})
