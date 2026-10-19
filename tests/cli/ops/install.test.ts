import { describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { renderInstallStyled, run as installRun, runInstallFlow } from '../../../src/cli/commands/install'
import { makeStyle } from '../../../src/cli/ui/style'
import { CONFIG_RENAMES, type ConfigRename } from '../../../src/core/config'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import { atomicWriteSync } from '../../../src/engine/fsx'
import { yamlParse } from '../../../src/engine/merge'
import { applyPlans, listLedgerKey, readLedger, txnTestHooks, type Plan } from '../../../src/engine/txn'
import { run as procRun } from '../../../src/engine/proc'
import { renderPathRules } from '../../../src/engine/update/compose'
import { bunPath, pathLink, readInstallRecord, shellQuote, shimContent, shimPlanOps, windowsShimContent, writeInstallRecord } from '../../../src/engine/update/install-core'
import { parseShimText } from '../../../src/engine/update/runtime'
import { windowsLauncher } from '../../../src/engine/toolchain/links'
import * as paths from '../../../src/engine/paths'
import { fakeExe, IS_WINDOWS, narrowPath, pathOf } from '../../helpers/fake-exe'
import { snapshotTree } from '../../helpers/fs-snapshot'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { fakeAdapter, fakeCli, fullCheckout, makeRepo, memoryIO, noNetwork, REAL_REPO, withDeps } from './helpers'

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

function codexPlan(home: string, files: Record<string, string>): Plan {
  return { id: 'codex', harness: 'codex', ops: Object.entries(files).map(([rel, content]) => ({ kind: 'file' as const, path: join(home, rel), content, owner: 'codex' })) }
}

describe('install output for a terminal', () => {
  test('harnesses, the outcome, kept values and next steps, in English', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const claude = fakeAdapter('claude', { plan: () => ({ id: 'claude', harness: 'claude', ops: [] }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [claude], runCli: fakeCli().runCli }, async () => {
      const r = await runInstallFlow({ dryRun: false, yes: true, json: false }, memoryIO())
      r.conflicts.push({ detail: '~/.claude/settings.json permissions.defaultMode: already set by the user; keeping the user\'s value' } as never)
      r.steps.push('Claude Code: run /reload-plugins in open sessions.')
      const text = renderInstallStyled(r, makeStyle(0), 100)
      expect(text).toContain('Harnesses')
      expect(text).toContain('Claude Code')
      expect(text).toMatch(/Applied \d+ changes?|Everything is already up to date/)
      expect(text).toContain('Kept your value: ~/.claude/settings.json permissions.defaultMode')
      expect(text).toContain('Next steps')
      expect(text).not.toContain('\u001b[')
    })
  }))
})

// The lines a live step list leaves on the screen: the spinner frames are drawn and erased, the finished steps stay.
function finishedSteps(err: string): string[] {
  const plain = err.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
  return plain.split('\n').map(l => l.trim()).filter(l => /^[✔▲✖ℹ-] /.test(l) || l.startsWith('── '))
}

describe('install progress on a terminal', () => {
  test('each step shows as it finishes, in order, with what it did; the second run says what is already up to date', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const codex = fakeAdapter('codex', { plan: () => codexPlan(home, { '.codex/hooks.json': '{}\n' }) })
    const asked: string[] = []
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli, confirm: async q => { asked.push(q); return false } }, async () => {
      const first = memoryIO({ tty: true, liveErr: true })
      expect(await installRun([], first)).toBe(0)
      expect(asked).toEqual([])
      const steps = finishedSteps(first.err())
      expect(steps[0]).toMatch(/^✔ (Generated files are up to date|Rebuilt the generated files: \d+ written, \d+ removed)$/)
      const rest = steps.slice(1)
      expect(rest[0]).toStartWith('── Install ')
      expect(rest.slice(1, 3)).toEqual(['✔ Harnesses: Codex', expect.stringMatching(/^✔ \d+ changes to write$/)])
      expect(rest[3]).toMatch(/^✔ Shim, PATH link and shared skills: \d+ changes?$/)
      expect(rest[4]).toBe('✔ Codex: 1 change')
      expect(rest[5]).toMatch(/^✔ Memory (ready|checked \(see the next steps\))$/)
      expect(rest).toHaveLength(6)
      expect(first.err().replace(/\u001b\[[0-9;]*m/g, '')).toStartWith('\n  ◉ buracle install\n')
      expect(read(join(home, '.codex/hooks.json'))).toBe('{}\n')
      expect(first.out()).not.toContain('Rebuilt the generated files (')

      const again = memoryIO({ tty: true, liveErr: true })
      expect(await installRun([], again)).toBe(0)
      expect(finishedSteps(again.err())).toEqual(expect.arrayContaining(['✔ Nothing to change', '✔ Shim, PATH link and shared skills: up to date', '✔ Codex: up to date']))
    })
  }))

  test('a rare-case question waits until no step runs, and the plan is shown again after a yes', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const codex = fakeAdapter('codex', {
      plan: (ctx) => {
        if ((ctx as { force?: boolean }).force !== true) throw Object.assign(new Error('Codex is running (pid 42).'), { code: 'HARNESS_BUSY', exitCode: 2 })
        return codexPlan(home, { '.codex/hooks.json': '{}\n' })
      },
    })
    const io = memoryIO({ tty: true, liveErr: true })
    const atQuestion: string[] = []
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli, confirm: async () => { atQuestion.push(io.err()); return true } }, async () => {
      expect(await installRun([], io)).toBe(0)
    })
    expect(atQuestion).toHaveLength(1)
    const before = finishedSteps(atQuestion[0] ?? '')
    expect(before.slice(-2)).toEqual(['▲ Harnesses: none to install into', '▲ Codex is running, so it is left out'])
    // Every spinner line drawn so far was erased again, so the question starts on a clean line.
    const drawn = (atQuestion[0] ?? '').split('\u001b[0J').at(-1) ?? ''
    expect(drawn.replace(/\u001b\[[0-9;]*m/g, '')).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
    expect(finishedSteps(io.err())).toContain('✔ Harnesses: Codex')
    expect(read(join(home, '.codex/hooks.json'))).toBe('{}\n')
  }))

  test('without a terminal on stderr nothing of the live steps is written', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, async () => {
      const io = memoryIO({ tty: true })
      expect(await installRun([], io)).toBe(0)
      expect(io.err()).toBe('')
    })
  }))
})

describe('install: values the user keeps', () => {
  test('a soft key the user changed is listed as kept (summary, styled view, JSON), never as a conflict', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const settings = join(home, '.claude', 'settings.json')
    const plan = (): Plan => ({ id: 'claude', harness: 'claude', ops: [{ kind: 'json-merge', path: settings, set: { effortLevel: 'xhigh' }, owner: 'claude', soft: ['effortLevel'] }] })
    const claude = fakeAdapter('claude', { plan })
    await withDeps({ repoRoot: () => repo, adapters: async () => [claude], runCli: fakeCli().runCli }, async () => {
      expect((await runInstallFlow({ dryRun: false, yes: true, json: true }, memoryIO({ json: true }))).kept).toEqual([])
      writeFileSync(settings, `${JSON.stringify({ effortLevel: 'high' }, null, 2)}\n`)
      const io = memoryIO({ json: true })
      expect(await installRun(['--yes', '--json'], io)).toBe(0)
      const r = JSON.parse(io.out()) as Awaited<ReturnType<typeof runInstallFlow>>
      expect(r.kept).toEqual([{ path: settings, key: 'effortLevel' }])
      expect(r.conflicts).toEqual([])
      expect(JSON.parse(read(settings))).toEqual({ effortLevel: 'high' })
      const plain = memoryIO()
      expect(await installRun(['--yes'], plain)).toBe(0)
      expect(plain.out()).toContain('Kept your values (you changed them; Buracle leaves them as they are):\n  - ~/.claude/settings.json effortLevel\n')
      expect(renderInstallStyled(r, makeStyle(0), 100)).toContain('Kept your value of effortLevel in ~/.claude/settings.json')
    })
  }))
})

describe('buracle install', () => {
  test('core plan: shim (quoted paths, runs the checkout with BURACLE_RUNTIME=checkout), PATH link, config.yaml, runtime snapshot; idempotent', () => withSandbox(async ({ root, home, buracleHome }) => {
    const cli = fakeCli()
    const repo = fullCheckout(root)
    await withDeps({ repoRoot: () => repo, adapters: async () => [fakeAdapter('claude', { installed: false })], runCli: cli.runCli, fetch: noNetwork }, async () => {
      const io = memoryIO()
      expect(await installRun(['--yes'], io)).toBe(0)
      // The sh shim is written on every platform (Git Bash runs it on Windows), with '/' in its paths there.
      const shim = join(buracleHome, 'bin', 'buracle')
      const fwd = (p: string) => (IS_WINDOWS ? p.replace(/\\/g, '/') : p)
      const lines = read(shim).split('\n')
      expect(lines).toContain('# buracle-shim: checkout')
      expect(lines.find(l => l.startsWith('b='))).toMatch(/^b='[^']*bun(\.exe)?'$/)
      expect(lines).toContain(`m=${shellQuote(fwd(join(repo, 'src/cli/main.ts')))}`)
      expect(parseShimText(read(shim))).toMatchObject({ mode: 'checkout', main: fwd(join(repo, 'src/cli/main.ts')), checkout: repo })
      if (IS_WINDOWS) {
        expect(read(paths.shimPath())).toBe(windowsShimContent({ bun: bunPath(), repoRoot: repo }))
        expect(read(`${pathLink()}.cmd`)).toBe(windowsLauncher(paths.shimPath()))
      } else {
        expect(statSync(shim).mode & 0o777).toBe(0o755)
        expect(readlinkSync(join(home, '.local/bin/buracle'))).toBe(shim)
      }
      expect(read(join(buracleHome, 'config.yaml'))).toBe(`repo: ${repo}\n`)
      expect(existsSync(join(buracleHome, 'state/runtime-config.json'))).toBe(true)
      expect(Object.keys(readInstallRecord().record.plans)).toEqual(['core'])
      expect(cli.calls).toEqual([])
      const rules = readdirSync(join(repo, 'canonical/rules/paths')).filter(f => f.endsWith('.md')).sort()
      expect(rules.length).toBeGreaterThan(0)
      expect(io.out()).toContain(`Applied ${shimPlanOps({ bun: bunPath(), repoRoot: repo }).length + 1 + rules.length} change(s)`)
      expect(readdirSync(join(buracleHome, 'rules/paths')).sort()).toEqual(rules)
      expect(io.out()).toContain('claude  -  skipped: not installed')

      const ran = await procRun([paths.shimPath(), '--version'], { timeoutMs: 30_000 })
      expect(ran.code).toBe(0)
      expect(ran.stdout).toMatch(/^buracle \d+\.\d+\.\d+/)

      const again = memoryIO()
      expect(await installRun(['--yes'], again)).toBe(0)
      expect(again.out()).toContain('Everything is already up to date.')
    })
  }))

  test('an old vault with notes is imported by mem import-vault; a failure says how to retry', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const vault = join(home, 'Documents', 'Buracle')
    mkdirSync(join(vault, 'projects', 'demo', 'decisions'), { recursive: true })
    writeFileSync(join(vault, 'projects', 'demo', 'decisions', 'x.md'), '---\ntitle: X\n---\nx\n')
    let answer: { code: number, stdout: string, stderr: string } = { code: 0, stdout: JSON.stringify({ found: true, imported: [{ id: 'decision-x' }, { id: 'gotcha-y' }], skipped: [] }), stderr: '' }
    const cli = fakeCli(() => answer)
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: cli.runCli, fetch: noNetwork }, async () => {
      const steps = async (): Promise<string[]> => {
        const io = memoryIO({ json: true })
        expect(await installRun(['--yes', '--json'], io)).toBe(0)
        return (JSON.parse(io.out()) as { steps: string[] }).steps.filter(s => s.includes('old vault'))
      }
      expect(await steps()).toEqual(['Imported 2 memories from the old vault ~/Documents/Buracle into ~/.buracle/brain (the vault was only read; it is yours to keep or delete).'])
      expect(cli.calls).toEqual([['mem', 'import-vault', '--vault', vault, '--json']])
      answer = { code: 1, stdout: '', stderr: 'buracle mem import-vault: disk full\n' }
      expect(await steps()).toEqual(["Import the old vault's notes into the memory: run `buracle mem import-vault` (buracle mem import-vault: disk full)."])
      expect(cli.calls).toHaveLength(2)
      expect(readFileSync(join(vault, 'projects', 'demo', 'decisions', 'x.md'), 'utf8')).toBe('---\ntitle: X\n---\nx\n')
    })
  }))

  test('enabled and detected adapters are installed; disabled or missing ones are skipped and reported', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = makeRepo(root, { 'harness/agents-skills/plan-build/SKILL.md': '# spec\n', 'harness/agents-skills/bugfix/SKILL.md': '# fix\n', 'harness/agents-skills/empty/README.md': 'no skill\n' })
    mkdirSync(buracleHome, { recursive: true })
    writeFileSync(join(buracleHome, 'config.yaml'), 'harnesses:\n  omp: { enabled: false }\n')
    const codex = fakeAdapter('codex', { version: '0.161.0', plan: () => codexPlan(home, { '.codex/hooks.json': '{}\n' }) })
    const omp = fakeAdapter('omp', { plan: () => { throw new Error('must not be called') } })
    const opencode = fakeAdapter('opencode', { installed: false })
    const cli = fakeCli()
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex, opencode, omp], runCli: cli.runCli, fetch: noNetwork }, async () => {
      const io = memoryIO({ json: true })
      expect(await installRun(['--yes', '--json'], io)).toBe(0)
      const r = JSON.parse(io.out()) as { harnesses: Array<{ harness: string, included: boolean, reason?: string }>, steps: string[] }
      expect(r.harnesses.map(h => [h.harness, h.included, h.reason ?? ''])).toEqual([['codex', true, ''], ['opencode', false, 'not installed'], ['omp', false, 'disabled in config']])
      expect(read(join(home, '.codex/hooks.json'))).toBe('{}\n')
      expect(readlinkSync(join(home, '.agents/skills/plan-build'))).toBe(join(repo, 'harness/agents-skills/plan-build'))
      expect(readlinkSync(join(home, '.agents/skills/bugfix'))).toBe(join(repo, 'harness/agents-skills/bugfix'))
      expect(existsSync(join(home, '.agents/skills/empty'))).toBe(false)
      expect(r.steps.some(s => s.includes('/hooks'))).toBe(true)
      expect(omp.calls).not.toContain('installPlan')
      expect(yamlParse(read(join(buracleHome, 'config.yaml')))).toEqual({ harnesses: { omp: { enabled: false } }, repo })

      const only = memoryIO()
      expect(await installRun(['--yes', 'opencode'], only)).toBe(2)
      expect(only.out()).toContain('opencode  -  skipped: not installed')
    })
  }))

  test('agents-skills links are not made when only Claude Code is installed', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root, { 'harness/agents-skills/plan-build/SKILL.md': '# spec\n' })
    await withDeps({ repoRoot: () => repo, adapters: async () => [fakeAdapter('claude'), fakeAdapter('codex', { installed: false })], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      expect(existsSync(join(home, '.agents'))).toBe(false)
    })
  }))

  test('conflicts keep the user value (exit 2); identical pre-existing values are adopted', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex/AGENTS.md'), 'my own notes\n')
    writeFileSync(join(home, '.codex/same.txt'), 'same\n')
    const codex = fakeAdapter('codex', { plan: () => codexPlan(home, { '.codex/AGENTS.md': 'buracle\n', '.codex/same.txt': 'same\n' }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      const io = memoryIO()
      expect(await installRun(['--yes'], io)).toBe(2)
      expect(read(join(home, '.codex/AGENTS.md'))).toBe('my own notes\n')
      expect(io.out()).toContain('Conflicts (your version was kept):')
      expect(io.out()).toContain('~/.codex/AGENTS.md exists and is not owned by Buracle')
      expect(io.out()).toContain('Adopted (these already had Buracle\'s value')
      expect(io.out()).toContain('  - ~/.codex/same.txt')
      expect((await readLedger())[join(home, '.codex/same.txt')]?.adopted).toBe(true)
    })
  }))

  test('items an earlier install wrote but the plan no longer produces are removed (unless changed by the user)', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    let files: Record<string, string> = { '.codex/agents/a.toml': 'a\n', '.codex/agents/b.toml': 'b\n', '.codex/agents/c.toml': 'c\n' }
    const codex = fakeAdapter('codex', { plan: () => codexPlan(home, files) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      writeFileSync(join(home, '.codex/agents/c.toml'), 'c edited\n')
      files = { '.codex/agents/a.toml': 'a\n' }
      const io = memoryIO({ json: true })
      expect(await installRun(['--yes', '--json'], io)).toBe(2)
      const r = JSON.parse(io.out()) as { pruned: number, conflicts: Array<{ detail: string }> }
      expect(r.pruned).toBe(2)
      expect(existsSync(join(home, '.codex/agents/b.toml'))).toBe(false)
      expect(read(join(home, '.codex/agents/c.toml'))).toBe('c edited\n')
      expect(r.conflicts[0]?.detail).toContain('modified outside Buracle')
      expect(readInstallRecord().record.plans['codex']?.keys).toEqual([join(home, '.codex/agents/a.toml')])
    })
  }))

  test('a running harness (HARNESS_BUSY) is skipped with a next step; in a terminal the install asks and a yes lets the adapter write', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const codex = fakeAdapter('codex', {
      plan: (ctx) => {
        if ((ctx as { force?: boolean }).force !== true) throw Object.assign(new Error('Codex is running (pid 42). Quit Codex and run the install again.'), { code: 'HARNESS_BUSY', exitCode: 2 })
        return codexPlan(home, { '.codex/hooks.json': '{}\n' })
      },
    })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      const io = memoryIO()
      expect(await installRun(['--yes'], io)).toBe(2)
      expect(io.out()).toContain('codex  1.0.0  skipped: running; not changed')
      expect(io.out()).toContain('Codex is running (pid 42). Quit Codex and run the install again. (`buracle install codex` afterwards, or run `buracle install` in a terminal to write it anyway)')
      expect(io.err()).toBe('')
      expect(existsSync(join(home, '.codex/hooks.json'))).toBe(false)
      const old = memoryIO()
      expect(await installRun(['--yes', '--force'], old)).toBe(1)
      expect(old.err()).toBe('buracle install: --force was removed; run `buracle install` in a terminal; it asks when this case comes up (a running harness)\n')
      const asked: string[] = []
      let answer = false
      await withDeps({ confirm: async q => { asked.push(q); return answer } }, async () => {
        expect(await installRun([], memoryIO({ tty: true }))).toBe(2)
        expect(existsSync(join(home, '.codex/hooks.json'))).toBe(false)
        answer = true
        expect(await installRun([], memoryIO({ tty: true }))).toBe(0)
      })
      expect(asked).toEqual(['codex is running; write its config anyway?', 'codex is running; write its config anyway?'])
      expect(read(join(home, '.codex/hooks.json'))).toBe('{}\n')
    })
  }))

  test('an item that moves to another plan is not pruned by its old plan', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    let codexWrites = true
    const shared = join(home, '.config/shared.txt')
    const codex = fakeAdapter('codex', { plan: () => ({ id: 'codex', harness: 'codex', ops: codexWrites ? [{ kind: 'file', path: shared, content: 's\n', owner: 'codex' }] : [] }) })
    const omp = fakeAdapter('omp', { plan: () => ({ id: 'omp', harness: 'omp', ops: codexWrites ? [] : [{ kind: 'file', path: shared, content: 's\n', owner: 'codex' }] }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex, omp], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      codexWrites = false
      const io = memoryIO({ json: true })
      expect(await installRun(['--yes', '--json'], io)).toBe(0)
      expect(JSON.parse(io.out())).toMatchObject({ pruned: 0, conflicts: [] })
      expect(read(shared)).toBe('s\n')
      expect(readInstallRecord().record.plans['omp']?.keys).toEqual([shared])
    })
  }))

  test('--dry-run prints the diff and writes nothing; without --yes nothing is written either', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const codex = fakeAdapter('codex', { plan: () => codexPlan(home, { '.codex/hooks.json': '{"hooks":1}\n' }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli, fetch: noNetwork }, async () => {
      const before = snapshotTree(home)
      const io = memoryIO()
      expect(await installRun(['--dry-run'], io)).toBe(0)
      expect(io.out()).toContain('== plan codex (1 op(s)) ==')
      expect(io.out()).toContain('+++ ~/.codex/hooks.json')
      expect(io.out()).toContain('+{"hooks":1}')
      // Windows has a launcher file for PATH, not a symlink.
      expect(io.out()).toContain(process.platform === 'win32' ? '+++ ~/.local/bin/buracle.cmd' : '# symlink ~/.local/bin/buracle -> ~/.buracle/bin/buracle')
      expect(snapshotTree(home)).toEqual(before)

      const noYes = memoryIO()
      expect(await installRun([], noYes)).toBe(2)
      expect(noYes.out()).toContain('Re-run with --yes')
      expect(snapshotTree(home)).toEqual(before)
    })
  }))

  test('on a terminal the install applies at once: no question when no rare case comes up', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const asked: string[] = []
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli, confirm: async q => { asked.push(q); return false } }, async () => {
      expect(await installRun([], memoryIO({ tty: true }))).toBe(0)
      expect(asked).toEqual([])
      expect(existsSync(join(home, '.buracle/bin/buracle'))).toBe(true)
    })
  }))

  test('safety: HOME must be absolute and not "/"; a target symlinked outside HOME is a conflict of its own (F19)', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, async () => {
      for (const bad of ['relative/home', '/']) {
        const io = memoryIO()
        const code = await withEnv({ HOME: bad }, () => installRun(['--yes'], io))
        expect(code).toBe(1)
        expect(io.err()).toMatch(/HOME/)
      }
    })
    const outside = join(root, 'elsewhere')
    mkdirSync(outside)
    symlinkSync(outside, join(home, '.codex'))
    const codex = fakeAdapter('codex', { plan: () => codexPlan(home, { '.codex/hooks.json': '{}\n', '.codex-own/AGENTS.md': 'x\n' }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      const io = memoryIO()
      expect(await installRun(['--yes'], io)).toBe(2)
      expect(io.out()).toContain('is a symlink to')
      expect(io.out()).toContain('run `buracle install` in a terminal to write through them')
      expect(existsSync(join(outside, 'hooks.json'))).toBe(false)
      expect(existsSync(join(home, '.buracle/bin/buracle'))).toBe(true)
      expect(read(join(home, '.codex-own/AGENTS.md'))).toBe('x\n')
      const asked: string[] = []
      await withDeps({ confirm: async q => { asked.push(q); return true } }, async () => {
        expect(await installRun([], memoryIO({ tty: true }))).toBe(0)
      })
      expect(asked).toEqual(['Write through 1 link(s) that lead outside your home folder?'])
      expect(read(join(outside, 'hooks.json'))).toBe('{}\n')
    })
  }))

  test('a file rewritten during the transaction triggers exactly one retry', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const target = join(home, '.codex/config.toml')
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(target, 'model = "x"\n')
    const codex = fakeAdapter('codex', { plan: () => ({ id: 'codex', harness: 'codex', ops: [{ kind: 'toml-tables', path: target, tables: { 'mcp_servers.demo': { command: 'demo' } }, owner: 'codex' }] }) })
    let touched = 0
    txnTestHooks.beforeWrite = (p) => {
      if (p === target && touched === 0) { touched++; atomicWriteSync(target, 'model = "y"\n') }
    }
    try {
      await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
        const r = await runInstallFlow({ dryRun: false, yes: true, json: true, silent: true }, memoryIO())
        expect(r.errors).toEqual([])
        expect(r.retried).toBe(true)
        expect(read(target)).toContain('model = "y"')
        expect(read(target)).toContain('[mcp_servers.demo]')
      })
    } finally {
      txnTestHooks.beforeWrite = undefined
    }
  }))

  test('a failing write rolls everything back (fault injection); no network or brew is touched', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const bin = join(root, 'bin')
    const marker = join(root, 'brew-called')
    fakeExe(join(bin, 'brew'), `fs.writeFileSync(${JSON.stringify(marker)}, '')`)
    const codex = fakeAdapter('codex', { plan: () => codexPlan(home, { '.codex/a.txt': 'a\n', '.codex/b.txt': 'b\n' }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli, fetch: noNetwork }, async () => {
      await withEnv({ PATH: narrowPath(bin), BURACLE_TXN_FAIL_AT: '3' }, async () => {
        const before = snapshotTree(home, rel => rel.startsWith('.buracle'))
        const io = memoryIO()
        expect(await installRun(['--yes'], io)).toBe(1)
        expect(io.err()).toContain('rolled back')
        expect(snapshotTree(home, rel => rel.startsWith('.buracle'))).toEqual(before)
      })
      expect(await withEnv({ PATH: narrowPath(bin) }, () => installRun(['--yes'], memoryIO()))).toBe(0)
      expect(existsSync(marker)).toBe(false)
    })
  }))

  test('interrupted transactions are recovered first and reported; --verbose shows the phases', () => withSandbox(async ({ root, buracleHome }) => {
    const repo = makeRepo(root)
    const txn = '20200101T000000000Z-abcdef'
    mkdirSync(join(buracleHome, 'journal'), { recursive: true })
    writeFileSync(join(buracleHome, 'journal', `${txn}.json`), JSON.stringify({ v: 1, txn, status: 'applying', startedAt: '2020-01-01T00:00:00.000Z', plans: [], files: [], createdDirs: [], execs: [], ledger: [] }))
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, async () => {
      const io = memoryIO({ verbose: true })
      expect(await installRun(['--yes'], io)).toBe(0)
      expect(io.out()).toContain(`Recovered (rolled back) interrupted transaction(s): ${txn}`)
      expect(io.err()).toContain('[1/9] preflight')
      expect(io.err()).toContain('[2/9] toolchain')
      expect(io.err()).toContain('[6/9] runtime')
      expect(io.err()).toContain('[9/9] post')
    })
  }))

  test('the core plan owns the shared path rules; a rule an older Codex plan wrote moves over; a canonical error never prunes them', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = makeRepo(root, { 'canonical/rules/paths/python.md': '---\npaths: ["**/*.py"]\n---\n# Python\n\nRun the formatter before committing.\n' })
    const rules = await renderPathRules(loadCanonicalSync(join(repo, 'canonical')))
    expect(rules.map(r => r.id)).toEqual(['python'])
    const content = rules[0]?.content as string
    expect(content).toContain('**/*.py')
    const rulePath = join(buracleHome, 'rules/paths/python.md')
    await applyPlans([{ id: 'codex', harness: 'codex', ops: [{ kind: 'file', path: rulePath, content, owner: 'codex' }] }])
    writeInstallRecord({ v: 1, plans: { codex: { keys: [rulePath] } }, execUndone: {} })
    const codex = fakeAdapter('codex', { plan: () => codexPlan(home, { '.codex/AGENTS.md': 'rules\n' }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      const io = memoryIO({ json: true })
      expect(await installRun(['--yes', '--json'], io)).toBe(0)
      expect(JSON.parse(io.out())).toMatchObject({ pruned: 0, conflicts: [] })
      expect(read(rulePath)).toBe(content)
      expect((await readLedger())[rulePath]?.owner).toBe('core')
      expect(readInstallRecord().record.plans['core']?.keys).toContain(rulePath)

      writeFileSync(join(repo, 'canonical/mcp.yaml'), 'servers: [\n')
      const broken = memoryIO({ json: true })
      expect(await installRun(['--yes', '--json'], broken)).toBe(1)
      expect(JSON.parse(broken.out())).toMatchObject({ ok: false, code: 1, install: null, build: { errors: [{ source: 'canonical' }] } })
      const flow = await runInstallFlow({ dryRun: false, yes: true, json: true }, memoryIO({ json: true }))
      expect(flow.pruned).toBe(0)
      expect(flow.warnings.some(w => w.includes('were not refreshed'))).toBe(true)
      expect(read(rulePath)).toBe(content)
      expect(readInstallRecord().record.plans['core']?.keys).toContain(rulePath)
    })
  }))

  test('runtime-config.json carries resolved.* as the installing environment sees it; the shim runs the same bun', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = makeRepo(root)
    await withEnv({ CODEX_HOME: join(root, 'codex-home'), PI_CODING_AGENT_DIR: join(root, 'omp-agent') }, () =>
      withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, async () => {
        expect(await installRun(['--yes'], memoryIO())).toBe(0)
        const snap = JSON.parse(read(join(buracleHome, 'state/runtime-config.json'))) as { v: number, config: { repo?: string }, resolved: Record<string, string> }
        const shim = join(buracleHome, process.platform === 'win32' ? 'bin/buracle.cmd' : 'bin/buracle')
        const shimBun = parseShimText(read(shim))?.bun
        expect(snap.v).toBe(1)
        expect(snap.config.repo).toBe(repo)
        expect(snap.resolved).toEqual({
          buracleHome,
          brain: join(buracleHome, 'brain'),
          shim,
          repoRoot: repo,
          claudeDir: join(home, '.claude'),
          codexHome: join(root, 'codex-home'),
          opencodeConfigDir: join(home, '.config/opencode'),
          ompAgentDir: join(root, 'omp-agent'),
          bun: shimBun as string,
        })
      }))
  }))

  test('install plans are composed from the checkout (they may bundle files), whatever the user\'s cwd', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const project = join(root, 'some-project')
    mkdirSync(project)
    const seen: string[] = []
    const opencode = fakeAdapter('opencode', { plan: () => { seen.push(process.cwd()); return { id: 'opencode', harness: 'opencode', ops: [{ kind: 'file', path: join(home, '.config/opencode/x.md'), content: 'x\n', owner: 'opencode' }] } } })
    const before = process.cwd()
    process.chdir(project)
    try {
      await withDeps({ repoRoot: () => repo, adapters: async () => [opencode], runCli: fakeCli().runCli }, async () => {
        expect(await installRun(['--yes'], memoryIO())).toBe(0)
      })
      expect(process.cwd()).toBe(realpathSync(project))
      expect(readdirSync(project)).toEqual([])
    } finally {
      process.chdir(before)
    }
    expect(seen).toEqual([realpathSync(repo)])
  }))

  test('--dry-run with a running harness warns that its plan is left out (exit 2) and writes nothing', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const codex = fakeAdapter('codex', {
      plan: () => { throw Object.assign(new Error('Codex is running (pid 7). Quit Codex and run the install again.'), { name: 'HarnessBusyError', code: 'HARNESS_BUSY', exitCode: 2 }) },
    })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli, fetch: noNetwork }, async () => {
      const before = snapshotTree(home)
      const io = memoryIO()
      expect(await installRun(['--dry-run'], io)).toBe(2)
      expect(io.err()).toContain('warning: codex is running, so its plan is not part of this preview and `buracle install` would skip it now (exit 2): Codex is running (pid 7)')
      expect(io.out()).toContain('codex  1.0.0  skipped: running; not changed')
      expect(io.out()).not.toContain('== plan codex')
      expect(snapshotTree(home)).toEqual(before)
    })
  }))

  test('next steps follow what the transaction did: Codex hook trust, the OpenCode service restart, the omp link', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    mkdirSync(join(home, 'Documents/Buracle'), { recursive: true })
    const log = join(root, 'calls.log')
    const envSet = join(root, 'service-env-set')
    const linked = join(root, 'omp-linked')
    const opencodeBin = fakeExe(join(root, 'bin', 'opencode'), `append(${JSON.stringify(log)}, 'opencode ' + argv.join(' '))\nfs.writeFileSync(${JSON.stringify(envSet)}, '')`)
    const ompBin = fakeExe(join(root, 'bin', 'omp'), `append(${JSON.stringify(log)}, 'omp ' + argv.join(' '))\nfs.writeFileSync(${JSON.stringify(linked)}, '')`)
    const fileExists = (p: string) => [process.execPath, '-e', `process.exit(require('node:fs').existsSync(${JSON.stringify(p)}) ? 0 : 1)`]
    const codex = fakeAdapter('codex', { plan: () => codexPlan(home, { '.codex/hooks.json': '{"hooks":{}}\n' }) })
    const opencode = fakeAdapter('opencode', {
      plan: () => ({ id: 'opencode', harness: 'opencode', ops: [{ kind: 'exec', argv: [opencodeBin, 'service', 'set', 'env', 'BURACLE_HOME', join(home, '.buracle')], undo: [opencodeBin, 'service', 'unset', 'env', 'BURACLE_HOME'], idempotentCheck: fileExists(envSet), owner: 'opencode' }] }),
    })
    const omp = fakeAdapter('omp', {
      plan: () => ({ id: 'omp', harness: 'omp', ops: [{ kind: 'exec', argv: [ompBin, 'plugin', 'link', join(repo, 'harness/omp')], undo: [ompBin, 'plugin', 'uninstall', 'buracle-omp'], idempotentCheck: fileExists(linked), owner: 'omp' }] }),
    })
    const claude = fakeAdapter('claude', { plan: () => ({ id: 'claude', harness: 'claude', ops: [{ kind: 'file', path: join(home, '.claude/rules/buracle/core.md'), content: '# rules\n', owner: 'claude' }] }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [claude, codex, opencode, omp], runCli: fakeCli().runCli }, async () => {
      const ask = memoryIO()
      expect(await installRun([], ask)).toBe(2)
      expect(ask.out()).toContain('stops OpenCode\'s background service once')
      expect(existsSync(log)).toBe(false)

      const io = memoryIO({ json: true })
      expect(await installRun(['--yes', '--json'], io)).toBe(0)
      const steps = (JSON.parse(io.out()) as { steps: string[] }).steps
      expect(steps.some(s => s.startsWith('Codex: ') && s.includes('/hooks') && s.includes('`buracle doctor codex`'))).toBe(true)
      expect(steps.some(s => s.startsWith('OpenCode: ') && s.includes('opencode service set env BURACLE_HOME'))).toBe(true)
      expect(steps.some(s => s.startsWith('Oh My Pi: ') && s.includes('omp plugin link'))).toBe(true)
      expect(steps.some(s => s.startsWith('Claude Code: ') && s.includes('/reload-plugins'))).toBe(true)
      expect(read(log)).toBe(`opencode service set env BURACLE_HOME ${join(home, '.buracle')}\nomp plugin link ${join(repo, 'harness/omp')}\n`)

      const again = memoryIO({ json: true })
      expect(await withEnv({ PATH: pathOf(join(home, '.local', 'bin'), process.env['PATH'] ?? '') }, () => installRun(['--yes', '--json'], again))).toBe(0)
      expect((JSON.parse(again.out()) as { steps: string[] }).steps).toEqual([])
      expect(read(log).split('\n').filter(Boolean)).toHaveLength(2)
    })
  }))

  test('managed lists (json-list-merge) are recorded per list and pruned when a plan stops producing one; user items stay', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const hooksJson = join(home, '.codex/hooks.json')
    mkdirSync(join(home, '.codex'), { recursive: true })
    const mine = { hooks: [{ type: 'command', command: 'my-own-stop-hook' }] }
    writeFileSync(hooksJson, JSON.stringify({ hooks: { Stop: [mine] } }, null, 2) + '\n')
    const group = (event: string) => ({ hooks: [{ type: 'command', command: `"$HOME/.buracle/bin/buracle" hook codex ${event}` }] })
    let events = ['Stop', 'SessionStart']
    const codex = fakeAdapter('codex', {
      plan: () => ({ id: 'codex', harness: 'codex', ops: events.map(e => ({ kind: 'json-list-merge' as const, path: hooksJson, pointer: `hooks.${e}`, items: [group(e)], identity: ['matcher', 'hooks.0.command'], owner: 'codex', format: 'json' as const })) }),
    })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      const first = JSON.parse(read(hooksJson)) as { hooks: Record<string, unknown[]> }
      expect(first.hooks['Stop']).toEqual([mine, group('Stop')])
      expect(first.hooks['SessionStart']).toEqual([group('SessionStart')])
      expect(readInstallRecord().record.plans['codex']?.keys).toEqual([listLedgerKey(hooksJson, 'hooks.SessionStart'), listLedgerKey(hooksJson, 'hooks.Stop')].sort())

      events = ['SessionStart']
      const io = memoryIO({ json: true })
      expect(await installRun(['--yes', '--json'], io)).toBe(0)
      expect(JSON.parse(io.out())).toMatchObject({ pruned: 1, conflicts: [] })
      const second = JSON.parse(read(hooksJson)) as { hooks: Record<string, unknown[]> }
      expect(second.hooks['Stop']).toEqual([mine])
      expect(second.hooks['SessionStart']).toEqual([group('SessionStart')])
      expect(readInstallRecord().record.plans['codex']?.keys).toEqual([listLedgerKey(hooksJson, 'hooks.SessionStart')])
    })
  }))

  test('shim template quoting and a non-default BURACLE_HOME', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    const checkout = shimContent({ bun: '/b/bun', repoRoot: "/r e/p'o", buracleHome: '/h/.b' }).split('\n')
    expect(checkout.slice(0, 3)).toEqual(['#!/bin/sh', '# Buracle CLI shim written by `buracle install`. Re-run `buracle install` instead of editing it.', '# buracle-shim: checkout'])
    expect(checkout).toContain(`if [ -z "\${BURACLE_HOME:-}" ]; then BURACLE_HOME='/h/.b'; export BURACLE_HOME; fi`)
    expect(checkout).toContain(`m='/r e/p'\\''o/src/cli/main.ts'`)
    expect(parseShimText(checkout.join('\n'))).toEqual({ mode: 'checkout', bun: '/b/bun', main: "/r e/p'o/src/cli/main.ts", checkout: resolve("/r e/p'o") })
    const frozen = shimContent({ bun: '/b/bun', repoRoot: '/r e/po', runtime: '/h/.b/runtime/0123456789abcdef' })
    expect(parseShimText(frozen)).toEqual({ mode: 'frozen', bun: '/b/bun', main: '/h/.b/runtime/0123456789abcdef/src/cli/main.ts', checkout: resolve('/r e/po') })
    expect(parseShimText(`#!/bin/sh\nexec '/b/bun' '/r e/po/src/cli/main.ts' "$@"\n`)).toEqual({ mode: 'legacy', bun: '/b/bun', main: '/r e/po/src/cli/main.ts', checkout: resolve('/r e/po') })
    expect(lstatSync(REAL_REPO).isDirectory()).toBe(true)
  })
})

describe('install: renamed config keys', () => {
  test('a value moved from a renamed key is reported as a config warning (O6)', () => withSandbox(async ({ root, buracleHome }) => {
    const repo = makeRepo(root)
    mkdirSync(buracleHome, { recursive: true })
    writeFileSync(join(buracleHome, 'config.yaml'), 'statusline:\n  theme: full\n')
    const renames = CONFIG_RENAMES as ConfigRename[]
    renames.push({ from: 'statusline.theme', to: 'statusline.style', since: '9.9.9' })
    try {
      await withDeps({ repoRoot: () => repo, adapters: async () => [fakeAdapter('claude', { installed: false })], runCli: fakeCli().runCli, fetch: noNetwork }, async () => {
        const r = await runInstallFlow({ dryRun: true, yes: true, json: true }, memoryIO({ json: true }))
        expect(r.warnings).toContain('config: ' + join(buracleHome, 'config.yaml') + ': statusline.theme was renamed to statusline.style in 9.9.9; its value was used (rename the key in config.yaml)')
      })
    } finally {
      renames.pop()
    }
  }))
})
