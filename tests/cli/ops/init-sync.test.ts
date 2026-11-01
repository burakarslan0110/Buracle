import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run as installRun } from '../../../src/cli/commands/install'
import { main } from '../../../src/cli/router'
import { yamlParse } from '../../../src/engine/merge'
import * as paths from '../../../src/engine/paths'
import { run as procRun } from '../../../src/engine/proc'
import { windowsLauncher } from '../../../src/engine/toolchain/links'
import { pathLink } from '../../../src/engine/update/install-core'
import { IS_WINDOWS, narrowPath } from '../../helpers/fake-exe'
import { snapshotTree } from '../../helpers/fs-snapshot'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { fakeAdapter, fakeCli, makeRepo, memoryIO, noNetwork, REAL_REPO, withDeps } from './helpers'

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

// `buracle install` took over `buracle init` (the first setup) and `buracle sync` (build, then install).
describe('buracle install sets Buracle up on a clean home', () => {
  test('writes config.yaml, the shim and the PATH link, lists the harnesses and says what is left; idempotent', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = makeRepo(root)
    const cli = fakeCli()
    const adapters = [fakeAdapter('claude', { installed: false }), fakeAdapter('codex', { installed: false })]
    await withDeps({ repoRoot: () => repo, adapters: async () => adapters, runCli: cli.runCli, fetch: noNetwork }, async () => {
      await withEnv({ PATH: narrowPath(), SHELL: '/bin/zsh', ZDOTDIR: undefined }, async () => {
        const io = memoryIO()
        expect(await installRun(['--yes'], io)).toBe(0)
        expect(yamlParse(read(join(buracleHome, 'config.yaml')))).toEqual({ repo })
        // The PATH link: a symlink to the shim, or on Windows a launcher .cmd that runs it.
        if (IS_WINDOWS) expect(read(`${pathLink()}.cmd`)).toBe(windowsLauncher(paths.shimPath()))
        else expect(readlinkSync(join(home, '.local/bin/buracle'))).toBe(join(buracleHome, 'bin/buracle'))
        expect(io.out()).toContain('claude  -  skipped: not installed')
        // POSIX: the install puts ~/.local/bin on PATH in the shell's startup file itself; Windows leaves it to install.ps1.
        if (IS_WINDOWS) expect(io.out()).toContain('Add ~/.local/bin to PATH')
        else {
          expect(io.out()).toContain('Added ~/.local/bin to PATH in ~/.zshrc; open a new terminal to use buracle.')
          expect(io.out()).not.toContain('Add ~/.local/bin to PATH')
          expect(read(join(home, '.zshrc'))).toBe('# >>> buracle >>>\nexport PATH="$HOME/.local/bin:$PATH"\n# <<< buracle <<<\n')
        }
        expect(io.out()).toContain('No enabled harness was found; install one of Claude Code, Codex, OpenCode or Oh My Pi, then run `buracle install`.')

        const before = snapshotTree(home, rel => rel.startsWith('.buracle/journal') || rel.startsWith('.buracle/backups') || rel.startsWith('.buracle/logs') || rel.startsWith('.buracle/state'))
        const again = memoryIO()
        expect(await installRun(['--yes'], again)).toBe(0)
        expect(again.out()).toContain('Everything is already up to date.')
        expect(again.out()).not.toContain('Added ~/.local/bin')
        expect(snapshotTree(home, rel => rel.startsWith('.buracle/journal') || rel.startsWith('.buracle/backups') || rel.startsWith('.buracle/logs') || rel.startsWith('.buracle/state'))).toEqual(before)
      })
      await withEnv({ PATH: narrowPath(join(home, '.local', 'bin')) }, async () => {
        const onPath = memoryIO()
        expect(await installRun(['--yes'], onPath)).toBe(0)
        expect(onPath.out()).not.toContain('Add ~/.local/bin to PATH')
      })
    })
  }))
})

describe('buracle install builds the generated files first', () => {
  test('builds, then installs; a failed build installs nothing; --dry-run only checks and writes nothing', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    let broken = false
    const codex = fakeAdapter('codex', {
      build: () => { if (broken) throw new Error('generator failed'); return [{ path: 'harness/agents-skills/plan-build/SKILL.md', content: '# spec\n' }] },
      plan: () => ({ id: 'codex', harness: 'codex', ops: [{ kind: 'file', path: join(home, '.codex/AGENTS.md'), content: 'rules\n', owner: 'codex' }] }),
    })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli, fetch: noNetwork }, async () => {
      const homeBefore = snapshotTree(home)
      const dry = memoryIO()
      expect(await installRun(['--dry-run'], dry)).toBe(0)
      expect(dry.out()).toContain('buracle install --dry-run: nothing was written')
      expect(existsSync(join(repo, 'harness'))).toBe(false)
      expect(snapshotTree(home)).toEqual(homeBefore)

      const io = memoryIO()
      expect(await installRun(['--yes'], io)).toBe(0)
      expect(read(join(repo, 'harness/agents-skills/plan-build/SKILL.md'))).toBe('# spec\n')
      expect(read(join(home, '.codex/AGENTS.md'))).toBe('rules\n')
      expect(readlinkSync(join(home, '.agents/skills/plan-build'))).toBe(join(repo, 'harness/agents-skills/plan-build'))

      broken = true
      writeFileSync(join(home, '.codex/AGENTS.md'), 'changed by hand\n')
      const failed = memoryIO({ json: true })
      expect(await installRun(['--yes', '--json'], failed)).toBe(1)
      expect(JSON.parse(failed.out())).toMatchObject({ ok: false, code: 1, build: { errors: [{ source: 'codex', error: 'generator failed' }] } })
      expect(read(join(home, '.codex/AGENTS.md'))).toBe('changed by hand\n')
      const plain = memoryIO()
      expect(await installRun(['--yes'], plain)).toBe(1)
      expect(plain.err()).toContain('buracle install: the build failed (codex: generator failed); nothing was installed.')
    })
  }))

  test('harness names are arguments; unknown names, --harness and --no-toolchain are refused with what replaces them', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const codex = fakeAdapter('codex', { plan: () => ({ id: 'codex', harness: 'codex', ops: [{ kind: 'file', path: join(home, '.codex/AGENTS.md'), content: 'rules\n', owner: 'codex' }] }) })
    const claude = fakeAdapter('claude', { plan: () => ({ id: 'claude', harness: 'claude', ops: [{ kind: 'file', path: join(home, '.claude/marker'), content: 'x\n', owner: 'claude' }] }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex, claude], runCli: fakeCli().runCli, fetch: noNetwork }, async () => {
      expect(await installRun(['codex', '--yes'], memoryIO())).toBe(0)
      expect(read(join(home, '.codex/AGENTS.md'))).toBe('rules\n')
      expect(existsSync(join(home, '.claude/marker'))).toBe(false)

      const unknown = memoryIO()
      expect(await installRun(['nope'], unknown)).toBe(1)
      expect(unknown.err()).toContain('unknown harness nope (expected claude, codex, opencode, omp)')
      const old = memoryIO()
      expect(await installRun(['--harness', 'codex'], old)).toBe(1)
      expect(old.err()).toBe('buracle install: --harness was removed; name the harnesses instead: `buracle install codex`\n')
      const noTc = memoryIO()
      expect(await installRun(['--no-toolchain'], noTc)).toBe(1)
      expect(noTc.err()).toBe('buracle install: --no-toolchain was removed; `buracle config set toolchain.autoInstall false` skips the toolchain step\n')
    })
  }))

  test('`buracle sync --yes` (what an older `buracle update` runs after a self update) still installs, and says it was renamed', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const codex = fakeAdapter('codex', { plan: () => ({ id: 'codex', harness: 'codex', ops: [{ kind: 'file', path: join(home, '.codex/AGENTS.md'), content: 'rules\n', owner: 'codex' }] }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli, fetch: noNetwork }, async () => {
      const io = memoryIO()
      expect(await main(['sync', '--yes'], io)).toBe(0)
      expect(io.err()).toContain('buracle sync was renamed; use buracle install')
      expect(read(join(home, '.codex/AGENTS.md'))).toBe('rules\n')
    })
  }))
})

describe('the CLI as a process', () => {
  test('build --check, config get and doctor config terminate and print JSON', () => withSandbox(async ({ home, buracleHome }) => {
    mkdirSync(home, { recursive: true })
    const env = { HOME: home, BURACLE_HOME: buracleHome }
    const cfg = await procRun(['bun', 'src/cli/main.ts', 'config', 'get', 'routing.strictness'], { cwd: REAL_REPO, env, timeoutMs: 30_000 })
    expect(cfg).toMatchObject({ code: 0, stdout: 'enforce\n', timedOut: false })
    const build = await procRun(['bun', 'src/cli/main.ts', 'build', '--check', '--json'], { cwd: REAL_REPO, env, timeoutMs: 60_000 })
    expect(build.timedOut).toBe(false)
    expect([0, 1]).toContain(build.code)
    const report = JSON.parse(build.stdout) as { check: boolean, drift: unknown[] }
    expect(report.check).toBe(true)
    expect(Array.isArray(report.drift)).toBe(true)
    const doctor = await procRun(['bun', 'src/cli/main.ts', 'doctor', 'config', '--json'], { cwd: REAL_REPO, env, timeoutMs: 30_000 })
    expect(doctor.timedOut).toBe(false)
    expect((JSON.parse(doctor.stdout) as { checks: Array<{ section: string }> }).checks.every(c => c.section === 'config')).toBe(true)
    expect(existsSync(join(buracleHome, 'state', 'runtime-config.json'))).toBe(false)
  }), 90_000)
})
