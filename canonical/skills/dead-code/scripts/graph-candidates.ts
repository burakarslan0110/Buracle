#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const USAGE = `graph-candidates.ts: a read-only codegraph snapshot of the symbols nothing in the index reaches,
with the health of the index (never runs codegraph init or sync, never writes).

Usage: bun graph-candidates.ts [options]

  --root <dir>         project root with a codegraph index (default: current directory)
  --scope <path>       only list symbols under this path; repeatable
  --exclude <glob>     skip symbols in files matching this glob (e.g. 'src/gen/**'); repeatable
  --include-exported   also list exported symbols (reachable from outside, so each row says so)
  --include-tests      also list symbols that live in test files
  --limit <n>          max rows to print, 1-1000 (default: 100)
  --sdk <dir>          the node_modules folder that holds @colbymchenry/codegraph (default:
                       $BURACLE_CODEGRAPH_SDK, else \${BURACLE_HOME:-~/.buracle}/toolchain/npm/colbymchenry__codegraph/node_modules)
  --json               print JSON instead of a table
  --help               show this help

Under Bun it re-runs itself with the Node that ships inside the codegraph bundle, because Bun cannot
open a SQLite index read-only before something else has opened it.
The rows are family G evidence (graph): one family, together with codegraph_explore.
Exit: 0 ok, 1 error (bad arguments), 2 finished with warnings or nothing to report
(no SDK, no index, a stale or partial index, or only the raw unreferenced list).`

interface Options {
  root: string
  scopes: string[]
  excludes: string[]
  includeExported: boolean
  includeTests: boolean
  limit: number
  sdk?: string
  json: boolean
}

interface GraphNode {
  name: string
  kind: string
  qualifiedName?: string
  filePath: string
  startLine: number
  endLine?: number
  isExported?: boolean
}

interface GraphHandle {
  close(): void
  getIndexState?(): string | null
  isIndexStale?(): boolean
  getPendingReferenceCount?(): number
  getIndexBuildInfo?(): { version: string | null, extractionVersion: number | null }
  findDeadCode?(kinds?: string[]): GraphNode[]
}

interface ReportEntry { node: GraphNode, members?: GraphNode[], lines?: number, exported?: boolean }

interface DeadCodeReport {
  entries: ReportEntry[]
  total?: number
  candidates?: number
  excluded?: Record<string, number>
  corroborated?: boolean
  bounded?: boolean
}

interface Row {
  name: string
  kind: string
  path: string
  line: number
  lines: number
  members: number
  exported: boolean
  qualifiedName?: string
}

function fail(message: string): never {
  process.stderr.write(`graph-candidates.ts: ${message}\n${USAGE.split('\n')[2]}\n`)
  process.exit(1)
}

function parseArgs(argv: string[]): Options {
  const o: Options = { root: process.cwd(), scopes: [], excludes: [], includeExported: false, includeTests: false, limit: 100, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) fail(`${a} needs a value`)
      return v
    }
    switch (a) {
      case '--help': case '-h': process.stdout.write(`${USAGE}\n`); process.exit(0)
      case '--root': o.root = value(); break
      case '--scope': o.scopes.push(value()); break
      case '--exclude': o.excludes.push(value()); break
      case '--include-exported': o.includeExported = true; break
      case '--include-tests': o.includeTests = true; break
      case '--json': o.json = true; break
      case '--sdk': o.sdk = value(); break
      case '--limit': {
        const n = Number(value())
        if (!Number.isInteger(n) || n < 1 || n > 1000) fail('--limit must be an integer from 1 to 1000')
        o.limit = n
        break
      }
      default: fail(`unknown option ${a}`)
    }
  }
  return o
}

function dataDir(root: string): string {
  const raw = (process.env['CODEGRAPH_DIR'] ?? '').trim()
  if (raw !== '' && raw !== '.' && !raw.includes('..') && !/[\\/]/.test(raw) && !isAbsolute(raw)) return raw
  const wsl = process.platform === 'linux' && ((process.env['WSL_DISTRO_NAME'] ?? '') !== '' || (process.env['WSL_INTEROP'] ?? '') !== '')
  if (wsl && /^\/mnt\/[a-z](?:\/|$)/i.test(root)) {
    try { if (statSync(join(root, '.codegraph-wsl')).isDirectory()) return '.codegraph-wsl' } catch {  }
  }
  return '.codegraph'
}

function sdkDir(o: Options): string {
  if (o.sdk !== undefined) return resolve(o.sdk)
  const env = (process.env['BURACLE_CODEGRAPH_SDK'] ?? '').trim()
  if (env !== '') return resolve(env)
  const home = (process.env['BURACLE_HOME'] ?? '').trim() !== '' ? resolve(process.env['BURACLE_HOME'] as string) : join(process.env['HOME'] ?? homedir(), '.buracle')
  return join(home, 'toolchain', 'npm', 'colbymchenry__codegraph', 'node_modules')
}

function globRe(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++ } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

function rel(root: string, p: string): string {
  const abs = isAbsolute(p) ? p : join(root, p)
  return relative(root, abs).split(sep).join('/')
}

function inScope(path: string, scopes: readonly string[]): boolean {
  if (scopes.length === 0) return true
  return scopes.some(s => path === s || path.startsWith(`${s.replace(/\/+$/, '')}/`))
}

function platformDir(sdk: string): string {
  return join(sdk, '@colbymchenry', `codegraph-${process.platform}-${process.arch}`)
}

function bundledNode(sdk: string): string | undefined {
  const bin = join(platformDir(sdk), process.platform === 'win32' ? 'node.exe' : 'node')
  try { return statSync(bin).isFile() ? bin : undefined } catch { return undefined }
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|fixtures?)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/

function main(): void {
  const o = parseArgs(process.argv.slice(2))
  const root = resolve(o.root)
  if (!existsSync(root)) fail(`--root ${o.root} does not exist`)
  const scopes = o.scopes.map(s => rel(root, resolve(root, s)))
  const excludes = o.excludes.map(globRe)
  const warnings: string[] = []
  const out: Record<string, unknown> = { root, scope: scopes, exclude: o.excludes, includeExported: o.includeExported, includeTests: o.includeTests, limit: o.limit }
  const dir = dataDir(root)
  const db = join(root, dir, 'codegraph.db')
  if (!existsSync(db)) {
    warnings.push(`no codegraph index at ${join(dir, 'codegraph.db')}; run \`buracle index ensure --cwd ${root}\` and try again (this script never builds one)`)
    finish(o, { ...out, index: { present: false }, rows: [], warnings })
    return
  }
  const sdk = sdkDir(o)
  let req: NodeRequire
  let api: { CodeGraph?: { open(root: string, opts: { sync: boolean, readOnly: boolean }): Promise<GraphHandle> } }
  let version: string | undefined
  const pkgDir = join(sdk, '@colbymchenry', 'codegraph')
  try {
    if (!existsSync(join(pkgDir, 'package.json'))) throw new Error(`${join(pkgDir, 'package.json')} does not exist`)
    req = createRequire(join(sdk, 'noop.js'))
    api = req(pkgDir) as typeof api
    try { version = (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version?: string }).version } catch { version = undefined }
  } catch (e) {
    warnings.push(`the codegraph SDK is not available under ${sdk} (${e instanceof Error ? e.message.split('\n')[0] : String(e)}); use codegraph_explore per candidate instead`)
    finish(o, { ...out, index: { present: true }, rows: [], warnings })
    return
  }
  const node = bundledNode(sdk)
  if (node !== undefined && typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' && process.env['BURACLE_GRAPH_CANDIDATES_NODE'] !== '1') {
    const r = spawnSync(node, ['--disable-warning=ExperimentalWarning', process.argv[1] as string, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, BURACLE_GRAPH_CANDIDATES_NODE: '1' } })
    process.exit(r.status ?? 1)
  }
  if (api.CodeGraph === undefined || typeof api.CodeGraph.open !== 'function') {
    warnings.push('the codegraph SDK has no CodeGraph.open; use codegraph_explore per candidate instead')
    finish(o, { ...out, index: { present: true }, rows: [], warnings })
    return
  }
  void run(o, root, req, sdk, api.CodeGraph, version, scopes, excludes, out, warnings)
}

async function run(
  o: Options, root: string, req: NodeRequire, sdk: string, CodeGraph: { open(root: string, opts: { sync: boolean, readOnly: boolean }): Promise<GraphHandle> },
  version: string | undefined, scopes: string[], excludes: RegExp[], out: Record<string, unknown>, warnings: string[],
): Promise<void> {
  let cg: GraphHandle
  try {
    cg = await CodeGraph.open(root, { sync: false, readOnly: true })
  } catch (e) {
    warnings.push(`could not open the codegraph index read-only (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`)
    finish(o, { ...out, index: { present: true }, rows: [], warnings })
    return
  }
  try {
    const state = cg.getIndexState?.() ?? null
    const stale = cg.isIndexStale?.() ?? false
    const pending = cg.getPendingReferenceCount?.() ?? 0
    const built = cg.getIndexBuildInfo?.()
    if (state !== 'complete') warnings.push(`index state is ${state ?? 'unknown'}, not complete: some files or edges may be missing; run \`buracle index ensure --cwd ${root}\``)
    if (stale) warnings.push('the index was built by an older extraction engine; a re-index adds data, so treat missing edges with care')
    if (pending > 0) warnings.push(`${pending} reference(s) were never resolved; call edges are missing until the next sync`)
    let report: DeadCodeReport | undefined
    let source = 'buildDeadCodeReport'
    try {
      const file = join(platformDir(sdk), 'lib', 'dist', 'graph', 'dead-code.js')
      const mod = (existsSync(file) ? req(file) : {}) as { buildDeadCodeReport?: (cg: GraphHandle, q: Record<string, unknown>) => DeadCodeReport }
      if (typeof mod.buildDeadCodeReport === 'function') {
        const r = mod.buildDeadCodeReport(cg, { includeExported: o.includeExported, includeTests: o.includeTests, limit: 20_000 })
        if (Array.isArray(r?.entries)) report = r
      }
    } catch {  }
    if (report === undefined) {
      source = 'findDeadCode'
      warnings.push('buildDeadCodeReport is not available in this codegraph version; these rows are the raw unreferenced list, which is noisy (overrides, registrations, mis-resolved twins): treat each as a lead only')
      const nodes = typeof cg.findDeadCode === 'function' ? cg.findDeadCode() : []
      report = { entries: nodes.filter(n => o.includeTests || !TEST_PATH.test(rel(root, n.filePath))).map(n => ({ node: n })) }
    }
    const rows: Row[] = []
    for (const e of report.entries) {
      const n = e.node
      const path = rel(root, n.filePath)
      if (!inScope(path, scopes) || excludes.some(re => re.test(path))) continue
      const row: Row = {
        name: n.name, kind: n.kind, path, line: n.startLine,
        lines: e.lines ?? Math.max(1, (n.endLine ?? n.startLine) - n.startLine + 1),
        members: e.members?.length ?? 0, exported: e.exported ?? n.isExported === true,
      }
      if (n.qualifiedName !== undefined) row.qualifiedName = n.qualifiedName
      rows.push(row)
    }
    const shown = rows.slice(0, o.limit)
    if (rows.length > shown.length) warnings.push(`${rows.length - shown.length} more row(s) past --limit ${o.limit}`)
    finish(o, {
      ...out,
      sdk: { version: version ?? null, report: source },
      index: { present: true, state, stale, pendingReferences: pending, ...(built !== undefined ? { built } : {}) },
      total: rows.length,
      ...(report.candidates !== undefined ? { candidates: report.candidates } : {}),
      ...(report.excluded !== undefined ? { excluded: report.excluded } : {}),
      ...(report.corroborated !== undefined ? { corroborated: report.corroborated } : {}),
      ...(report.bounded !== undefined ? { bounded: report.bounded } : {}),
      rows: shown,
      warnings,
    })
  } finally {
    try { cg.close() } catch {  }
  }
}

function finish(o: Options, data: Record<string, unknown>): void {
  const warnings = data['warnings'] as string[]
  if (o.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
  else {
    const rows = (data['rows'] as Row[] | undefined) ?? []
    const lines = rows.map(r => `${r.path}:${r.line}  ${r.kind} ${r.name}  ${r.lines} line(s)${r.members > 0 ? `, ${r.members} member(s)` : ''}${r.exported ? '  [exported: reachable from outside]' : ''}`)
    process.stdout.write(`${lines.length > 0 ? lines.join('\n') : 'No unreferenced symbols reported.'}\n`)
    for (const w of warnings) process.stdout.write(`warning: ${w}\n`)
  }
  process.exitCode = warnings.length > 0 ? 2 : 0
}

main()
