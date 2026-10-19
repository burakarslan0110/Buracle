import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { BuracleConfig } from '../../core/config'
import type { CheckerFacts, CheckerPlan, DirScan, TddEdit, TestCandidates } from '../../core/checkers'
import { CHECKER_PROBES, TEST_DIR_NAMES, checkerDirs, checkerFacts, checkerTool, importsModule, isDotnetTestProjectName, isTestFileName, missingToolKey, missingToolNote, skippedNote } from '../../core/checkers'
import * as paths from '../../engine/paths'
import { findExecutable, isWindows, spawnArgv } from '../../engine/platform'

export interface CheckFs {
  list(dir: string): Array<{ name: string, dir: boolean }>
  read(path: string, maxBytes: number): string | undefined
  exists(path: string): boolean
}

export const nodeCheckFs: CheckFs = {
  list: dir => {
    try { return readdirSync(dir, { withFileTypes: true }).map(d => ({ name: d.name, dir: d.isDirectory() })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) } catch { return [] }
  },
  read: (path, maxBytes) => {
    try {
      const st = statSync(path)
      return st.isFile() && st.size <= maxBytes ? readFileSync(path, 'utf8') : undefined
    } catch { return undefined }
  },
  exists: path => { try { statSync(path); return true } catch { return false } },
}

const MANIFEST_MAX_BYTES = 512_000
const SOURCE_MAX_BYTES = 4_000_000
export const TEST_SCAN_MAX_ENTRIES = 2000
export const TEST_SCAN_MAX_MS = 150
const IMPORTER_MAX_FILES = 200
const IMPORTER_MAX_BYTES = 256_000
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'bin', 'obj', '.venv', 'venv', '__pycache__', 'coverage', '.next', '.turbo', 'target', 'vendor', 'fixtures', '__fixtures__', 'snapshots', '__snapshots__'])
const SOURCE_ROOTS = new Set(['src', 'lib', 'app', 'pkg', 'internal', 'source'])

const WINDOWS_PROBE = /\.(?:exe|cmd)$/i

export function scanUpward(fs: CheckFs, file: string, root: string | undefined, home?: string, windows: boolean = isWindows()): DirScan[] {
  const probes = CHECKER_PROBES.filter(p => windows || !WINDOWS_PROBE.test(p))
  return checkerDirs(file, root, home).map(dir => {
    const names = fs.list(dir).map(e => e.name)
    const scan: DirScan = { dir, names }
    if (names.includes('pyproject.toml')) { const t = fs.read(join(dir, 'pyproject.toml'), MANIFEST_MAX_BYTES); if (t !== undefined) scan.pyproject = t }
    if (names.includes('package.json')) { const t = fs.read(join(dir, 'package.json'), MANIFEST_MAX_BYTES); if (t !== undefined) scan.packageJson = t }
    const present = probes.filter(p => names.includes(p.split('/')[0] as string) && fs.exists(join(dir, ...p.split('/'))))
    if (present.length > 0) scan.present = present
    return scan
  })
}

function extOf(p: string): string {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase()
}

const FAMILY: Readonly<Record<string, string>> = { py: 'py', pyi: 'py', go: 'go', cs: 'cs', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js' }

function mirrorDirs(file: string, testDir: string, owner: string): string[] {
  const rel = relative(owner, dirname(file))
  if (rel === '' || rel.startsWith('..')) return []
  const segs = rel.split(sep)
  const stem = basename(file).replace(/\.[^.]+$/, '')
  const out = [join(testDir, ...segs), join(testDir, ...segs, stem)]
  if (segs.length > 0 && SOURCE_ROOTS.has(segs[0] as string)) out.push(join(testDir, ...segs.slice(1)), join(testDir, ...segs.slice(1), stem))
  return out
}

export function testFilesNear(fs: CheckFs, file: string, scans: readonly DirScan[], now: () => number): string[] {
  const family = FAMILY[extOf(file)]
  if (family === undefined) return []
  const deadline = now() + TEST_SCAN_MAX_MS
  const roots: string[] = []
  const queue: string[] = []
  for (const s of scans) {
    for (const n of s.names) {
      if (n === basename(dirname(file)) && join(s.dir, n) === dirname(file)) continue
      if (TEST_DIR_NAMES.includes(n) || (family === 'cs' && isDotnetTestProjectName(n))) {
        const t = join(s.dir, n)
        if (roots.includes(t)) continue
        roots.push(t)
        queue.push(...mirrorDirs(file, t, s.dir))
      }
    }
  }
  queue.push(...roots)
  const seen = new Set<string>()
  const found: string[] = []
  let visited = 0
  while (queue.length > 0 && visited < TEST_SCAN_MAX_ENTRIES && now() < deadline) {
    const d = queue.shift() as string
    if (seen.has(d)) continue
    seen.add(d)
    for (const e of fs.list(d)) {
      visited++
      if (e.dir) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) queue.push(join(d, e.name)); continue }
      const p = join(d, e.name)
      if (FAMILY[extOf(e.name)] !== family || found.includes(p)) continue
      if (isTestFileName(e.name) || family === 'cs') found.push(p)
    }
  }
  return found
}

export function importersOf(fs: CheckFs, file: string, testFiles: readonly string[], now: () => number, imports: typeof importsModule = importsModule): string[] {
  const deadline = now() + TEST_SCAN_MAX_MS
  let read = 0
  for (const t of testFiles) {
    if (read >= IMPORTER_MAX_FILES || now() >= deadline) break
    const text = fs.read(t, IMPORTER_MAX_BYTES)
    read++
    if (text !== undefined && imports(text, t, file)) return [t]
  }
  return []
}

export function lastFailed(fs: CheckFs, scans: readonly DirScan[]): string[] {
  for (const s of scans) {
    if (!s.names.includes('.pytest_cache')) continue
    const text = fs.read(join(s.dir, '.pytest_cache', 'v', 'cache', 'lastfailed'), MANIFEST_MAX_BYTES)
    if (text === undefined) continue
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
      return [...new Set(Object.keys(parsed).map(k => k.split('::')[0] as string).filter(k => k !== ''))]
    } catch { return [] }
  }
  return []
}

export interface CheckerApi {
  checkersFor(path: string, facts: CheckerFacts, cfg: BuracleConfig['checkers']): CheckerPlan[]
  findingsOf(plan: CheckerPlan, result: { code: number, stdout: string, stderr: string } | null): string | undefined
  tddHint(path: string, candidates: readonly string[] | TestCandidates, edit?: TddEdit): string | undefined
  charsetFindings(addedText: string, path: string, fileText?: string): string[]
  lengthNote(lineCount: number): string | undefined
  checkerFacts?: typeof checkerFacts
  missingToolNote?: typeof missingToolNote
  importsModule?: typeof importsModule
}

export interface CheckerResult { code: number, stdout: string, stderr: string, timedOut?: boolean }

export interface FileCheckEnv {
  api: CheckerApi
  fs: CheckFs
  now(): number
  run(plan: CheckerPlan, timeoutMs: number): Promise<CheckerResult | null>
  resolve?(argv: readonly string[]): string[]
  once?(key: string): boolean
  guard<T>(what: string, fallback: T, fn: () => T | Promise<T>): Promise<T>
}

export function checkerArgv(argv: readonly string[], find: (name: string) => string | undefined = name => findExecutable(name, { extra: paths.toolchainBinDirs() })): string[] {
  const [cmd, ...rest] = argv
  if (cmd === undefined || cmd === '') return [...argv]
  const resolved = /[\\/]/.test(cmd) ? cmd : find(cmd) ?? cmd
  return spawnArgv([resolved, ...rest])
}

export interface FileCheckTarget {
  file: string
  cwd: string
  root?: string
  home?: string
  added?: string
  removed?: string
  deadlineMs: number
}

export type FileNoteKind = 'finding' | 'missing' | 'skipped' | 'tdd' | 'charset' | 'length'
export interface FileNote { kind: FileNoteKind, text: string }

export function removedByFile(edits: ReadonlyArray<{ path: string, removed: string }>, files: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of files) {
    const norm = f.replace(/\\/g, '/')
    const hit = edits.find(e => {
      const p = e.path.replace(/\\/g, '/').replace(/^\.\//, '')
      return p !== '' && (norm === p || norm.endsWith(`/${p}`))
    })
    if (hit !== undefined && hit.removed !== '') out[f] = hit.removed
  }
  return out
}

export function lineCountOf(text: string): number {
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

const TDD_IMPORTERS = new Set(['py', 'js', 'cs'])

async function tddNote(env: FileCheckEnv, t: FileCheckTarget, scans: readonly DirScan[], source: string | undefined): Promise<string | undefined> {
  const { api, fs, guard } = env
  const edit: TddEdit = {}
  if (t.removed !== undefined) edit.removed = t.removed
  if (t.added !== undefined) edit.added = t.added
  if (source !== undefined && extOf(t.file) === 'cs') edit.source = source
  const first = scans[0]
  const siblings = first !== undefined && first.dir === dirname(t.file) ? [...first.names] : fs.list(dirname(t.file)).map(e => e.name)
  const quick = await guard('tddHint', undefined as string | undefined, () => api.tddHint(t.file, { siblings }, edit))
  if (quick === undefined) return undefined
  const testFiles = await guard('test files', [] as string[], () => testFilesNear(fs, t.file, scans, env.now))
  const named = await guard('tddHint', undefined as string | undefined, () => api.tddHint(t.file, { siblings, testFiles }, edit))
  if (named === undefined || !TDD_IMPORTERS.has(FAMILY[extOf(t.file)] ?? '')) return named
  const importers = await guard('test importers', [] as string[], () => importersOf(fs, t.file, testFiles, env.now, api.importsModule ?? importsModule))
  const failing = FAMILY[extOf(t.file)] === 'py' ? await guard('pytest lastfailed', [] as string[], () => lastFailed(fs, scans)) : []
  if (importers.length === 0 && failing.length === 0) return named
  return guard('tddHint', named as string | undefined, () => api.tddHint(t.file, { siblings, testFiles, importers, failing }, edit))
}

export async function checkOneFile(env: FileCheckEnv, t: FileCheckTarget, cfg: BuracleConfig['checkers']): Promise<FileNote[]> {
  const { api, fs, guard } = env
  const notes: FileNote[] = []
  const source = fs.read(t.file, SOURCE_MAX_BYTES)
  const scans = await guard('project scan', [] as DirScan[], () => scanUpward(fs, t.file, t.root, t.home))
  const facts = await guard('checker facts', { hasRuffConfig: false, hasEslintConfig: false, isGoModule: false, cwd: t.cwd } as CheckerFacts, () => (api.checkerFacts ?? checkerFacts)(scans, t.cwd))
  const plans = await guard('checkersFor', [] as CheckerPlan[], () => api.checkersFor(t.file, facts, cfg))
  const named = new Set<string>()
  for (const plan of plans) {
    const left = t.deadlineMs - env.now()
    if (left < Math.max(500, plan.minMs ?? 0)) { notes.push({ kind: 'skipped', text: skippedNote(plan) }); continue }
    const argv = await guard('checker path', plan.argv, () => (env.resolve ?? checkerArgv)(plan.argv))
    const res = await guard('checker', null as CheckerResult | null, () => env.run({ ...plan, argv }, Math.min(plan.timeoutMs, left - 250)))
    if (res !== null && res.code === 127 && res.stdout === '') {
      const key = missingToolKey(plan)
      if (named.has(key)) continue
      named.add(key)
      if (env.once === undefined || env.once(key)) {
        const text = await guard('missingToolNote', undefined as string | undefined, () => (api.missingToolNote ?? missingToolNote)(plan))
        if (text !== undefined) notes.push({ kind: 'missing', text })
      }
      continue
    }
    if (res !== null && res.timedOut === true) {
      notes.push({ kind: 'skipped', text: `${checkerTool(plan)} did not finish within ${Math.max(1, Math.round(Math.min(plan.timeoutMs, left - 250) / 1000))} s; run it yourself if this change needs it` })
      continue
    }
    const finding = await guard('findingsOf', undefined as string | undefined, () => api.findingsOf(plan, res === null ? null : { code: res.code, stdout: res.stdout, stderr: res.stderr }))
    if (finding) notes.push({ kind: 'finding', text: finding })
  }
  const tdd = await guard('tddHint', undefined as string | undefined, () => tddNote(env, t, scans, source))
  if (tdd) notes.push({ kind: 'tdd', text: tdd })
  if (t.added !== undefined && t.added !== '') {
    const added = t.added
    for (const text of await guard('charsetFindings', [] as string[], () => api.charsetFindings(added, t.file, source))) notes.push({ kind: 'charset', text })
  }
  if (source !== undefined) {
    const ln = await guard('lengthNote', undefined as string | undefined, () => api.lengthNote(lineCountOf(source)))
    if (ln) notes.push({ kind: 'length', text: ln })
  }
  return notes
}
