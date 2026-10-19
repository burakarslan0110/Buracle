export interface DirScan {
  dir: string
  names: readonly string[]
  pyproject?: string
  packageJson?: string
  present?: readonly string[]
}

export interface CheckerFacts {
  hasRuffConfig: boolean
  hasEslintConfig: boolean
  isGoModule: boolean
  cwd: string
  ruffBin?: string
  eslintBin?: string
  eslintCwd?: string
  golangci?: boolean
  dotnetDir?: string
}

const ESLINT_BINS = ['node_modules/.bin/eslint.exe', 'node_modules/.bin/eslint.cmd', 'node_modules/.bin/eslint']
const RUFF_BINS = ['.venv/Scripts/ruff.exe', '.venv/bin/ruff', 'venv/Scripts/ruff.exe', 'venv/bin/ruff']

export const CHECKER_PROBES: readonly string[] = [...ESLINT_BINS, ...RUFF_BINS]
export const CHECKER_SCAN_MAX_DIRS = 20

const ESLINT_CONFIG = /^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.(?:js|cjs|json|yml|yaml))?)$/
const GOLANGCI_CONFIG = /^\.golangci\.(?:ya?ml|toml|json)$/
const DOTNET_PROJECT = /\.(?:csproj|sln|slnx)$/i
const PROJECT_FILES = new Set(['package.json'])

function lastSep(p: string): number {
  return Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
}

function trimSep(p: string): string {
  const t = p.replace(/[\\/]+$/, '')
  if (t === '') return p.slice(0, 1)
  if (/^[A-Za-z]:$/.test(t)) return `${t}${p.length > t.length ? p.charAt(t.length) : '\\'}`
  return t
}

function isFsRoot(p: string): boolean {
  return p === '/' || p === '\\' || /^[A-Za-z]:[\\/]?$/.test(p) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(p)
}

function parentOf(p: string): string | undefined {
  const t = trimSep(p)
  if (isFsRoot(t)) return undefined
  const i = lastSep(t)
  if (i < 0) return undefined
  if (i === 0) return t.slice(0, 1)
  const up = t.slice(0, i)
  return /^[A-Za-z]:$/.test(up) ? `${up}${t[i]}` : up
}

function samePath(a: string, b: string): boolean {
  return trimSep(a).replace(/\\/g, '/') === trimSep(b).replace(/\\/g, '/')
}

function within(p: string, dir: string): boolean {
  const a = trimSep(p).replace(/\\/g, '/')
  const d = trimSep(dir).replace(/\\/g, '/')
  return a === d || a.startsWith(d.endsWith('/') ? d : `${d}/`)
}

export function checkerDirs(file: string, root: string | undefined, home?: string): string[] {
  if (typeof file !== 'string' || file === '') return []
  const inRoot = typeof root === 'string' && root !== '' && within(file, root)
  const out: string[] = []
  let dir = parentOf(file)
  while (dir !== undefined && out.length < CHECKER_SCAN_MAX_DIRS) {
    const isRoot = inRoot && samePath(dir, root as string)
    if (!isRoot && (isFsRoot(dir) || (typeof home === 'string' && home !== '' && samePath(dir, home)))) break
    out.push(dir)
    if (isRoot) break
    dir = parentOf(dir)
  }
  return out
}

function joinPath(dir: string, rel: string): string {
  const s = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${s}${s === '\\' ? rel.replace(/\//g, '\\') : rel}`
}

function packageEslintConfig(text: string | undefined): boolean {
  if (typeof text !== 'string' || !text.includes('eslintConfig')) return false
  try {
    const pkg = JSON.parse(text) as unknown
    return pkg !== null && typeof pkg === 'object' && !Array.isArray(pkg) && 'eslintConfig' in pkg
  } catch { return false }
}

export function checkerFacts(scans: readonly DirScan[], cwd: string): CheckerFacts {
  const facts: CheckerFacts = { hasRuffConfig: false, hasEslintConfig: false, isGoModule: false, cwd }
  const all: readonly DirScan[] = Array.isArray(scans) ? scans : []
  const list = all.filter(s => s !== null && typeof s === 'object' && typeof s.dir === 'string' && Array.isArray(s.names))
  let eslintAt = -1
  for (const [i, s] of list.entries()) {
    const names = s.names
    if (!facts.hasRuffConfig && (names.includes('ruff.toml') || names.includes('.ruff.toml') || /^\[tool\.ruff/m.test(s.pyproject ?? ''))) facts.hasRuffConfig = true
    if (eslintAt < 0 && (names.some(n => ESLINT_CONFIG.test(n)) || packageEslintConfig(s.packageJson))) eslintAt = i
    if (names.includes('go.mod')) facts.isGoModule = true
    if (names.some(n => GOLANGCI_CONFIG.test(n))) facts.golangci = true
    if (facts.dotnetDir === undefined && names.some(n => DOTNET_PROJECT.test(n))) facts.dotnetDir = s.dir
    const present = Array.isArray(s.present) ? s.present : []
    const ruff = RUFF_BINS.find(p => present.includes(p))
    if (facts.ruffBin === undefined && ruff !== undefined) facts.ruffBin = joinPath(s.dir, ruff)
    const eslint = ESLINT_BINS.find(p => present.includes(p))
    if (facts.eslintBin === undefined && eslint !== undefined) facts.eslintBin = joinPath(s.dir, eslint)
  }
  if (eslintAt >= 0) {
    facts.hasEslintConfig = true
    const pkg = list.slice(0, eslintAt + 1).find(s => s.names.some(n => PROJECT_FILES.has(n)))
    facts.eslintCwd = (pkg ?? list[eslintAt] as DirScan).dir
  }
  return facts
}
