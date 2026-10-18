#!/usr/bin/env bun

import { existsSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

type Lang = 'ts' | 'js' | 'py' | 'go'
type Mode = 'exports' | 'files' | 'all'
type Category = 'code' | 'test' | 'doc' | 'config'
type Hint = 'unreferenced' | 'test-only' | 'docs-config-only' | 'local-only'

interface Options {
  root: string
  scopes: string[]
  excludes: string[]
  langs: Lang[]
  mode: Mode
  includeTests: boolean
  limit: number
  json: boolean
}

interface Definition {
  kind: 'export' | 'file'
  name: string
  path: string
  line: number
  lang: Lang
  notes: string[]
}

interface Refs {
  code: number
  test: number
  doc: number
  config: number
  self: number | null
}

interface Candidate extends Definition {
  hint: Hint
  refs: Refs
}

interface DynamicHint {
  id: string
  meaning: string
  count: number
  samples: string[]
}

const USAGE = `candidates.ts: list files and exports that no other file mentions (read-only).

Usage: bun candidates.ts [options]

  --root <dir>      project root to scan (default: current directory)
  --scope <path>    only list definitions under this path; repeatable.
                    References are always counted across the whole root.
  --exclude <glob>  skip definitions in files matching this glob (e.g. 'src/gen/**');
                    repeatable. References are still counted everywhere.
  --lang <list>     comma list of ts,js,py,go (default: all four)
  --mode <mode>     exports | files | all (default: all). Go supports exports only.
  --include-tests   also list definitions that live in test files
  --limit <n>       max candidates to print, 1-1000 (default: 100)
  --json            print JSON instead of a table
  --help            show this help

Hints: unreferenced (no mention anywhere) > test-only > docs-config-only > local-only
(used inside its own file; at most the export is unnecessary).
Exit: 0 ok, 1 error, 2 finished with warnings.`

const ALL_LANGS: readonly Lang[] = ['ts', 'js', 'py', 'go']
const EXTENSIONS: Record<Lang, readonly string[]> = {
  ts: ['.ts', '.tsx', '.mts', '.cts'],
  js: ['.js', '.jsx', '.mjs', '.cjs'],
  py: ['.py'],
  go: ['.go'],
}
const MAX_FILE_BYTES = 1_000_000
const MIN_NAME_LENGTH = 3
const HINT_ORDER: Record<Hint, number> = { unreferenced: 0, 'test-only': 1, 'docs-config-only': 2, 'local-only': 3 }

const TEST_DIR = /(^|\/)(__tests__|__mocks__|tests?|specs?|e2e|fixtures?|testdata)\//
const TEST_FILE = /(\.(test|spec|stories)\.[cm]?[jt]sx?$)|(_test\.go$)|((^|\/)test_[^/]*\.py$)|(_test\.py$)|((^|\/)conftest\.py$)/
const DOC_FILE = /\.(md|mdx|markdown|rst|adoc|txt)$/
const DOC_DIR = /(^|\/)docs?\//
const CONFIG_FILE = /\.(json|jsonc|json5|ya?ml|toml|ini|cfg|conf|properties|xml|lock|gradle|env)$/
const CONFIG_NAMES = new Set(['dockerfile', 'makefile', 'justfile', 'procfile', 'containerfile', 'caddyfile', '.env'])
const CONFIG_DIR = /(^|\/)(\.github|\.gitlab|\.circleci|\.buildkite|\.husky)\//

const SKIP_DEFINITION_DIR =
  /(^|\/)(node_modules|bower_components|vendor|third_party|dist|build|out|coverage|target|__generated__|generated|\.next|\.nuxt|\.svelte-kit|\.venv|venv|site-packages|migrations?)\//
const SKIP_DEFINITION_FILE =
  /(\.d\.[cm]?ts$)|(\.min\.[cm]?js$)|(\.generated\.)|(_pb2(_grpc)?\.py$)|(\.pb(\.gw)?\.go$)|(_gen\.go$)|(\.gen\.[cm]?[jt]sx?$)/
const HIDDEN_SEGMENT = /(^|\/)\.[^/]+\//
const CONVENTION_FILE =
  /((^|\/)(setup|conftest|manage|wsgi|asgi|__main__|noxfile|fabfile)\.py$)|(\.config\.[cm]?[jt]s$)|((^|\/)(middleware|instrumentation)\.[cm]?[jt]s$)/
const INDEX_STEMS = new Set(['index', '__init__', 'mod', 'main', '__main__'])
const SOURCE_ROOTS = new Set(['src', 'lib', 'app', 'source', 'sources', 'pkg', 'server', 'client', 'cmd'])

const JS_DECL =
  /^\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/
const JS_DEFAULT = /^\s*export\s+default\b/
const JS_LIST_START = /^\s*export\s*(?:type\s*)?\{/
const JS_CJS = /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/
const PY_DEF = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/
const PY_CLASS = /^class\s+([A-Za-z_]\w*)\b/
const GO_FUNC = /^func\s+([A-Za-z_]\w*)\s*[[(]/
const GO_TYPE = /^type\s+([A-Za-z_]\w*)\b/
const GO_VALUE = /^(?:var|const)\s+([A-Za-z_]\w*)\b/
const GO_TEST_FUNC = /^(Test|Benchmark|Example|Fuzz)/

const DYNAMIC_RULES: ReadonlyArray<{ id: string; langs: readonly Lang[]; pattern: string; meaning: string }> = [
  { id: 'js-dynamic-import', langs: ['ts', 'js'], pattern: String.raw`\bimport\(\s*[^'"\s)]`, meaning: 'import() with a computed specifier' },
  { id: 'js-dynamic-require', langs: ['ts', 'js'], pattern: String.raw`\brequire\(\s*[^'"\s)]`, meaning: 'require() with a computed specifier' },
  { id: 'js-require-context', langs: ['ts', 'js'], pattern: String.raw`\brequire\.context\(|import\.meta\.glob`, meaning: 'bundler glob import' },
  { id: 'py-dynamic-import', langs: ['py'], pattern: String.raw`\bimportlib\.import_module\(|\b__import__\(`, meaning: 'module imported by name' },
  { id: 'py-getattr', langs: ['py'], pattern: String.raw`\bgetattr\(\s*[^,()]+,\s*[^'"\s]`, meaning: 'attribute looked up by a computed name' },
  { id: 'go-reflect', langs: ['go'], pattern: String.raw`\breflect\.|\bplugin\.Open\(`, meaning: 'reflection or plugin loading' },
]

class UsageError extends Error {}

function parseArgs(argv: string[]): Options | 'help' {
  const opts: Options = {
    root: process.cwd(),
    scopes: [],
    excludes: [],
    langs: [...ALL_LANGS],
    mode: 'all',
    includeTests: false,
    limit: 100,
    json: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    const value = (): string => {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${arg} needs a value`)
      i++
      return next
    }
    switch (arg) {
      case '--root':
        opts.root = value()
        break
      case '--scope':
        opts.scopes.push(value())
        break
      case '--exclude':
        opts.excludes.push(value())
        break
      case '--lang': {
        const langs = value().split(',').map((s) => s.trim()).filter(Boolean)
        const bad = langs.filter((l) => !ALL_LANGS.includes(l as Lang))
        if (bad.length > 0 || langs.length === 0) throw new UsageError(`--lang accepts ts,js,py,go (got: ${bad.join(',') || 'nothing'})`)
        opts.langs = langs as Lang[]
        break
      }
      case '--mode': {
        const mode = value()
        if (mode !== 'exports' && mode !== 'files' && mode !== 'all') throw new UsageError('--mode accepts exports, files or all')
        opts.mode = mode
        break
      }
      case '--include-tests':
        opts.includeTests = true
        break
      case '--limit': {
        const n = Number(value())
        if (!Number.isInteger(n) || n < 1 || n > 1000) throw new UsageError('--limit must be an integer from 1 to 1000')
        opts.limit = n
        break
      }
      case '--json':
        opts.json = true
        break
      case '--help':
      case '-h':
        return 'help'
      default:
        throw new UsageError(`unknown option: ${arg}`)
    }
  }
  return opts
}

function toPosix(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '')
}

function toRelative(root: string, input: string): string {
  const abs = isAbsolute(input) ? input : resolve(root, input)
  const rel = toPosix(relative(root, abs))
  if (rel.startsWith('..') || isAbsolute(rel)) throw new UsageError(`--scope is outside the root: ${input}`)
  return rel.replace(/\/+$/, '')
}

const categoryCache = new Map<string, Category>()
function categorize(path: string): Category {
  const cached = categoryCache.get(path)
  if (cached) return cached
  const p = path.toLowerCase()
  const base = p.slice(p.lastIndexOf('/') + 1)
  let category: Category = 'code'
  if (TEST_DIR.test(p) || TEST_FILE.test(p)) category = 'test'
  else if (DOC_FILE.test(base) || DOC_DIR.test(p)) category = 'doc'
  else if (CONFIG_FILE.test(base) || CONFIG_NAMES.has(base) || base.startsWith('.env') || CONFIG_DIR.test(p)) category = 'config'
  categoryCache.set(path, category)
  return category
}

function langOf(path: string, langs: readonly Lang[]): Lang | undefined {
  const ext = extname(path).toLowerCase()
  return langs.find((l) => EXTENSIONS[l].includes(ext))
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function run(argv: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

const RG_BASE = ['rg', '--no-config', '--hidden', '--glob', '!.git', '--glob', '!**/.git/**', '--glob', '!**/node_modules/**']

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''
}

async function listFiles(root: string, warnings: string[]): Promise<string[]> {
  const r = await run([...RG_BASE, '--files'], root)
  if (r.code === 2) warnings.push(`rg --files reported errors: ${firstLine(r.stderr)}`)
  else if (r.code !== 0 && r.code !== 1) throw new Error(`rg --files failed (${r.code}): ${firstLine(r.stderr)}`)
  return r.stdout.split('\n').filter(Boolean).map(toPosix).sort()
}

function definitionAllowed(path: string, opts: Options, scopes: string[], globs: Bun.Glob[]): boolean {
  if (scopes.length > 0 && !scopes.some((s) => s === '' || path === s || path.startsWith(`${s}/`))) return false
  if (HIDDEN_SEGMENT.test(path) || SKIP_DEFINITION_DIR.test(path) || SKIP_DEFINITION_FILE.test(path)) return false
  if (globs.some((g) => g.match(path))) return false
  const category = categorize(path)
  return category === 'code' || (category === 'test' && opts.includeTests)
}

interface Collector {
  defs: Definition[]
  sites: Set<string>
}

function addExport(c: Collector, name: string, path: string, line: number, lang: Lang, notes: string[] = []): void {
  if (name.length < MIN_NAME_LENGTH) return
  c.defs.push({ kind: 'export', name, path, line, lang, notes })
  c.sites.add(`${name}\0${path}\0${line}`)
}

function extractJs(c: Collector, path: string, lang: Lang, lines: string[]): void {
  const fileNotes: string[] = lines.some((l) => JS_DEFAULT.test(l)) ? ['file-has-default-export'] : []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const decl = JS_DECL.exec(line)
    if (decl?.[1]) {
      addExport(c, decl[1], path, i + 1, lang, [...fileNotes])
      continue
    }
    const cjs = JS_CJS.exec(line)
    if (cjs?.[1]) {
      addExport(c, cjs[1], path, i + 1, lang, ['commonjs', ...fileNotes])
      continue
    }
    if (!JS_LIST_START.test(line)) continue
    const start = i
    let buffer = line
    while (!buffer.includes('}') && i + 1 < lines.length) {
      i++
      buffer += ` ${lines[i] ?? ''}`
    }
    const close = buffer.indexOf('}')
    if (close < 0 || /^\s*from\s/.test(buffer.slice(close + 1))) continue
    const inner = buffer.slice(buffer.indexOf('{') + 1, close)
    for (const raw of inner.split(',')) {
      const item = raw.trim().replace(/^type\s+/, '')
      if (!item) continue
      const [local = '', exported = local] = item.split(/\s+as\s+/).map((s) => s.trim())
      if (!exported || exported === 'default') continue
      const notes = local === exported ? [...fileNotes] : ['renamed-export', ...fileNotes]
      addExport(c, exported, path, start + 1, lang, notes)
      for (let k = start + 1; k <= i; k++) c.sites.add(`${exported}\0${path}\0${k + 1}`)
      if (local === exported) {
        const declLine = new RegExp(
          `^\\s*(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\s*\\*?|class|const|let|var|interface|type|enum|namespace)\\s+${escapeRegExp(local)}\\b`,
        )
        const at = lines.findIndex((l) => declLine.test(l))
        if (at >= 0) c.sites.add(`${exported}\0${path}\0${at + 1}`)
      }
    }
  }
}

function previousCodeLine(lines: string[], index: number): string {
  for (let k = index - 1; k >= 0; k--) {
    const l = (lines[k] ?? '').trim()
    if (l) return l
  }
  return ''
}

function extractPy(c: Collector, path: string, lines: string[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const m = PY_DEF.exec(line) ?? PY_CLASS.exec(line)
    const name = m?.[1]
    if (!name || name.startsWith('_') || name === 'main') continue
    const notes = previousCodeLine(lines, i).startsWith('@') ? ['decorated'] : []
    addExport(c, name, path, i + 1, 'py', notes)
  }
}

function extractGo(c: Collector, path: string, lines: string[]): void {
  const isTest = path.endsWith('_test.go')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const m = GO_FUNC.exec(line) ?? GO_TYPE.exec(line) ?? GO_VALUE.exec(line)
    const name = m?.[1]
    if (!name || name === '_' || name === 'main' || name === 'init') continue
    if (isTest && GO_TEST_FUNC.test(name)) continue
    const notes: string[] = []
    if (/^[A-Z]/.test(name)) notes.push('exported-identifier')
    const cgo = previousCodeLine(lines, i) === `//export ${name}`
    if (cgo) notes.push('cgo-export')
    addExport(c, name, path, i + 1, 'go', notes)
    if (cgo) {
      for (let k = i - 1; k >= 0; k--) {
        if ((lines[k] ?? '').trim() === `//export ${name}`) {
          c.sites.add(`${name}\0${path}\0${k + 1}`)
          break
        }
      }
    }
  }
}

function fileDefinition(path: string, lang: Lang): Definition | undefined {
  if (lang === 'go' || CONVENTION_FILE.test(path)) return undefined
  const base = basename(path)
  let stem = base.slice(0, base.length - extname(base).length)
  const notes: string[] = []
  if (INDEX_STEMS.has(stem)) {
    const dir = dirname(path)
    if (dir === '.' || dir === '' || SOURCE_ROOTS.has(basename(dir))) return undefined
    stem = basename(dir)
    notes.push('index-module')
  }
  if (stem.length < MIN_NAME_LENGTH) return undefined
  return { kind: 'file', name: stem, path, line: 0, lang, notes }
}

async function countMentions(root: string, names: string[], sites: Set<string>, warnings: string[]): Promise<Map<string, Map<string, number>>> {
  const counts = new Map<string, Map<string, number>>()
  if (names.length === 0) return counts
  const patterns = [...names].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
  const proc = Bun.spawn(
    [
      ...RG_BASE,
      '--fixed-strings',
      '--word-regexp',
      '--only-matching',
      '--line-number',
      '--with-filename',
      '--null',
      '--no-heading',
      '--color',
      'never',
      '--max-filesize',
      '2M',
      '--file',
      '-',
      '.',
    ],
    { cwd: root, stdin: new TextEncoder().encode(`${patterns.join('\n')}\n`), stdout: 'pipe', stderr: 'pipe' },
  )
  const stderrText = new Response(proc.stderr).text()
  const handle = (row: string): void => {
    const nul = row.indexOf('\0')
    if (nul < 0) return
    const path = toPosix(row.slice(0, nul))
    const tail = row.slice(nul + 1)
    const colon = tail.indexOf(':')
    if (colon < 0) return
    const name = tail.slice(colon + 1)
    if (sites.has(`${name}\0${path}\0${tail.slice(0, colon)}`)) return
    let byPath = counts.get(name)
    if (!byPath) {
      byPath = new Map()
      counts.set(name, byPath)
    }
    byPath.set(path, (byPath.get(path) ?? 0) + 1)
  }
  const decoder = new TextDecoder()
  let rest = ''
  for await (const chunk of proc.stdout) {
    rest += decoder.decode(chunk, { stream: true })
    const rows = rest.split('\n')
    rest = rows.pop() ?? ''
    for (const row of rows) handle(row)
  }
  rest += decoder.decode()
  if (rest) handle(rest)
  const code = await proc.exited
  if (code === 2) warnings.push(`rg reported errors while counting references: ${firstLine(await stderrText)}`)
  else if (code !== 0 && code !== 1) throw new Error(`rg failed while counting references (${code}): ${firstLine(await stderrText)}`)
  return counts
}

function tally(def: Definition, byPath: Map<string, number> | undefined): Refs {
  const refs: Refs = { code: 0, test: 0, doc: 0, config: 0, self: def.kind === 'export' ? 0 : null }
  if (!byPath) return refs
  for (const [path, n] of byPath) {
    if (path === def.path) {
      if (refs.self !== null) refs.self += n
      continue
    }
    refs[categorize(path)] += n
  }
  return refs
}

function hintOf(refs: Refs): Hint {
  const self = refs.self ?? 0
  if (self > 0) return 'local-only'
  if (refs.test > 0) return 'test-only'
  if (refs.doc + refs.config > 0) return 'docs-config-only'
  return 'unreferenced'
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    HINT_ORDER[a.hint] - HINT_ORDER[b.hint] ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
    a.line - b.line ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
    (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
  )
}

async function dynamicHints(root: string, langs: readonly Lang[], warnings: string[]): Promise<DynamicHint[]> {
  const out: DynamicHint[] = []
  for (const rule of DYNAMIC_RULES) {
    const ruleLangs = rule.langs.filter((l) => langs.includes(l))
    if (ruleLangs.length === 0) continue
    const argv = [...RG_BASE, '--line-number', '--with-filename', '--null', '--no-heading', '--color', 'never', '--max-filesize', '2M']
    for (const ext of ruleLangs.flatMap((l) => EXTENSIONS[l])) argv.push('--glob', `*${ext}`)
    argv.push('--regexp', rule.pattern, '.')
    const r = await run(argv, root)
    if (r.code === 2) warnings.push(`rg reported errors for dynamic-usage rule ${rule.id}: ${firstLine(r.stderr)}`)
    const rows = r.stdout.split('\n').filter(Boolean).sort()
    if (rows.length === 0) continue
    const samples = rows.slice(0, 3).map((row) => {
      const nul = row.indexOf('\0')
      return `${toPosix(row.slice(0, nul))}:${row.slice(nul + 1).split(':')[0] ?? ''}`
    })
    out.push({ id: rule.id, meaning: rule.meaning, count: rows.length, samples })
  }
  return out
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

function renderText(report: {
  root: string
  rg: string
  scanned: { files: number; exports: number; files_as_modules: number }
  candidates: Candidate[]
  total: number
  dynamicHints: DynamicHint[]
  warnings: string[]
}): string {
  const out: string[] = []
  out.push(
    `candidates: ${report.candidates.length} shown of ${report.total} · root ${report.root} · scanned ${report.scanned.files} files, ` +
      `${report.scanned.exports} exports, ${report.scanned.files_as_modules} modules · ${report.rg}`,
  )
  if (report.candidates.length > 0) {
    const rows = report.candidates.map((c) => {
      const r = c.refs
      return [
        c.hint,
        c.kind,
        `${r.code}/${r.test}/${r.doc}/${r.config}/${r.self === null ? '-' : r.self}`,
        c.kind === 'file' ? c.path : `${c.path}:${c.line}`,
        c.name + (c.notes.length > 0 ? `  [${c.notes.join(', ')}]` : ''),
      ]
    })
    const header = ['hint', 'kind', 'refs c/t/d/k/s', 'location', 'name']
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? '').length)))
    const line = (cells: string[]): string =>
      cells.map((cell, i) => (i === cells.length - 1 ? cell : pad(cell, widths[i] ?? 0))).join('  ')
    out.push(line(header))
    for (const row of rows) out.push(line(row))
    out.push('refs: c=code t=test d=doc k=config s=same-file mentions (definition lines excluded)')
  }
  if (report.total > report.candidates.length) {
    out.push(`(${report.total - report.candidates.length} more not shown; raise --limit or narrow --scope)`)
  }
  if (report.dynamicHints.length > 0) {
    out.push('dynamic-usage hints (resolve these before calling anything removable):')
    for (const h of report.dynamicHints) out.push(`  ${h.id} (${h.meaning}): ${h.count} · ${h.samples.join(', ')}`)
  }
  if (report.warnings.length > 0) {
    out.push('warnings:')
    for (const w of report.warnings) out.push(`  - ${w}`)
  }
  out.push('These are candidates from text search only; check each against an independent signal.')
  return out.join('\n')
}

async function main(argv: string[]): Promise<number> {
  let opts: Options
  try {
    const parsed = parseArgs(argv)
    if (parsed === 'help') {
      console.log(USAGE)
      return 0
    }
    opts = parsed
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`candidates: ${err.message}\n\n${USAGE}`)
      return 1
    }
    throw err
  }
  if (!Bun.which('rg')) {
    console.error('candidates: ripgrep (rg) must be on PATH (macOS: brew install ripgrep).')
    return 1
  }
  const root = resolve(opts.root)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`candidates: --root is not a directory: ${root}`)
    return 1
  }
  let scopes: string[]
  try {
    scopes = opts.scopes.map((s) => toRelative(root, s))
  } catch (err) {
    console.error(`candidates: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  const globs = opts.excludes.map((g) => new Bun.Glob(g))
  const warnings: string[] = []
  const rgVersion = firstLine((await run(['rg', '--version'], root)).stdout) || 'rg'

  const files = await listFiles(root, warnings)
  const collector: Collector = { defs: [], sites: new Set() }
  let scannedFiles = 0
  for (const path of files) {
    const lang = langOf(path, opts.langs)
    if (!lang || !definitionAllowed(path, opts, scopes, globs)) continue
    const file = Bun.file(join(root, path))
    if (file.size > MAX_FILE_BYTES) {
      warnings.push(`not scanned for definitions (over 1 MB): ${path}`)
      continue
    }
    let text: string
    try {
      text = await file.text()
    } catch {
      warnings.push(`unreadable: ${path}`)
      continue
    }
    scannedFiles++
    if (opts.mode !== 'files') {
      const lines = text.split(/\r?\n/)
      if (lang === 'ts' || lang === 'js') extractJs(collector, path, lang, lines)
      else if (lang === 'py') extractPy(collector, path, lines)
      else extractGo(collector, path, lines)
    }
    if (opts.mode !== 'exports') {
      const def = fileDefinition(path, lang)
      if (def) collector.defs.push(def)
    }
  }

  const names = [...new Set(collector.defs.map((d) => d.name))]
  const mentions = await countMentions(root, names, collector.sites, warnings)
  const candidates: Candidate[] = []
  for (const def of collector.defs) {
    const refs = tally(def, mentions.get(def.name))
    if (refs.code > 0) continue
    candidates.push({ ...def, refs, hint: hintOf(refs) })
  }
  candidates.sort(compareCandidates)
  const shown = candidates.slice(0, opts.limit)
  const hints = await dynamicHints(root, opts.langs, warnings)
  const scanned = {
    files: scannedFiles,
    exports: collector.defs.filter((d) => d.kind === 'export').length,
    files_as_modules: collector.defs.filter((d) => d.kind === 'file').length,
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          version: 1,
          root,
          rg: rgVersion,
          scanned,
          total: candidates.length,
          truncated: candidates.length - shown.length,
          candidates: shown,
          dynamicHints: hints,
          warnings,
        },
        null,
        2,
      ),
    )
  } else {
    console.log(renderText({ root, rg: rgVersion, scanned, candidates: shown, total: candidates.length, dynamicHints: hints, warnings }))
  }
  return warnings.length > 0 ? 2 : 0
}

main(Bun.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`candidates: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  },
)
