import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import * as checkers from '../../../src/core/checkers'
import type { CheckerPlan } from '../../../src/core/checkers'
import { defaultConfig } from '../../../src/core/config'
import { run } from '../../../src/engine/proc'
import { checkerArgv, checkOneFile, importersOf, lastFailed, lineCountOf, nodeCheckFs, removedByFile, scanUpward, testFilesNear, type CheckerResult, type FileCheckEnv } from '../../../src/adapters/shared/checker-scan'
import { withEnv, withSandbox } from '../../helpers/sandbox'

const CFG = defaultConfig().checkers

function put(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
  }
}

function env(over: Partial<FileCheckEnv> & { results?: (plan: CheckerPlan) => CheckerResult | null } = {}): FileCheckEnv & { runs: string[][] } {
  const runs: string[][] = []
  let clock = 1_000
  return {
    api: checkers,
    fs: nodeCheckFs,
    now: () => clock++,
    run: async plan => { runs.push(plan.argv); return over.results?.(plan) ?? { code: 0, stdout: '', stderr: '' } },
    resolve: argv => [...argv],
    guard: async (_what, fallback, fn) => { try { return await fn() } catch { return fallback } },
    runs,
    ...over,
  }
}

describe('scanUpward: the same project facts on every harness', () => {
  test('a monorepo package config below the git root and the hoisted eslint binary are found', () => withSandbox(async ({ root }) => {
    put(root, {
      'repo/package.json': '{"private":true}',
      'repo/node_modules/.bin/eslint': '#!/bin/sh\n',
      'repo/packages/web/package.json': '{"name":"web"}',
      'repo/packages/web/eslint.config.js': 'export default []\n',
      'repo/packages/web/src/a.ts': 'export const a = 1\n',
      'repo/svc/pyproject.toml': '[tool.ruff]\nline-length = 100\n',
      'repo/svc/.venv/bin/ruff': '#!/bin/sh\n',
      'repo/svc/app/main.py': 'x = 1\n',
    })
    const repo = join(root, 'repo')
    const ts = checkers.checkerFacts(scanUpward(nodeCheckFs, join(repo, 'packages/web/src/a.ts'), repo), repo)
    expect(ts).toEqual({ hasRuffConfig: false, hasEslintConfig: true, isGoModule: false, cwd: repo, eslintBin: join(repo, 'node_modules/.bin/eslint'), eslintCwd: join(repo, 'packages/web') })
    const py = checkers.checkerFacts(scanUpward(nodeCheckFs, join(repo, 'svc/app/main.py'), repo), repo)
    expect(py).toMatchObject({ hasRuffConfig: true, ruffBin: join(repo, 'svc/.venv/bin/ruff') })
    expect(scanUpward(nodeCheckFs, join(repo, 'svc/app/main.py'), repo).map(s => s.dir)).toEqual([join(repo, 'svc/app'), join(repo, 'svc'), repo])
  }))

  test('Windows shims: eslint.cmd wins over the sh shim on Windows and is ignored elsewhere', () => withSandbox(async ({ root }) => {
    put(root, {
      'node_modules/.bin/eslint': '#!/bin/sh\n',
      'node_modules/.bin/eslint.cmd': '@echo off\n',
      'eslint.config.js': 'export default []\n',
      'src/a.ts': 'export const a = 1\n',
    })
    const bin = (windows: boolean) => checkers.checkerFacts(scanUpward(nodeCheckFs, join(root, 'src/a.ts'), root, undefined, windows), root).eslintBin
    expect(bin(true)).toBe(join(root, 'node_modules/.bin/eslint.cmd'))
    expect(bin(false)).toBe(join(root, 'node_modules/.bin/eslint'))
  }))
})

describe('checkerArgv: the binary a checker runs', () => {
  test('a bare name is looked up, a path is kept, a missing tool stays bare for the exit-127 note', () => {
    expect(checkerArgv(['golangci-lint', 'run', '.'], n => (n === 'golangci-lint' ? '/tc/go/bin/golangci-lint' : undefined))).toEqual(['/tc/go/bin/golangci-lint', 'run', '.'])
    expect(checkerArgv(['/repo/node_modules/.bin/eslint', 'a.ts'], () => '/elsewhere/eslint')).toEqual(['/repo/node_modules/.bin/eslint', 'a.ts'])
    expect(checkerArgv(['shellcheck', '-f', 'gcc', 'a.sh'], () => undefined)).toEqual(['shellcheck', '-f', 'gcc', 'a.sh'])
  })

  test('on Windows a .cmd shim runs through cmd.exe', () => withEnv({ BURACLE_PLATFORM: 'win32' }, () => {
    expect(checkerArgv(['C:\\r\\node_modules\\.bin\\eslint.cmd', '--format', 'json', 'C:\\r\\a.ts'])).toEqual(['cmd.exe', '/d', '/s', '/c', 'C:\\r\\node_modules\\.bin\\eslint.cmd --format json C:\\r\\a.ts'])
  }))

  test.skipIf(process.platform === 'win32')('golangci-lint installed by `go install` into the toolchain runs from there and is not named missing', () => withSandbox(async ({ root, buracleHome }) => {
    put(root, { 'go.mod': 'module x\n', '.golangci.yml': 'version: "2"\n', 'pkg/a.go': 'package pkg\n', 'pkg/a_test.go': 'package pkg\n', 'empty/.keep': '' })
    const lint = join(buracleHome, 'toolchain', 'go', 'bin', 'golangci-lint')
    put(dirname(lint), { 'golangci-lint': '#!/bin/sh\necho "a.go:1:6: exported func should have comment (revive)"\nexit 1\n' })
    chmodSync(lint, 0o755)
    await withEnv({ PATH: join(root, 'empty') }, async () => {
      expect(checkerArgv(['golangci-lint', 'run', '.'])).toEqual([lint, 'run', '.'])
      const ran: string[][] = []
      const e = env({
        resolve: argv => checkerArgv(argv),
        run: async plan => {
          ran.push(plan.argv)
          if (basename(plan.argv[0] as string) !== 'golangci-lint') return { code: 0, stdout: '', stderr: '' }
          const r = await run(plan.argv, { cwd: plan.cwd, timeoutMs: 10_000 })
          return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut }
        },
      })
      const notes = await checkOneFile(e, { file: join(root, 'pkg/a.go'), cwd: root, root, deadlineMs: 1e12 }, CFG)
      expect(ran.at(-1)).toEqual([lint, 'run', '.'])
      expect(notes).toEqual([{ kind: 'finding', text: 'golangci-lint found 1 problem:\na.go:1:6: exported func should have comment (revive)' }])
    })
  }))
})

describe('test pairing on disk', () => {
  test('a mirrored tests/ folder and a test that imports the module silence the TDD hint', () => withSandbox(async ({ root }) => {
    put(root, {
      'src/core/checkers.ts': 'export const x = 1\n',
      'src/lib/thing.ts': 'export const t = 1\n',
      'src/lib/lonely.ts': 'export const l = 1\n',
      'tests/core/checkers/checkers.test.ts': "import { x } from '../../../src/core/checkers'\n",
      'tests/flows/end-to-end.test.ts': "import { t } from '../../src/lib/thing'\n",
      'tests/node_modules/x.test.ts': "import { l } from '../../src/lib/lonely'\n",
    })
    const scans = (f: string) => scanUpward(nodeCheckFs, join(root, f), root)
    expect(testFilesNear(nodeCheckFs, join(root, 'src/core/checkers.ts'), scans('src/core/checkers.ts'), () => 0)[0]).toBe(join(root, 'tests/core/checkers/checkers.test.ts'))
    const e = env()
    for (const f of ['src/core/checkers.ts', 'src/lib/thing.ts']) {
      const notes = await checkOneFile(e, { file: join(root, f), cwd: root, root, deadlineMs: 1e12 }, CFG)
      expect({ f, notes }).toEqual({ f, notes: [] })
    }
    const lonely = await checkOneFile(e, { file: join(root, 'src/lib/lonely.ts'), cwd: root, root, deadlineMs: 1e12 }, CFG)
    expect(lonely.map(n => n.kind)).toEqual(['tdd'])
    expect(lonely[0]?.text).toContain('in the test folders, and for a test that imports it')
    expect(importersOf(nodeCheckFs, join(root, 'src/lib/thing.ts'), [join(root, 'tests/flows/end-to-end.test.ts')], () => 0)).toEqual([join(root, 'tests/flows/end-to-end.test.ts')])
  }))

  test('pytest lastfailed: a module whose test fails is in a red-green cycle', () => withSandbox(async ({ root }) => {
    put(root, {
      'app/billing.py': 'def charge():\n    return 1\n',
      '.pytest_cache/v/cache/lastfailed': JSON.stringify({ 'tests/test_billing.py::test_charge': true }),
    })
    expect(lastFailed(nodeCheckFs, scanUpward(nodeCheckFs, join(root, 'app/billing.py'), root))).toEqual(['tests/test_billing.py'])
    expect(await checkOneFile(env(), { file: join(root, 'app/billing.py'), cwd: root, root, deadlineMs: 1e12 }, CFG)).toEqual([])
  }))

  test('.NET: a test project beside the project counts, logic-free files are skipped', () => withSandbox(async ({ root }) => {
    put(root, {
      'App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n',
      'App/Calc.cs': 'public class Calc { public int Add(int a, int b) { return a + b; } }\n',
      'App/Point.cs': 'public record Point(int X, int Y);\n',
      'App/Lonely.cs': 'public class Lonely { public int F() { return 1; } }\n',
      'App.Tests/App.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n',
      'App.Tests/CalcTests.cs': 'public class CalcTests { [Fact] public void Adds() { } }\n',
    })
    const e = env()
    const notes = async (f: string) => (await checkOneFile(e, { file: join(root, f), cwd: root, root, deadlineMs: 1e12 }, CFG)).filter(n => n.kind === 'tdd')
    expect(await notes('App/Calc.cs')).toEqual([])
    expect(await notes('App/Point.cs')).toEqual([])
    expect((await notes('App/Lonely.cs'))[0]?.text).toContain('LonelyTests.cs')
    expect(e.runs.every(a => a[0] === 'dotnet' && a.includes('--include'))).toBe(true)
  }))
})

describe('checkOneFile: running the plans', () => {
  test('a missing linter is named once per session; the trivial edit skips the TDD hint; the length note counts lines', () => withSandbox(async ({ root }) => {
    put(root, { 'run.sh': 'echo hi\necho there\n' })
    const seen = new Set<string>()
    const e = env({ results: () => ({ code: 127, stdout: '', stderr: 'spawn shellcheck ENOENT' }), once: key => (seen.has(key) ? false : (seen.add(key), true)) })
    const first = await checkOneFile(e, { file: join(root, 'run.sh'), cwd: root, root, deadlineMs: 1e12 }, CFG)
    expect(first).toEqual([{ kind: 'missing', text: 'shellcheck is not installed, so it did not check this file: run `buracle install`.' }])
    expect([...seen]).toEqual(['H04:missing:shellcheck'])
    expect(await checkOneFile(e, { file: join(root, 'run.sh'), cwd: root, root, deadlineMs: 1e12 }, CFG)).toEqual([])
    expect(lineCountOf('a\nb\n')).toBe(2)
    expect(lineCountOf('a\nb')).toBe(2)
    expect(lineCountOf('')).toBe(0)
  }))

  test('a missing Go toolchain is named once, not once for go and again for gofmt', () => withSandbox(async ({ root }) => {
    put(root, { 'go.mod': 'module x\n', 'pkg/a.go': 'package pkg\n', 'pkg/a_test.go': 'package pkg\n' })
    const seen = new Set<string>()
    const missing = () => ({ code: 127, stdout: '', stderr: 'spawn go ENOENT' })
    const ledger = env({ results: missing, once: key => (seen.has(key) ? false : (seen.add(key), true)) })
    const target = { file: join(root, 'pkg/a.go'), cwd: root, root, deadlineMs: 1e12 }
    expect(await checkOneFile(ledger, target, CFG)).toEqual([{ kind: 'missing', text: 'go is not on PATH, so it did not check this file: install Go (https://go.dev/dl/).' }])
    expect([...seen]).toEqual(['H04:missing:go'])
    expect((await checkOneFile(env({ results: missing }), target, CFG)).map(n => n.kind)).toEqual(['missing'])
  }))

  test('a plan environment reaches the runner (dotnet format prints English)', () => withSandbox(async ({ root }) => {
    put(root, { 'App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n', 'App/Calc.cs': 'public class Calc { }\n' })
    const envs: Array<Record<string, string> | undefined> = []
    await checkOneFile(env({ results: plan => { envs.push(plan.env); return { code: 0, stdout: '', stderr: '' } } }), { file: join(root, 'App/Calc.cs'), cwd: root, root, deadlineMs: 1e12 }, CFG)
    expect(envs).toEqual([{ LC_ALL: 'en_US.UTF-8', DOTNET_CLI_UI_LANGUAGE: 'en' }])
  }))

  test('slow plans are skipped when the budget left is short; a timeout is reported', () => withSandbox(async ({ root }) => {
    put(root, { 'go.mod': 'module x\n', '.golangci.yml': 'version: "2"\n', 'pkg/a.go': 'package pkg\n', 'pkg/a_test.go': 'package pkg\n' })
    const e = env({ results: plan => (plan.argv[0] === 'gofmt' ? { code: 124, stdout: '', stderr: '', timedOut: true } : { code: 0, stdout: '', stderr: '' }) })
    const notes = await checkOneFile(e, { file: join(root, 'pkg/a.go'), cwd: root, root, deadlineMs: 1_000 + 3_000 }, CFG)
    expect(e.runs.map(a => a[0])).toEqual(['go', 'gofmt'])
    expect(notes.map(n => n.text)).toEqual([expect.stringMatching(/^gofmt did not finish within \d+ s/), 'golangci-lint skipped (hook time budget used up)'])
  }))

  test('removed text of a patch is matched to the resolved file', () => {
    expect(removedByFile([{ path: 'src/a.ts', removed: 'old' }, { path: './b.ts', removed: '' }], ['/w/src/a.ts', '/w/b.ts', '/w/c.ts'])).toEqual({ '/w/src/a.ts': 'old' })
  })
})
