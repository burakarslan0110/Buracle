import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfigSync, writeRuntimeConfig } from '../../src/engine/config'
import * as paths from '../../src/engine/paths'
import { withSandbox } from '../helpers/sandbox'

// The hook is one short-lived process per tool call, so what it loads is what every tool call pays for. The `yaml`
// package costs 8-11 ms to import and the merged configuration is already in runtime-config.json; these tests run
// the real entry point in a child process and look at the modules it loaded.

const MAIN = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts')
const PROBE = join(import.meta.dir, '..', 'fixtures', 'hook', 'module-probe.ts')

interface HookRun { stdout: string, exitCode: number, yaml: number, total: number }

async function runClaudePreToolUse(root: string, command: string): Promise<HookRun> {
  const cwd = join(root, 'work')
  mkdirSync(cwd, { recursive: true })
  const out = join(root, `probe-${Math.random().toString(36).slice(2)}.json`)
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 'sess-yaml-free', cwd })
  const proc = Bun.spawn(['bun', '--preload', PROBE, MAIN, 'hook', 'claude', 'PreToolUse'], { cwd, env: { ...process.env, PROBE_OUT: out }, stdin: new Blob([payload]), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  expect(stderr).toBe('')
  const probe = JSON.parse(readFileSync(out, 'utf8')) as { yaml: number, total: number }
  return { stdout, exitCode, ...probe }
}

describe('the PreToolUse hook and the yaml package', () => {
  test('with a fresh runtime snapshot the hook never loads yaml; without one it parses the files and decides the same', () => withSandbox(async ({ root }) => {
    const destructive = 'rm -rf ~'
    const harmless = 'ls'

    // No snapshot yet: the configuration comes from the YAML files. The control: the probe does see yaml loading.
    const parsedDeny = await runClaudePreToolUse(root, destructive)
    const parsedAllow = await runClaudePreToolUse(root, harmless)
    expect(parsedDeny.yaml).toBeGreaterThan(0)
    expect(parsedDeny.total).toBeGreaterThan(50)
    expect(parsedDeny.stdout).toContain('"permissionDecision":"deny"')
    expect(parsedAllow.stdout).not.toContain('"permissionDecision":"deny"')

    await writeRuntimeConfig(loadConfigSync())
    expect(readFileSync(paths.runtimeConfigFile(), 'utf8')).toContain('"stamp"')

    const snapDeny = await runClaudePreToolUse(root, destructive)
    const snapAllow = await runClaudePreToolUse(root, harmless)
    expect(snapDeny.yaml).toBe(0)
    expect(snapAllow.yaml).toBe(0)
    expect(snapDeny).toMatchObject({ stdout: parsedDeny.stdout, exitCode: parsedDeny.exitCode })
    expect(snapAllow).toMatchObject({ stdout: parsedAllow.stdout, exitCode: parsedAllow.exitCode })
  }))
})
