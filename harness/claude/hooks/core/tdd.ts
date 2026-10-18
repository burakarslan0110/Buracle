export interface TestCandidates {
  siblings: readonly string[]
  testFiles?: readonly string[]
  importers?: readonly string[]
  failing?: readonly string[]
}

export interface TddEdit { removed?: string; added?: string; source?: string }

function basename(p: string): string { return p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1) }
function dirname(p: string): string { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i <= 0 ? (i === 0 ? p.slice(0, 1) : '.') : p.slice(0, i) }
function ext(p: string): string { const b = basename(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i + 1).toLowerCase() }
function slash(p: string): string { return p.replace(/\\/g, '/') }

const TDD_EXT = new Set(['py', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'go', 'cs'])
const JS_FAMILY = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'])
const NON_SOURCE_DIR = /(?:^|\/)(?:node_modules|dist|build|out|vendor|third_party|migrations?|generated|__generated__|gen|\.venv|venv|__pycache__|coverage|fixtures?|__fixtures__|examples?|docs|scripts|\.github|\.next|\.turbo)(?:\/|$)/i
const DOTNET_BUILD_DIR = /(?:^|\/)(?:bin|obj)(?:\/|$)/
const TEST_DIR = /(?:^|\/)(?:tests?|__tests__|spec|specs|testing|e2e)(?:\/|$)/i
const DOTNET_TEST_DIR = /(?:^|\/)(?:[^/]+\.(?:Unit|Integration|Functional|Acceptance)?Tests?|[A-Z][A-Za-z0-9]*Tests)(?:\/|$)/
const NON_SOURCE_FILE = /(?:\.d\.ts|\.config\.[cm]?[jt]s|\.stories\.[jt]sx?|^conftest\.py|^setup\.py|^__init__\.py|^manage\.py|^__main__\.py|^vite-env\.d\.ts|^index\.d\.ts|\.(?:designer|g|g\.i|generated)\.cs|^AssemblyInfo\.cs|^GlobalUsings\.cs)$/i

export const TEST_DIR_NAMES: readonly string[] = ['tests', 'test', '__tests__', 'spec', 'specs', 'Tests']

export function isTestFileName(name: string): boolean {
  const base = basename(name)
  return /^test_.*\.py$/i.test(base) || /_test\.(?:py|go)$/i.test(base) || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(base) || /Tests?\.cs$/.test(base)
}

export function isDotnetTestProjectName(name: string): boolean {
  return /\.(?:Unit|Integration|Functional|Acceptance)?Tests?$/i.test(name) || /^[A-Z][A-Za-z0-9]*Tests$/.test(name)
}

function squash(s: string): string { return s.toLowerCase().replace(/[-_.]/g, '') }

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').toLowerCase()
}

function lines(s: string): string[] {
  return s.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '')
}

const IMPORT_STATEMENT = /^(?:import\b|from\s+\S+\s+import\b|export\s+(?:\*|\{[^}]*\}|type\s+\{[^}]*\})\s+from\s|\}\s*from\s|using\s+(?:static\s+)?[\w.]+\s*(?:=\s*[\w.<>]+\s*)?;$|#include\s|(?:const|let|var)\s+[\w${},\s]+=\s*require\(|require\()/
const IMPORT_PART = /^(?:"[^"]+"|[()]|[A-Za-z_$][\w$]*(?:\s+as\s+[A-Za-z_$][\w$]*)?,?)$/
const CONST_LINE = /^(?:export\s+)?(?:(?:const|final|static|public|private|internal|readonly)\s+)*[A-Z][A-Z0-9_]*\s*(?::[^=]+)?=\s*\S/

function subsequence(shorter: readonly string[], longer: readonly string[]): boolean {
  let k = 0
  for (const l of longer) if (k < shorter.length && shorter[k] === l) k++
  return k === shorter.length
}

export function trivialEdit(removed: string, added: string): boolean {
  const old = lines(typeof removed === 'string' ? removed : '')
  const neu = lines(typeof added === 'string' ? added : '')
  if (old.length === 0 && neu.length === 0) return false
  if (neu.length === 0) return true
  const all = [...old, ...neu]
  if (all.some(l => IMPORT_STATEMENT.test(l)) && all.every(l => IMPORT_STATEMENT.test(l) || IMPORT_PART.test(l))) return true
  if (neu.length < old.length && subsequence(neu, old)) return true
  const fresh = neu.filter(l => !old.includes(l))
  const gone = old.filter(l => !neu.includes(l))
  return fresh.length > 0 && gone.length === 0 && fresh.every(l => CONST_LINE.test(l))
}

export function stripCsharp(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i] as string
    const next = src[i + 1]
    if (c === '/' && next === '/') { const j = src.indexOf('\n', i); if (j < 0) break; i = j; continue }
    if (c === '/' && next === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue }
    if (c === '@' && (next === '"' || (next === '$' && src[i + 2] === '"'))) {
      i += next === '"' ? 2 : 3
      while (i < n) { if (src[i] === '"') { if (src[i + 1] === '"') { i += 2; continue } i++; break } i++ }
      continue
    }
    if (c === '"' || c === "'") {
      i++
      while (i < n) { if (src[i] === '\\') { i += 2; continue } if (src[i] === c || src[i] === '\n') { i++; break } i++ }
      continue
    }
    out += c
    i++
  }
  return out
}

export function dotnetLogicFree(source: string): boolean {
  if (typeof source !== 'string' || source === '') return false
  const code = stripCsharp(source)
  if (!/\b(?:interface|enum|record|class|struct)\b/.test(code)) return false
  if (code.includes('=>')) return false
  if (/\b(?:return|if|for|foreach|while|switch|try|throw|await|yield|goto|do)\b/.test(code)) return false
  if (/\b(?:get|set|init|add|remove)\b\s*\{/.test(code)) return false
  const body = code
    .replace(/\b(?:record|class|struct|interface)\s+\w+(?:\s*<[^>]*>)?\s*\([^)]*\)/g, ' ')
    .replace(/=\s*(?:new\b\s*)?[\w.]*(?:\s*<[^>]*>)?\s*\([^)]*\)/g, ' ')
    .replace(/\bnew\s*\(\s*\)/g, ' ')
  return !/\)\s*(?:where\b[^{}]*)?\{/.test(body)
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function normalizeRel(base: string, spec: string): string {
  const parts = slash(base).split('/')
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { if (parts.length > 1) parts.pop(); continue }
    parts.push(seg)
  }
  return parts.join('/')
}

const JS_SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bmock\s*\(\s*)['"]([^'"\n]+)['"]/g
const JS_EXT = /\.(?:[cm]?[jt]sx?)$/

export function importsModule(text: string, testPath: string, modulePath: string): boolean {
  if (typeof text !== 'string' || text === '' || typeof modulePath !== 'string' || modulePath === '') return false
  const e = ext(modulePath)
  const base = basename(modulePath)
  const stem = base.slice(0, base.length - e.length - 1)
  if (stem === '') return false
  if (e === 'py' || e === 'pyi') {
    const s = escapeRe(stem)
    return new RegExp(`^\\s*from\\s+\\S*\\b${s}\\b\\s+import\\b`, 'm').test(text)
      || new RegExp(`^\\s*from\\s+\\S+\\s+import\\s+(?:\\([^)]*\\b${s}\\b|[^\\n#]*\\b${s}\\b)`, 'm').test(text)
      || new RegExp(`^\\s*import\\s+\\S*\\b${s}\\b`, 'm').test(text)
  }
  if (e === 'cs') {
    if (!/\[(?:Fact|Theory|Test|TestMethod|TestCase|TestCaseSource)\b/.test(text)) return false
    return new RegExp(`\\b${escapeRe(stem)}\\b`).test(stripCsharp(text))
  }
  if (!JS_FAMILY.has(e)) return false
  const target = slash(modulePath).replace(JS_EXT, '')
  const dir = slash(dirname(modulePath))
  const parent = basename(dir)
  for (const m of text.matchAll(JS_SPEC)) {
    const spec = (m[1] as string).replace(JS_EXT, '')
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const resolved = normalizeRel(dirname(testPath), spec)
      if (resolved === target || (stem === 'index' && resolved === dir)) return true
      continue
    }
    const segs = spec.split('/')
    const last = segs[segs.length - 1]
    if (segs.length >= 2 && (last === stem || (stem === 'index' && last === parent))) return true
  }
  return false
}

function nameMatches(e: string, stem: string, parentDir: string, names: readonly string[]): boolean {
  if (e === 'go') return names.some(n => /_test\.go$/i.test(n) && squash(n.slice(0, -8)) === squash(stem))
  if (e === 'py' || e === 'pyi') {
    const want = [`test_${stem}.py`, `${stem}_test.py`].map(squash)
    return names.some(n => want.includes(squash(n)))
  }
  if (e === 'cs') {
    const want = [`${stem}tests.cs`, `${stem}test.cs`].map(w => w.toLowerCase())
    return names.some(n => want.includes(n.toLowerCase()))
  }
  const keys = new Set([squash(stem)])
  const parent = kebab(parentDir)
  if (stem === 'index' && parent !== '') keys.add(squash(parent))
  return names.some(n => {
    const m = /^(.*)\.(?:test|spec)\.[cm]?[jt]sx?$/i.exec(n)
    if (m === null) return false
    const t = m[1] as string
    if (keys.has(squash(t))) return true
    return parent !== '' && stem !== 'index' && (kebab(t) === parent || kebab(t).startsWith(`${parent}-${kebab(stem)}`))
  })
}

export function tddHint(path: string, candidates: readonly string[] | TestCandidates, edit?: TddEdit): string | undefined {
  if (typeof path !== 'string' || path === '') return undefined
  const p = slash(path)
  const base = basename(p)
  const e = ext(p)
  const dir = dirname(p)
  if (!TDD_EXT.has(e) || isTestFileName(base) || TEST_DIR.test(dir) || NON_SOURCE_DIR.test(p) || NON_SOURCE_FILE.test(base)) return undefined
  if (e === 'cs' && (DOTNET_BUILD_DIR.test(dir) || DOTNET_TEST_DIR.test(dir))) return undefined
  if (edit !== undefined && edit !== null && (edit.removed !== undefined || edit.added !== undefined) && trivialEdit(edit.removed ?? '', edit.added ?? '')) return undefined
  const c: TestCandidates = Array.isArray(candidates) ? { siblings: candidates } : (candidates as TestCandidates | undefined) ?? { siblings: [] }
  const str = (xs: readonly string[] | undefined): string[] => (Array.isArray(xs) ? xs.filter((s): s is string => typeof s === 'string') : [])
  const stem = base.slice(0, base.length - e.length - 1)
  const parentDir = basename(dir)
  const siblings = str(c.siblings).map(basename)
  if (e === 'go' && siblings.some(s => /_test\.go$/i.test(s))) return undefined
  if (nameMatches(e, stem, parentDir, [...siblings, ...str(c.testFiles).map(basename)])) return undefined
  if (str(c.importers).length > 0) return undefined
  if ((e === 'py' || e === 'pyi') && str(c.failing).some(f => { const b = basename(f).replace(/\.py$/i, ''); return b === `test_${stem}` || b === `${stem}_test` })) return undefined
  if (e === 'cs' && typeof edit?.source === 'string' && dotnetLogicFree(edit.source)) return undefined
  const expected = e === 'go' ? [`${stem}_test.go`]
    : e === 'py' || e === 'pyi' ? [`test_${stem}.py`, `${stem}_test.py`]
      : e === 'cs' ? [`${stem}Tests.cs`, `${stem}Test.cs`]
        : [`${stem}.test.${e}`, `${stem}.spec.${e}`]
  const where = c.testFiles === undefined ? ' next to it' : e === 'go' ? ' next to it and in the test folders' : ' next to it and in the test folders, and for a test that imports it'
  return `No test found for ${base} (looked for ${expected.join(' or ')}${where}). Check whether an existing test covers the behavior; if this edit changes behavior and none does, add or extend a test that fails first, then make it pass. A test file named after the module is not coverage by itself, and a cosmetic or declarative edit needs only a focused check.`
}
