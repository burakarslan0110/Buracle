import { describe, expect, test } from 'bun:test'
import { FINDINGS_MAX_LINES, checkerDirs, checkerFacts, checkersFor, findingsOf, lengthNote, missingToolKey, missingToolNote, skippedNote } from '../../../src/core/checkers'
import type { CheckerFacts, CheckerPlan, DirScan } from '../../../src/core/checkers'
import { defaultConfig } from '../../../src/core/config'

const CFG = defaultConfig().checkers
const CWD = '/repo'
const facts = (over: Partial<CheckerFacts> = {}): CheckerFacts => ({ hasRuffConfig: false, hasEslintConfig: false, isGoModule: false, cwd: CWD, ...over })

describe('checkersFor', () => {
  test('python uses ruff only with a ruff config', () => {
    expect(checkersFor('/repo/app/main.py', facts({ hasRuffConfig: true }), CFG)).toEqual([
      { argv: ['ruff', 'check', '--output-format=concise', '/repo/app/main.py'], cwd: CWD, timeoutMs: 20000, parser: 'ruff' },
    ])
    expect(checkersFor('/repo/app/main.py', facts(), CFG)).toEqual([])
  })

  test('python prefers the ruff of the project virtualenv', () => {
    expect(checkersFor('/repo/app/main.py', facts({ hasRuffConfig: true, ruffBin: '/repo/.venv/bin/ruff' }), CFG)[0]?.argv[0]).toBe('/repo/.venv/bin/ruff')
  })

  test('ts/js use the nearest eslint (else the one on PATH) only with an eslint config, in the nearest package folder', () => {
    for (const p of ['/repo/src/a.ts', '/repo/src/a.tsx', '/repo/src/a.js', '/repo/src/a.mjs']) {
      expect(checkersFor(p, facts({ hasEslintConfig: true }), CFG)).toEqual([
        { argv: ['eslint', '--format', 'json', p], cwd: CWD, timeoutMs: 20000, parser: 'eslint' },
      ])
    }
    expect(checkersFor('/repo/packages/web/src/a.ts', facts({ hasEslintConfig: true, eslintBin: '/repo/node_modules/.bin/eslint', eslintCwd: '/repo/packages/web' }), CFG)).toEqual([
      { argv: ['/repo/node_modules/.bin/eslint', '--format', 'json', '/repo/packages/web/src/a.ts'], cwd: '/repo/packages/web', timeoutMs: 20000, parser: 'eslint' },
    ])
    expect(checkersFor('/repo/src/a.ts', facts(), CFG)).toEqual([])
    expect(checkersFor('/repo/src/types.d.ts', facts({ hasEslintConfig: true }), CFG)).toEqual([])
  })

  test('go runs go vet in the package dir and gofmt -l inside a module', () => {
    expect(checkersFor('/repo/pkg/x/a.go', facts({ isGoModule: true }), CFG)).toEqual([
      { argv: ['go', 'vet', '.'], cwd: '/repo/pkg/x', timeoutMs: 20000, parser: 'go-vet' },
      { argv: ['gofmt', '-l', '/repo/pkg/x/a.go'], cwd: CWD, timeoutMs: 20000, parser: 'generic' },
    ])
    expect(checkersFor('/repo/pkg/x/a.go', facts(), CFG)).toEqual([])
  })

  test('go adds golangci-lint in the package folder when the project configures it, and asks for enough hook time', () => {
    const plans = checkersFor('/repo/pkg/x/a.go', facts({ isGoModule: true, golangci: true }), CFG)
    expect(plans.map(p => p.argv[0])).toEqual(['go', 'gofmt', 'golangci-lint'])
    expect(plans[2]).toEqual({ argv: ['golangci-lint', 'run', '.'], cwd: '/repo/pkg/x', timeoutMs: 20000, parser: 'golangci', minMs: 4000 })
  })

  test('C# runs dotnet format whitespace on the nearest project folder for the one file', () => {
    expect(checkersFor('/repo/App/src/Calc.cs', facts({ dotnetDir: '/repo/App' }), CFG)).toEqual([
      { argv: ['dotnet', 'format', 'whitespace', '/repo/App', '--folder', '--verify-no-changes', '--verbosity', 'q', '--include', 'src/Calc.cs'], cwd: '/repo/App', timeoutMs: 20000, parser: 'dotnet-format', minMs: 4000, env: { LC_ALL: 'en_US.UTF-8', DOTNET_CLI_UI_LANGUAGE: 'en' } },
    ])
    expect(checkersFor('/repo/App/obj/Debug/Gen.cs', facts({ dotnetDir: '/repo/App' }), CFG)).toEqual([])
    expect(checkersFor('/repo/App/src/Calc.cs', facts(), CFG)).toEqual([])
    expect(checkersFor('/repo/App/src/Calc.cs', facts({ dotnetDir: '/repo/App' }), { ...CFG, languages: ['python'] })).toEqual([])
    expect(checkersFor('/repo/App/Page.razor', facts({ dotnetDir: '/repo/App' }), CFG)).toEqual([])
  })

  test('shell scripts use shellcheck', () => {
    expect(checkersFor('/repo/scripts/a.sh', facts(), CFG)).toEqual([{ argv: ['shellcheck', '-f', 'gcc', '/repo/scripts/a.sh'], cwd: CWD, timeoutMs: 20000, parser: 'shellcheck' }])
    expect(checkersFor('/repo/scripts/a.bash', facts(), CFG)).toHaveLength(1)
    expect(checkersFor('/repo/scripts/a.zsh', facts(), CFG)).toEqual([])
  })

  test('config: disabled, language list and timeout', () => {
    expect(checkersFor('/repo/a.sh', facts(), { ...CFG, enabled: false })).toEqual([])
    expect(checkersFor('/repo/a.sh', facts(), { ...CFG, languages: ['python'] })).toEqual([])
    expect(checkersFor('/repo/a.ts', facts({ hasEslintConfig: true }), { ...CFG, languages: ['javascript'] })).toEqual([])
    expect(checkersFor('/repo/a.js', facts({ hasEslintConfig: true }), { ...CFG, languages: ['javascript'] })).toHaveLength(1)
    expect(checkersFor('/repo/a.sh', facts(), { ...CFG, timeoutMs: 5000 })[0]?.timeoutMs).toBe(5000)
  })

  test('other files get no checker', () => {
    for (const p of ['/repo/README.md', '/repo/a.json', '/repo/Makefile', '/repo/a.rs', '']) expect(checkersFor(p, facts({ hasRuffConfig: true, hasEslintConfig: true, isGoModule: true, dotnetDir: '/repo' }), CFG)).toEqual([])
  })
})

const scan = (dir: string, names: string[], extra: Partial<DirScan> = {}): DirScan => ({ dir, names, ...extra })

describe('checkerDirs and checkerFacts (one planner for every harness)', () => {
  test('the folders to scan run from the file up to the project root, never the home folder or /', () => {
    expect(checkerDirs('/repo/packages/web/src/a.ts', '/repo')).toEqual(['/repo/packages/web/src', '/repo/packages/web', '/repo/packages', '/repo'])
    expect(checkerDirs('/repo/a.ts', '/repo')).toEqual(['/repo'])
    expect(checkerDirs('/Users/u/notes/x/a.py', undefined, '/Users/u')).toEqual(['/Users/u/notes/x', '/Users/u/notes'])
    expect(checkerDirs('/Users/u/a.py', '/Users/u', '/Users/u')).toEqual(['/Users/u'])
    expect(checkerDirs('/tmp/x/a.sh', '/repo')).toEqual(['/tmp/x', '/tmp'])
    expect(checkerDirs('C:\\repo\\src\\a.ts', 'C:\\repo')).toEqual(['C:\\repo\\src', 'C:\\repo'])
    expect(checkerDirs('', '/repo')).toEqual([])
    expect(checkerDirs(Array.from({ length: 30 }, (_, i) => `d${i}`).reduce((p, d) => `${p}/${d}`, '') + '/a.ts', undefined)).toHaveLength(20)
  })

  test('monorepo: the config of a package below the git root is found, and eslint runs in the nearest package with the hoisted binary', () => {
    const f = checkerFacts([
      scan('/repo/packages/web/src', ['a.ts']),
      scan('/repo/packages/web', ['package.json', 'eslint.config.js', 'src'], { packageJson: '{"name":"web"}' }),
      scan('/repo/packages', ['web']),
      scan('/repo', ['package.json', 'node_modules', 'pyproject.toml'], { packageJson: '{}', pyproject: '[project]\nname = "x"\n', present: ['node_modules/.bin/eslint'] }),
    ], '/repo')
    expect(f).toEqual({ hasRuffConfig: false, hasEslintConfig: true, isGoModule: false, cwd: '/repo', eslintBin: '/repo/node_modules/.bin/eslint', eslintCwd: '/repo/packages/web' })
  })

  test('a root eslint config runs in the nearest package folder below it; package.json eslintConfig counts', () => {
    expect(checkerFacts([scan('/repo/packages/api/src', []), scan('/repo/packages/api', ['package.json'], { packageJson: '{}' }), scan('/repo', ['eslint.config.mjs'])], '/s').eslintCwd).toBe('/repo/packages/api')
    expect(checkerFacts([scan('/repo', ['package.json'], { packageJson: '{"eslintConfig":{"rules":{}}}' })], '/s')).toMatchObject({ hasEslintConfig: true, eslintCwd: '/repo' })
    expect(checkerFacts([scan('/repo', ['package.json'], { packageJson: '{"name":"eslintConfig"}' })], '/s').hasEslintConfig).toBe(false)
    expect(checkerFacts([scan('/repo', ['package.json'], { packageJson: 'not json, eslintConfig' })], '/s').hasEslintConfig).toBe(false)
  })

  test('ruff config in a pyproject or ruff.toml anywhere up the tree; the venv ruff wins', () => {
    expect(checkerFacts([scan('/repo/svc/app', []), scan('/repo/svc', ['pyproject.toml', '.venv'], { pyproject: '[tool.ruff]\nline-length = 100\n', present: ['.venv/bin/ruff'] })], '/repo'))
      .toEqual({ hasRuffConfig: true, hasEslintConfig: false, isGoModule: false, cwd: '/repo', ruffBin: '/repo/svc/.venv/bin/ruff' })
    expect(checkerFacts([scan('/repo', ['.ruff.toml'])], '/repo').hasRuffConfig).toBe(true)
    expect(checkerFacts([scan('/repo', ['pyproject.toml'], { pyproject: '[tool.black]\n' })], '/repo').hasRuffConfig).toBe(false)
  })

  test('go module, golangci config and the nearest .NET project or solution', () => {
    expect(checkerFacts([scan('/repo/svc/pkg', []), scan('/repo/svc', ['go.mod']), scan('/repo', ['.golangci.yml'])], '/repo')).toMatchObject({ isGoModule: true, golangci: true })
    expect(checkerFacts([scan('/repo/svc', ['go.mod'])], '/repo').golangci).toBeUndefined()
    expect(checkerFacts([scan('/repo/App/src', ['Calc.cs']), scan('/repo/App', ['App.csproj']), scan('/repo', ['App.sln'])], '/repo').dotnetDir).toBe('/repo/App')
    expect(checkerFacts([scan('/repo/src', []), scan('/repo', ['App.slnx'])], '/repo').dotnetDir).toBe('/repo')
    expect(checkerFacts([], '/repo')).toEqual({ hasRuffConfig: false, hasEslintConfig: false, isGoModule: false, cwd: '/repo' })
    expect(checkerFacts(null as unknown as DirScan[], '/repo').cwd).toBe('/repo')
  })
})

const plan = (parser: CheckerPlan['parser'], argv: string[] = ['tool', 'x']): CheckerPlan => ({ argv, cwd: CWD, timeoutMs: 1000, parser })
const run = (code: number, stdout = '', stderr = '') => ({ code, stdout, stderr })

describe('findingsOf', () => {
  test('null (could not run) and clean runs are silent', () => {
    expect(findingsOf(plan('ruff'), null)).toBeUndefined()
    expect(findingsOf(plan('ruff'), run(0, 'All checks passed!\n'))).toBeUndefined()
    expect(findingsOf(plan('shellcheck'), run(0))).toBeUndefined()
    expect(findingsOf(plan('eslint'), run(0, '[]'))).toBeUndefined()
  })

  test('ruff concise output, paths relative to cwd', () => {
    const out = '/repo/app/main.py:3:8: F401 [*] `os` imported but unused\n/repo/app/main.py:9:1: E302 expected 2 blank lines\nFound 2 errors.\n'
    const note = findingsOf(plan('ruff'), run(1, out)) as string
    expect(note.split('\n')).toEqual(['ruff found 2 problems:', 'app/main.py:3:8: F401 [*] `os` imported but unused', 'app/main.py:9:1: E302 expected 2 blank lines'])
  })

  test('eslint JSON: errors and warnings, ignored-file notices dropped, bad JSON falls back to text', () => {
    const json = JSON.stringify([{ filePath: '/repo/src/a.ts', messages: [
      { line: 3, column: 7, severity: 2, message: "'x' is assigned a value but never used.", ruleId: 'no-unused-vars' },
      { line: 9, column: 1, severity: 1, message: 'Unexpected console statement.', ruleId: 'no-console' },
      { line: 0, column: 0, severity: 1, message: 'File ignored because of a matching ignore pattern.', ruleId: null },
    ] }])
    expect(findingsOf(plan('eslint'), run(1, json))).toBe("eslint found 2 problems:\nsrc/a.ts:3:7: error 'x' is assigned a value but never used. (no-unused-vars)\nsrc/a.ts:9:1: warning Unexpected console statement. (no-console)")
    expect(findingsOf(plan('eslint'), run(2, 'Oops! Something went wrong!', ''))).toContain('Something went wrong')
  })

  test('go vet, shellcheck, tsc and golangci formats', () => {
    expect(findingsOf(plan('go-vet'), run(1, '', '# example.com/x\n./a.go:12:2: fmt.Printf format %d has arg s of wrong type string\n'))).toBe('go vet found 1 problem:\n./a.go:12:2: fmt.Printf format %d has arg s of wrong type string')
    expect(findingsOf(plan('shellcheck'), run(1, '/repo/a.sh:3:6: warning: Double quote to prevent globbing and word splitting. [SC2086]\n'))).toBe('shellcheck found 1 problem:\na.sh:3:6: warning: Double quote to prevent globbing and word splitting. [SC2086]')
    expect(findingsOf(plan('tsc'), run(2, 'src/a.ts(3,5): error TS2322: Type string is not assignable to type number.\n'))).toContain('tsc found 1 type error')
    expect(findingsOf(plan('golangci'), run(1, 'a.go:3:1: exported function X should have comment (golint)\n'))).toContain('golangci-lint found 1 problem')
  })

  test('gofmt -l lists files that need formatting even with exit 0', () => {
    const p = plan('generic', ['gofmt', '-l', '/repo/a.go'])
    expect(findingsOf(p, run(0, '/repo/a.go\n'))).toBe('gofmt: not formatted (run `gofmt -w` on it):\na.go')
    expect(findingsOf(p, run(0, ''))).toBeUndefined()
  })

  test('dotnet format: exit 2 lists the lines that need formatting; other exits are tool failures and stay silent', () => {
    const p: CheckerPlan = { argv: ['dotnet', 'format', 'whitespace', '/repo/App', '--folder', '--verify-no-changes', '--verbosity', 'q', '--include', 'src/Calc.cs'], cwd: '/repo/App', timeoutMs: 1000, parser: 'dotnet-format' }
    const out = '/repo/App/src/Calc.cs(4,34): error WHITESPACE: Fix whitespace formatting. Delete 2 characters. [/repo/App]\n'
    expect(findingsOf(p, run(2, out))).toBe('dotnet format: the whitespace is not formatted (run `dotnet format whitespace . --folder --include src/Calc.cs` in /repo/App):\nsrc/Calc.cs(4,34): error WHITESPACE: Fix whitespace formatting. Delete 2 characters.')
    expect(findingsOf(p, run(2, ''))).toContain('\nsrc/Calc.cs')
    for (const code of [0, 1, 3, 4]) expect(findingsOf(p, run(code, 'Unhandled exception'))).toBeUndefined()
  })

  test('colored output is read without its ANSI escapes', () => {
    expect(findingsOf(plan('golangci'), run(1, '\u001b[1ma.go:3:1\u001b[0m: exported function X should have comment (revive)\n'))).toBe('golangci-lint found 1 problem:\na.go:3:1: exported function X should have comment (revive)')
  })

  test('a tool failure without findings is reported in one line', () => {
    expect(findingsOf(plan('ruff', ['ruff', 'check']), run(2, '', 'error: Failed to parse ruff.toml\nmore\n'))).toBe('ruff could not check the file (exit 2): error: Failed to parse ruff.toml')
    expect(findingsOf(plan('generic', ['mytool']), run(3, 'bad thing'))).toBe('mytool exited 3:\nbad thing')
  })

  test(`notes are at most ${FINDINGS_MAX_LINES} lines`, () => {
    const out = Array.from({ length: 50 }, (_, i) => `/repo/a.py:${i + 1}:1: E501 line too long`).join('\n')
    const note = findingsOf(plan('ruff'), run(1, out)) as string
    const lines = note.split('\n')
    expect(lines.length).toBe(FINDINGS_MAX_LINES)
    expect(lines[0]).toBe('ruff found 50 problems:')
    expect(lines[lines.length - 1]).toBe('… 32 more')
  })
})

describe('missing tools and the time budget', () => {
  const p = (argv0: string): CheckerPlan => ({ argv: [argv0, 'x'], cwd: CWD, timeoutMs: 1000, parser: 'generic' })
  test('a missing toolchain linter names the install command; eslint, Go and .NET say what to install', () => {
    expect(missingToolNote(p('ruff'))).toBe('ruff is not installed, so it did not check this file: run `buracle install`.')
    expect(missingToolNote(p('shellcheck'))).toBe('shellcheck is not installed, so it did not check this file: run `buracle install`.')
    expect(missingToolNote(p('golangci-lint'))).toBe('golangci-lint is not installed, so it did not check this file: run `buracle install`.')
    expect(missingToolNote(p('/repo/.venv/Scripts/ruff.exe'))).toBe('ruff is not installed, so it did not check this file: run `buracle install`.')
    expect(missingToolNote(p('eslint'))).toContain("install the project's dependencies")
    expect(missingToolNote(p('gofmt'))).toContain('install Go')
    expect(missingToolNote(p('dotnet'))).toContain('.NET SDK')
    expect(missingToolNote(p('mytool'))).toBe('mytool is not installed, so it did not check this file.')
    expect(missingToolNote({ argv: [], cwd: CWD, timeoutMs: 1, parser: 'generic' })).toBeUndefined()
  })

  test('the once-per-session key names the toolchain: gofmt shares Go\'s key', () => {
    expect(['go', 'gofmt', '/usr/local/go/bin/gofmt', 'golangci-lint', 'C:\\r\\node_modules\\.bin\\eslint.cmd'].map(a => missingToolKey(p(a)))).toEqual(['H04:missing:go', 'H04:missing:go', 'H04:missing:go', 'H04:missing:golangci-lint', 'H04:missing:eslint'])
  })

  test('a skipped plan names the tool', () => {
    expect(skippedNote(p('/usr/bin/golangci-lint'))).toBe('golangci-lint skipped (hook time budget used up)')
  })
})

describe('lengthNote', () => {
  test('silent up to 800 lines, a warning above, critical above 1000', () => {
    expect(lengthNote(10)).toBeUndefined()
    expect(lengthNote(800)).toBeUndefined()
    expect(lengthNote(801)).toContain('over 800')
    expect(lengthNote(1000)).toContain('over 800')
    expect(lengthNote(1001)).toContain('over 1000')
    expect(lengthNote(1001)).toContain('split it')
    expect(lengthNote(Number.NaN)).toBeUndefined()
  })
})
