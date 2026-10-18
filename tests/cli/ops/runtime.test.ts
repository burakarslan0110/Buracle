import { describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run as doctorRun } from '../../../src/cli/commands/doctor'
import { run as installRun } from '../../../src/cli/commands/install'
import { run as procRun } from '../../../src/engine/proc'
import { BIN_BURACLE, BIN_BURACLE_TS } from '../../../src/adapters/claude/plugin'
import { runtimeBehindForStatus } from '../../../src/engine/hook-health'
import { RUNTIME_MARKER } from '../../../src/engine/paths'
import { windowsShimContent } from '../../../src/engine/update/install-core'
import { parseShimText, planRuntime, readMarker, runtimeDirOf, runtimeHealth, runtimePackages } from '../../../src/engine/update/runtime'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { fakeCli, fullCheckout, memoryIO, noNetwork, REAL_REPO, withDeps } from './helpers'

function shimOf(buracleHome: string) {
  const info = parseShimText(readFileSync(join(buracleHome, 'bin', 'buracle'), 'utf8'))
  if (info === undefined) throw new Error('no shim')
  return info
}

const PROBE_ENV = { BURACLE_NO_CAPTURE: '1', BURACLE_NO_AUTOSTART: '1', BURACLE_NO_NOTIFY: '1' }

async function preToolUse(shim: string, harness: string, command: string): Promise<{ code: number, decision?: unknown, reason?: string }> {
  const payload = JSON.stringify({ session_id: 'runtime-test', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: '/', permission_mode: 'bypassPermissions' })
  const r = await procRun(['/bin/sh', shim, 'hook', harness, 'PreToolUse'], { stdin: payload, timeoutMs: 30_000, env: PROBE_ENV })
  if (r.stdout.trim() === '') return { code: r.code }
  const o = JSON.parse(r.stdout) as { hookSpecificOutput?: { permissionDecision?: unknown, permissionDecisionReason?: string } }
  const out: { code: number, decision?: unknown, reason?: string } = { code: r.code, decision: o.hookSpecificOutput?.permissionDecision }
  if (o.hookSpecificOutput?.permissionDecisionReason !== undefined) out.reason = o.hookSpecificOutput.permissionDecisionReason
  return out
}

function runtimeDirs(buracleHome: string): string[] {
  try { return readdirSync(join(buracleHome, 'runtime')).sort() } catch { return [] }
}

describe('the frozen runtime', () => {
  test('planRuntime refuses what cannot be frozen: a runtime itself, a tree without src/cli/main.ts, node_modules that does not match package.json', () => withSandbox(async ({ root }) => {
    const repo = fullCheckout(root)
    const ok = planRuntime(repo)
    expect('error' in ok).toBe(false)
    writeFileSync(join(repo, RUNTIME_MARKER), '{}\n')
    expect(planRuntime(repo)).toMatchObject({ error: expect.stringContaining('is a frozen runtime') })
    const bare = join(root, 'bare')
    mkdirSync(join(bare, 'canonical'), { recursive: true })
    writeFileSync(join(bare, 'canonical', 'buracle.yaml'), 'harnesses: {}\n')
    writeFileSync(join(bare, 'package.json'), '{"name":"x","dependencies":{"yaml":"2.9.1"}}\n')
    expect(planRuntime(bare)).toMatchObject({ error: expect.stringContaining('has no src/cli/main.ts') })
    expect(runtimePackages(bare)).toMatchObject({ error: expect.stringContaining('yaml is not installed') })
    writeFileSync(join(bare, 'package.json'), '{"name":"x","dependencies":{"yaml":"9.9.9"}}\n')
    symlinkSync(join(REAL_REPO, 'node_modules'), join(bare, 'node_modules'))
    expect(runtimePackages(bare)).toMatchObject({ error: expect.stringContaining('yaml is 2.9.1, package.json pins 9.9.9') })
    writeFileSync(join(bare, 'package.json'), '{"name":"x","dependencies":{"yaml":"2.9.1"}}\n')
    writeFileSync(join(bare, 'bun.lock'), '{\n  "packages": {\n    "yaml": ["yaml@2.8.0", "", {}, "sha512-x"],\n  }\n}\n')
    expect(runtimePackages(bare)).toMatchObject({ error: expect.stringContaining('yaml is 2.9.1, bun.lock has 2.8.0') })
  }), 60_000)

  test('install freezes a checked runtime; a broken checkout never reaches the hooks; a copy that fails its probe never goes live; one previous runtime is kept', () => withSandbox(async ({ root, buracleHome }) => {
    const repo = fullCheckout(root)
    await withEnv({ BURACLE_RUNTIME: 'frozen' }, () => withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli, fetch: noNetwork }, async () => {
      const io = memoryIO()
      expect(await installRun(['--yes'], io)).toBe(0)
      const first = shimOf(buracleHome)
      expect(first.mode).toBe('frozen')
      const dir = runtimeDirOf(first) as string
      expect(dir.startsWith(join(buracleHome, 'runtime') + '/')).toBe(true)
      expect(readMarker(dir)).toMatchObject({ checkout: repo, verifiedAt: expect.any(String) })
      expect(io.out()).toContain('Hooks and the CLI now run the runtime')
      const shim = join(buracleHome, 'bin', 'buracle')
      expect(await preToolUse(shim, 'claude', 'rm -rf ~')).toMatchObject({ code: 0, decision: 'deny' })
      expect((await preToolUse(shim, 'claude', 'rm -rf ~')).reason).not.toContain('Buracle blocked this tool call')
      expect(runtimeHealth(repo).drift).toBe('current')

      const canonicalTs = join(repo, 'src', 'engine', 'canonical.ts')
      const good = readFileSync(canonicalTs, 'utf8')
      writeFileSync(canonicalTs, '<<<<<<< HEAD\nexport const x = 1\n=======\n>>>>>>> other\n')
      for (const h of ['claude', 'codex']) {
        const deny = await preToolUse(shim, h, 'rm -rf ~')
        expect(deny.decision).toBe('deny')
        expect(deny.reason).not.toContain('Buracle blocked this tool call')
        expect((await preToolUse(shim, h, 'ls')).decision).not.toBe('deny')
      }
      const drift = runtimeHealth(repo)
      expect(drift.drift).toBe('modified')
      expect(drift.detail).toContain('buracle install')
      const t0 = Date.now()
      expect(await runtimeBehindForStatus(t0)).toBe(true)

      const broken = memoryIO()
      expect(await installRun(['--yes'], broken)).toBe(1)
      expect(broken.err()).toContain('the new runtime failed its check, so the shim still runs the old one')
      expect(shimOf(buracleHome)).toEqual(first)
      expect(runtimeDirs(buracleHome)).toEqual([dir.slice(dir.lastIndexOf('/') + 1)])

      expect(await runtimeBehindForStatus(t0 + 1000)).toBe(true)

      writeFileSync(canonicalTs, good)
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      expect(shimOf(buracleHome)).toEqual(first)
      expect(await runtimeBehindForStatus(t0 + 2000)).toBe(false)
      const ids: string[] = [dir.slice(dir.lastIndexOf('/') + 1)]
      for (const n of [1, 2]) {
        appendFileSync(join(repo, 'src', 'cli', 'commands', 'rules.ts'), `\n// change ${n}\n`)
        expect(await installRun(['--yes'], memoryIO())).toBe(0)
        const live = runtimeDirOf(shimOf(buracleHome)) as string
        ids.push(live.slice(live.lastIndexOf('/') + 1))
      }
      expect(new Set(ids).size).toBe(3)
      expect(runtimeDirs(buracleHome)).toEqual([ids[1], ids[2]].sort() as string[])
    }))
  }), 180_000)

  test('from a frozen runtime, checkout commands re-run in the checkout; without a checkout they refuse (writers) or run in the runtime', () => withSandbox(async ({ root, buracleHome }) => {
    const repo = fullCheckout(root)
    await withEnv({ BURACLE_RUNTIME: 'frozen' }, () => withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli, fetch: noNetwork }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
    }))
    const shim = join(buracleHome, 'bin', 'buracle')
    const rulesTs = join(repo, 'src', 'cli', 'commands', 'rules.ts')
    writeFileSync(rulesTs, readFileSync(rulesTs, 'utf8').replace('export const usage = `', 'export const usage = `CHECKOUT-ONLY '))
    const viaRuntime = await procRun(['/bin/sh', shim, 'rules', '--help'], { timeoutMs: 30_000 })
    expect(viaRuntime.code).toBe(0)
    expect(viaRuntime.stdout).toContain('CHECKOUT-ONLY')
    const cfg = await procRun(['/bin/sh', shim, 'config', 'path', '--json'], { timeoutMs: 30_000 })
    expect(cfg.code).toBe(0)
    expect(JSON.parse(cfg.stdout).canonical).toContain(join(buracleHome, 'runtime'))
    renameSync(repo, `${repo}-moved`)
    try {
      const build = await procRun(['/bin/sh', shim, 'build', '--check'], { timeoutMs: 30_000 })
      expect(build.code).toBe(1)
      expect(build.stderr).toContain('no Buracle checkout was found')
      const rules = await procRun(['/bin/sh', shim, 'rules', '--help'], { timeoutMs: 30_000 })
      expect(rules.code).toBe(0)
      expect(rules.stderr).toContain('running it from the live runtime')
      expect(rules.stdout).not.toContain('CHECKOUT-ONLY')
    } finally {
      renameSync(`${repo}-moved`, repo)
    }
  }), 120_000)

  test('a guard hook fails closed when the live runtime is gone; other commands fall back to the checkout', () => withSandbox(async ({ root, buracleHome }) => {
    const repo = fullCheckout(root)
    await withEnv({ BURACLE_RUNTIME: 'frozen' }, () => withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli, fetch: noNetwork }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
    }))
    const shim = join(buracleHome, 'bin', 'buracle')
    const dir = runtimeDirOf(shimOf(buracleHome)) as string
    writeFileSync(join(dir, 'src', 'cli', 'router.ts'), '<<<<<<< HEAD\n')
    const deny = await preToolUse(shim, 'claude', 'ls')
    expect(deny).toMatchObject({ code: 0, decision: 'deny' })
    expect(deny.reason).toContain('Buracle blocked this tool call')
    expect(deny.reason).toContain('buracle doctor')
    const stop = await procRun(['/bin/sh', shim, 'hook', 'codex', 'Stop'], { stdin: '{}', timeoutMs: 30_000, env: PROBE_ENV })
    expect(stop.stdout).toBe('')
    const doc = await procRun(['/bin/sh', shim, 'doctor', 'runtime', '--json'], { timeoutMs: 60_000, env: PROBE_ENV })
    expect(doc.stderr).toContain('running the checkout instead')
    expect((JSON.parse(doc.stdout) as { checks: Array<{ check: string, level: string, detail: string }> }).checks.find(c => c.check === 'runtime')).toMatchObject({ level: 'error', detail: expect.stringContaining('changed after it was checked') })
    await withEnv({ BURACLE_RUNTIME: 'frozen' }, () => withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli, fetch: noNetwork }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
    }))
    expect(runtimeDirOf(shimOf(buracleHome))).toBe(dir)
    const repaired = await preToolUse(shim, 'claude', 'rm -rf ~')
    expect(repaired.decision).toBe('deny')
    expect(repaired.reason).not.toContain('Buracle blocked this tool call')
    writeFileSync(join(dir, 'src', 'cli', 'router.ts'), '<<<<<<< HEAD\n')
    renameSync(dir, `${dir}-gone`)
    expect((await preToolUse(shim, 'codex', 'ls')).decision).toBe('deny')
    const v = await procRun(['/bin/sh', shim, '--version'], { timeoutMs: 30_000 })
    expect(v.code).toBe(0)
    expect(v.stderr).toContain('running the checkout instead')
    const log = readFileSync(join(buracleHome, 'logs', 'buracle.log'), 'utf8')
    expect(log).toContain('"msg":"hook runtime failed"')
    expect(log).toContain('"result":"fail-closed"')
    expect(existsSync(`${dir}-gone`)).toBe(true)
  }), 120_000)

  test('doctor names the shim mode and says when the runtime is behind the checkout', () => withSandbox(async ({ root }) => {
    const repo = fullCheckout(root)
    await withEnv({ BURACLE_RUNTIME: 'frozen' }, () => withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli, fetch: noNetwork }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      const checks = async () => {
        const io = memoryIO({ json: true })
        await doctorRun(['runtime', '--json'], io)
        const cfg = memoryIO({ json: true })
        await doctorRun(['config', '--json'], cfg)
        return [...(JSON.parse(io.out()) as { checks: Array<{ check: string, level: string, detail: string }> }).checks, ...(JSON.parse(cfg.out()) as { checks: Array<{ check: string, level: string, detail: string }> }).checks]
      }
      const before = await checks()
      expect(before.find(c => c.check === 'shim')).toMatchObject({ level: 'ok', detail: expect.stringContaining('mode: frozen') })
      expect(before.find(c => c.check === 'runtime')).toMatchObject({ level: 'ok', detail: expect.stringContaining('matches the checkout') })
      appendFileSync(join(repo, 'src', 'cli', 'commands', 'rules.ts'), '\n// an edit\n')
      const after = await checks()
      expect(after.find(c => c.check === 'runtime')).toMatchObject({ level: 'warn', detail: expect.stringContaining('`buracle install`') })
    }))
  }), 120_000)

  test('G13: the Claude plugin launcher denies a guard hook when neither the shim nor bun exists; other hooks do nothing', () => withSandbox(async ({ root, buracleHome }) => {
    const bin = join(root, 'plugin', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'buracle'), BIN_BURACLE)
    writeFileSync(join(bin, 'buracle.ts'), BIN_BURACLE_TS)
    const noBun = { PATH: '/usr/bin:/bin', BURACLE_HOME: join(buracleHome, 'none') }
    const pre = await procRun(['/bin/sh', join(bin, 'buracle'), 'hook', 'claude', 'PreToolUse'], { stdin: '{}', timeoutMs: 30_000, env: noBun })
    expect(pre.code).toBe(0)
    const d = JSON.parse(pre.stdout) as { hookSpecificOutput: { permissionDecision: string, permissionDecisionReason: string } }
    expect(d.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(d.hookSpecificOutput.permissionDecisionReason).toContain('claude plugin uninstall buracle@buracle')
    const stop = await procRun(['/bin/sh', join(bin, 'buracle'), 'hook', 'claude', 'Stop'], { stdin: '{}', timeoutMs: 30_000, env: noBun })
    expect(stop).toMatchObject({ code: 0, stdout: '' })
    const ts = await procRun([process.execPath, join(bin, 'buracle.ts'), 'hook', 'codex', 'PreToolUse'], { stdin: '{}', timeoutMs: 30_000, env: { BURACLE_HOME: join(buracleHome, 'none') } })
    expect((JSON.parse(ts.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision).toBe('deny')
    const tsStop = await procRun([process.execPath, join(bin, 'buracle.ts'), 'hook', 'codex', 'Stop'], { stdin: '{}', timeoutMs: 30_000, env: { BURACLE_HOME: join(buracleHome, 'none') } })
    expect(tsStop).toMatchObject({ code: 0, stdout: '' })
  }), 60_000)

  test('the Windows shim runs the runtime, falls back to the checkout for commands and denies a guard hook it cannot run', () => {
    const cmd = windowsShimContent({ bun: 'C:\\bun\\bun.exe', repoRoot: 'C:\\src\\buracle', runtime: 'C:\\h\\.buracle\\runtime\\0123456789abcdef' }).split('\r\n')
    expect(cmd).toContain('rem buracle-shim: frozen')
    expect(cmd.some(l => l.startsWith('"C:\\bun\\bun.exe" "C:\\h\\.buracle\\runtime\\0123456789abcdef'))).toBe(true)
    expect(cmd.some(l => l.startsWith('if exist "C:\\src\\buracle') && l.includes('%*'))).toBe(true)
    const deny = cmd[cmd.indexOf(':deny') + 1] ?? ''
    expect(deny.startsWith('echo {"hookSpecificOutput":')).toBe(true)
    expect(deny).not.toMatch(/[<>|&^%]/)
  })
})
