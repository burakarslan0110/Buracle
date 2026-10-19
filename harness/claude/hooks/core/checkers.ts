import type { BuracleConfig } from './config'
import type { CheckerFacts } from './checker-facts'

export type { CheckerFacts, DirScan } from './checker-facts'
export { CHECKER_PROBES, CHECKER_SCAN_MAX_DIRS, checkerDirs, checkerFacts } from './checker-facts'
export type { TddEdit, TestCandidates } from './tdd'
export { TEST_DIR_NAMES, dotnetLogicFree, importsModule, isDotnetTestProjectName, isTestFileName, tddHint, trivialEdit } from './tdd'
export { CHARSET_MAX_FINDINGS, charsetFindings } from './charset'

export interface CheckerPlan { argv: string[]; cwd: string; timeoutMs: number; parser: 'ruff'|'eslint'|'tsc'|'go-vet'|'golangci'|'shellcheck'|'dotnet-format'|'generic'; minMs?: number; env?: Record<string, string> }

export const FINDINGS_MAX_LINES = 20
export const SLOW_CHECKER_MIN_MS = 4000
export const DOTNET_FORMAT_ENV: Readonly<Record<string, string>> = { LC_ALL: 'en_US.UTF-8', DOTNET_CLI_UI_LANGUAGE: 'en' }

function basename(p: string): string { return p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1) }
function dirname(p: string): string { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i <= 0 ? (i === 0 ? p.slice(0, 1) : '.') : p.slice(0, i) }
function ext(p: string): string { const b = basename(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i + 1).toLowerCase() }

const TS_EXT = new Set(['ts', 'tsx', 'mts', 'cts'])
const JS_EXT = new Set(['js', 'jsx', 'mjs', 'cjs'])

function relativeIn(path: string, dir: string): string | undefined {
  const d = dir.replace(/[\\/]+$/, '')
  if (path.length <= d.length + 1 || !path.startsWith(d) || !/[\\/]/.test(path.charAt(d.length))) return undefined
  return path.slice(d.length + 1)
}

export function checkersFor(path: string, facts: CheckerFacts, cfg: BuracleConfig['checkers']): CheckerPlan[] {
  if (!cfg || cfg.enabled === false || typeof path !== 'string' || path === '') return []
  const langs = new Set(Array.isArray(cfg.languages) ? cfg.languages : [])
  const timeoutMs = typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0 ? cfg.timeoutMs : 20000
  const cwd = facts.cwd || dirname(path)
  const e = ext(path)
  if ((e === 'py' || e === 'pyi') && langs.has('python') && facts.hasRuffConfig) {
    return [{ argv: [facts.ruffBin ?? 'ruff', 'check', '--output-format=concise', path], cwd, timeoutMs, parser: 'ruff' }]
  }
  if (((TS_EXT.has(e) && langs.has('typescript')) || (JS_EXT.has(e) && langs.has('javascript'))) && facts.hasEslintConfig && !path.endsWith('.d.ts')) {
    return [{ argv: [facts.eslintBin ?? 'eslint', '--format', 'json', path], cwd: facts.eslintCwd ?? cwd, timeoutMs, parser: 'eslint' }]
  }
  if (e === 'go' && langs.has('go') && facts.isGoModule) {
    const plans: CheckerPlan[] = [
      { argv: ['go', 'vet', '.'], cwd: dirname(path), timeoutMs, parser: 'go-vet' },
      { argv: ['gofmt', '-l', path], cwd, timeoutMs, parser: 'generic' },
    ]
    if (facts.golangci === true) plans.push({ argv: ['golangci-lint', 'run', '.'], cwd: dirname(path), timeoutMs, parser: 'golangci', minMs: SLOW_CHECKER_MIN_MS })
    return plans
  }
  if ((e === 'sh' || e === 'bash') && langs.has('shell')) {
    return [{ argv: ['shellcheck', '-f', 'gcc', path], cwd, timeoutMs, parser: 'shellcheck' }]
  }
  if (e === 'cs' && langs.has('dotnet') && typeof facts.dotnetDir === 'string' && facts.dotnetDir !== '') {
    const rel = relativeIn(path, facts.dotnetDir)
    if (rel === undefined || /(?:^|[\\/])(?:bin|obj)[\\/]/.test(rel)) return []
    return [{ argv: ['dotnet', 'format', 'whitespace', facts.dotnetDir, '--folder', '--verify-no-changes', '--verbosity', 'q', '--include', rel], cwd: facts.dotnetDir, timeoutMs, parser: 'dotnet-format', minMs: SLOW_CHECKER_MIN_MS, env: { ...DOTNET_FORMAT_ENV } }]
  }
  return []
}

function relativeTo(line: string, cwd: string): string {
  if (cwd === '' || cwd === '/') return line
  const prefix = /[\\/]$/.test(cwd) ? cwd : `${cwd}${cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/'}`
  return line.split(prefix).join('')
}

function note(title: string, items: string[], cwd: string): string | undefined {
  const clean = items.map(l => relativeTo(l.trimEnd(), cwd)).filter(l => l.trim() !== '')
  if (clean.length === 0) return undefined
  const room = FINDINGS_MAX_LINES - 1
  const shown = clean.length > room ? [...clean.slice(0, room - 1), `… ${clean.length - (room - 1)} more`] : clean
  return [title, ...shown].join('\n')
}

function tool(plan: CheckerPlan): string {
  const a0 = basename(plan.argv[0] ?? '')
  return a0 === '' ? plan.parser : a0
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

interface EslintMessage { line?: number; column?: number; severity?: number; message?: string; ruleId?: string | null }
interface EslintFile { filePath?: string; messages?: EslintMessage[] }

export function findingsOf(plan: CheckerPlan, result: { code: number, stdout: string, stderr: string } | null): string | undefined {
  if (!plan || result === null || result === undefined) return undefined
  const out = typeof result.stdout === 'string' ? result.stdout.replace(ANSI, '') : ''
  const errOut = typeof result.stderr === 'string' ? result.stderr.replace(ANSI, '') : ''
  const both = `${out}\n${errOut}`
  const lines = (s: string): string[] => s.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim() !== '')
  const failure = (): string | undefined => {
    if (result.code === 0) return undefined
    const first = lines(errOut)[0] ?? lines(out)[0]
    return first === undefined ? undefined : `${tool(plan)} could not check the file (exit ${result.code}): ${first.slice(0, 200)}`
  }
  switch (plan.parser) {
    case 'ruff': {
      const hits = lines(out).filter(l => /:\d+:\d+: [A-Z]+\d+/.test(l))
      if (hits.length > 0) return note(`ruff found ${hits.length} problem${hits.length === 1 ? '' : 's'}:`, hits, plan.cwd)
      return failure()
    }
    case 'eslint': {
      let files: EslintFile[] | undefined
      try {
        const parsed = JSON.parse(out) as unknown
        if (Array.isArray(parsed)) files = parsed as EslintFile[]
      } catch { files = undefined }
      if (files === undefined) return result.code === 0 ? undefined : (note('eslint reported:', lines(both), plan.cwd) ?? failure())
      const hits: string[] = []
      for (const f of files) {
        for (const m of Array.isArray(f.messages) ? f.messages : []) {
          if (typeof m.message !== 'string' || /^File ignored\b/.test(m.message)) continue
          hits.push(`${f.filePath ?? '?'}:${m.line ?? 0}:${m.column ?? 0}: ${m.severity === 2 ? 'error' : 'warning'} ${m.message}${m.ruleId ? ` (${m.ruleId})` : ''}`)
        }
      }
      return hits.length > 0 ? note(`eslint found ${hits.length} problem${hits.length === 1 ? '' : 's'}:`, hits, plan.cwd) : undefined
    }
    case 'go-vet': {
      const hits = lines(both).filter(l => /\.go:\d+(?::\d+)?:/.test(l))
      if (hits.length > 0) return note(`go vet found ${hits.length} problem${hits.length === 1 ? '' : 's'}:`, hits, plan.cwd)
      return failure()
    }
    case 'golangci': {
      const hits = lines(out).filter(l => /\.go:\d+(?::\d+)?:/.test(l))
      if (hits.length > 0) return note(`golangci-lint found ${hits.length} problem${hits.length === 1 ? '' : 's'}:`, hits, plan.cwd)
      return failure()
    }
    case 'shellcheck': {
      const hits = lines(out).filter(l => /:\d+:\d+: (?:error|warning|note|info|style)/.test(l))
      if (hits.length > 0) return note(`shellcheck found ${hits.length} problem${hits.length === 1 ? '' : 's'}:`, hits, plan.cwd)
      return failure()
    }
    case 'dotnet-format': {
      if (result.code !== 2) return undefined
      const at = plan.argv.indexOf('--include')
      const rel = at >= 0 ? plan.argv[at + 1] ?? '' : ''
      const title = `dotnet format: the whitespace is not formatted (run \`dotnet format whitespace . --folder --include ${rel}\` in ${plan.cwd}):`
      const hits = lines(both).filter(l => /\.cs\(\d+,\d+\):/.test(l)).map(l => l.replace(/\s+\[[^\]]*\]$/, ''))
      return note(title, hits.length > 0 ? hits : [rel], plan.cwd)
    }
    case 'tsc': {
      const hits = lines(both).filter(l => /\(\d+,\d+\): error TS\d+/.test(l) || /:\d+:\d+ - error TS\d+/.test(l))
      if (hits.length > 0) return note(`tsc found ${hits.length} type error${hits.length === 1 ? '' : 's'}:`, hits, plan.cwd)
      return failure()
    }
    case 'generic': {
      if (tool(plan) === 'gofmt' && plan.argv.includes('-l')) {
        const files = lines(out)
        if (files.length > 0) return note('gofmt: not formatted (run `gofmt -w` on it):', files, plan.cwd)
        return failure()
      }
      if (result.code === 0) return undefined
      return note(`${tool(plan)} exited ${result.code}:`, lines(both), plan.cwd)
    }
  }
}

const TOOLCHAIN_CHECKERS = new Set(['ruff', 'shellcheck', 'golangci-lint'])

export function checkerTool(plan: CheckerPlan): string {
  return tool(plan).replace(/\.(?:exe|cmd|bat)$/i, '')
}

const TOOL_FAMILY: Readonly<Record<string, string>> = { gofmt: 'go' }

export function missingToolKey(plan: CheckerPlan): string {
  const name = checkerTool(plan)
  return `H04:missing:${TOOL_FAMILY[name] ?? name}`
}

export function missingToolNote(plan: CheckerPlan): string | undefined {
  if (!plan || !Array.isArray(plan.argv) || plan.argv.length === 0) return undefined
  const name = checkerTool(plan)
  if (TOOLCHAIN_CHECKERS.has(name)) return `${name} is not installed, so it did not check this file: run \`buracle install\`.`
  if (name === 'eslint') return 'eslint is configured but not installed (no node_modules/.bin/eslint and none on PATH), so it did not check this file: install the project\'s dependencies.'
  if (name === 'go' || name === 'gofmt') return `${name} is not on PATH, so it did not check this file: install Go (https://go.dev/dl/).`
  if (name === 'dotnet') return 'dotnet is not on PATH, so dotnet format did not check this file: install the .NET SDK (https://dotnet.microsoft.com/download).'
  return `${name} is not installed, so it did not check this file.`
}

export function skippedNote(plan: CheckerPlan): string {
  return `${checkerTool(plan)} skipped (hook time budget used up)`
}

export function lengthNote(lineCount: number): string | undefined {
  if (typeof lineCount !== 'number' || !Number.isFinite(lineCount)) return undefined
  if (lineCount > 1000) return `This file has ${lineCount} lines (over 1000): split it along existing seams before adding more.`
  if (lineCount > 800) return `This file has ${lineCount} lines (over 800): prefer splitting it along existing seams over growing it further.`
  return undefined
}
