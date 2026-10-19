import { lstatSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import * as nodePath from 'node:path'
import { dirname, isAbsolute, join, posix } from 'node:path'
import type { Adapter, AdapterContext } from '../../adapters/registry'
import type { CanonicalBundle } from '../../core/catalog'
import type { Harness } from '../../core/events'
import { knownExecutableBit } from '../exec-bit'
import { atomicWriteSync, readTextSync, realPath, sha256 } from '../fsx'
import * as paths from '../paths'
import { buildContext, inCheckout, loadBundle } from './context'
import { errText, isInside } from './output'
import { loadCommandInfos, referenceDocs, type CommandInfo } from './reference'

export const MANIFEST_REL = 'harness/.manifest.json'
export const DOCS_PRODUCER = 'docs'

export interface GeneratedFile { path: string; content: string; exec: boolean; by: string }
export interface ManifestEntry { by: string; sha256: string; exec: boolean }
export interface BuildManifest { v: 1; files: Record<string, ManifestEntry> }

export type DriftKind = 'changed' | 'missing' | 'stale' | 'mode' | 'manifest'
export interface DriftEntry { path: string; kind: DriftKind; by?: string }

export interface BuildOptions {
  repoRoot: string
  check: boolean
  harnesses?: readonly Harness[]
  adapters: readonly Adapter[]
  docs?: boolean
  commands?: { commands: CommandInfo[], exitCodes: Record<string, number> }
  canonical?: CanonicalBundle
  sharedSkills?: SharedSkillsBuilder | false
  hookData?: HookDataBuilder | false
}

export type SharedSkillsBuilder = (ctx: AdapterContext) => Array<{ path: string, content: string, mode?: number }> | Promise<Array<{ path: string, content: string, mode?: number }>>
export type HookDataBuilder = (canonical: CanonicalBundle) => { path: string, content: string } | Promise<{ path: string, content: string }>

export const AGENTS_SKILLS_PRODUCER = 'agents-skills'
export const HOOK_DATA_PRODUCER = 'hook-data'
const SHARED_SKILL_CONSUMERS: readonly Harness[] = ['codex', 'opencode', 'omp']

async function defaultSharedSkills(ctx: AdapterContext): Promise<Array<{ path: string, content: string, mode?: number }>> {
  const mod = await import('../../adapters/shared/skills')
  return mod.buildAgentsSkills(ctx)
}

async function defaultHookData(canonical: CanonicalBundle): Promise<{ path: string, content: string }> {
  const mod = await import('../../cli/hook-data')
  return { path: mod.HOOK_DATA_REL, content: mod.renderHookData(canonical) }
}

function fileEntry(f: unknown, rel: string, by: string): GeneratedFile {
  const rec = f as Record<string, unknown>
  const mode = rec['mode']
  if (mode !== undefined && (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o7777)) throw new Error(`${rel}: invalid mode`)
  return { path: rel, content: rec['content'] as string, exec: typeof mode === 'number' && (mode & 0o111) !== 0, by }
}

export interface BuildReport {
  ok: boolean
  check: boolean
  producers: string[]
  generated: number
  written: string[]
  removed: string[]
  unchanged: number
  drift: DriftEntry[]
  errors: Array<{ source: string, error: string }>
  warnings: string[]
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

// An absolute path is native (on Windows C:\repo\.claude-plugin\x.json); a path inside the output tree uses '/' only.
export function normalizeOutputPath(raw: unknown, h: Harness, repoRoot: string, native: typeof posix = nodePath): { rel: string } | { error: string } {
  const absolute = typeof raw === 'string' && native.isAbsolute(raw)
  if (typeof raw !== 'string' || raw.trim() === '' || raw.includes('\0') || (raw.includes('\\') && !(absolute && native.sep === '\\'))) return { error: `invalid path ${JSON.stringify(raw)}` }
  let rel: string
  if (absolute) {
    const r = native.relative(repoRoot, raw)
    if (r === '' || r.startsWith('..') || native.isAbsolute(r)) return { error: `${raw} is outside the repository` }
    rel = r.split(native.sep).join('/')
  } else {
    rel = raw.startsWith('harness/') ? raw : `harness/${h}/${raw}`
  }
  rel = posix.normalize(rel)
  if (rel === '.' || rel === '..' || rel.startsWith('../') || rel.startsWith('/') || rel.endsWith('/')) return { error: `${raw}: escapes the output tree` }
  if (rel === MANIFEST_REL) return { error: `${raw}: reserved for the build manifest` }
  const allowed = rel.startsWith(`harness/${h}/`) || rel.startsWith('harness/agents-skills/') || (h === 'claude' && absolute && rel === '.claude-plugin/marketplace.json')
  if (!allowed) return { error: `${raw}: adapter ${h} may only write under harness/${h}/ or harness/agents-skills/` }
  return { rel }
}

function parseManifest(text: string): BuildManifest | undefined {
  let v: unknown
  try { v = JSON.parse(text) } catch { return undefined }
  if (!isRecord(v) || v['v'] !== 1 || !isRecord(v['files'])) return undefined
  const files: Record<string, ManifestEntry> = {}
  for (const [p, e] of Object.entries(v['files'])) {
    if (!isRecord(e) || typeof e['by'] !== 'string' || typeof e['sha256'] !== 'string') return undefined
    files[p] = { by: e['by'], sha256: e['sha256'], exec: e['exec'] === true }
  }
  return { v: 1, files }
}

export function renderManifest(m: BuildManifest): string {
  const files: Record<string, ManifestEntry> = {}
  for (const p of Object.keys(m.files).sort()) {
    const e = m.files[p] as ManifestEntry
    files[p] = { by: e.by, sha256: e.sha256, exec: e.exec }
  }
  return JSON.stringify({ v: 1, generator: 'buracle build', files }, null, 2) + '\n'
}

function safeManifestPath(p: string): boolean {
  if (p === '' || isAbsolute(p) || p.includes('\\') || p.includes('\0') || p.split('/').includes('..')) return false
  return p.startsWith('harness/') || p.startsWith('docs/reference/') || p === '.claude-plugin/marketplace.json'
}

// exec is undefined where the file system keeps no bit and the git index does not track the file (Windows).
interface DiskState { exists: boolean; content?: string; exec?: boolean; symlink?: boolean }

const sameExec = (d: DiskState, f: GeneratedFile): boolean => d.exec === undefined || d.exec === f.exec

function readDisk(abs: string): DiskState {
  let st
  try { st = lstatSync(abs) } catch { return { exists: false } }
  if (st.isSymbolicLink()) return { exists: true, symlink: true }
  if (!st.isFile()) return { exists: true }
  const exec = knownExecutableBit(abs, st.mode)
  return exec === undefined ? { exists: true, content: readFileSync(abs, 'utf8') } : { exists: true, content: readFileSync(abs, 'utf8'), exec }
}

function assertInsideRepo(abs: string, repoReal: string): void {
  let d = dirname(abs)
  for (;;) {
    try {
      const real = realPath(d)
      if (!isInside(real, repoReal)) throw new Error(`${abs}: parent directory resolves outside the repository (${real})`)
      return
    } catch (e) {
      if ((e as { code?: string }).code !== 'ENOENT') throw e
    }
    const up = dirname(d)
    if (up === d) return
    d = up
  }
}

function writeGenerated(abs: string, f: GeneratedFile, repoReal: string): void {
  assertInsideRepo(abs, repoReal)
  let st
  try { st = lstatSync(abs) } catch { st = undefined }
  if (st?.isDirectory()) throw new Error(`${abs} is a directory`)
  if (st?.isSymbolicLink()) unlinkSync(abs)
  atomicWriteSync(abs, f.content, { mode: f.exec ? 0o755 : 0o644 })
}

function removeEmptyDirs(start: string, stopAt: string): void {
  let d = start
  while (isInside(d, stopAt) && d !== stopAt) {
    try {
      if (readdirSync(d).length > 0) return
      rmdirSync(d)
    } catch { return }
    d = dirname(d)
  }
}

function machinePaths(repoRoot: string): RegExp[] {
  const out = new Set<string>()
  const home = paths.home()
  if (home.length > 1) out.add(home)
  out.add(repoRoot)
  try { out.add(realPath(repoRoot)) } catch {  }
  // A Windows path may also appear with '/' or JSON-escaped (two backslashes), and a backslash may follow it.
  for (const p of [...out]) if (p.includes('\\')) { out.add(p.replace(/\\/g, '/')); out.add(p.replace(/\\/g, '\\\\')) }
  return [...out].filter(p => p.length > 1).map(p => new RegExp(`(?<![\\w.-])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[/\\\\"'\\s:;,)\\]}]|$)`, 'm'))
}

export async function runBuild(opts: BuildOptions): Promise<BuildReport> {
  const report: BuildReport = { ok: false, check: opts.check, producers: [], generated: 0, written: [], removed: [], unchanged: 0, drift: [], errors: [], warnings: [] }
  const repoRoot = opts.repoRoot
  let canonical = opts.canonical
  if (!canonical) {
    const loaded = loadBundle(repoRoot)
    if (!('bundle' in loaded)) {
      report.errors.push({ source: 'canonical', error: loaded.error })
      return report
    }
    canonical = loaded.bundle
  }
  for (const w of canonical.warnings) report.warnings.push(w)
  const ctx = buildContext(repoRoot, canonical)
  const scope = opts.adapters.filter(a => opts.harnesses === undefined || opts.harnesses.includes(a.harness))
  const byProducer = new Map<string, GeneratedFile[]>()
  const failed = new Set<string>()
  const bundle = canonical
  await inCheckout(repoRoot, async () => {
    if (opts.hookData !== false) {
      try {
        const f: unknown = await (opts.hookData ?? defaultHookData)(bundle)
        if (!isRecord(f) || typeof f['content'] !== 'string' || typeof f['path'] !== 'string') throw new Error('the snapshot generator returned an invalid entry')
        const raw = f['path']
        if (raw !== posix.normalize(raw) || !/^harness\/[^/\\\0]+$/.test(raw) || raw === MANIFEST_REL) throw new Error(`${raw}: the hooks' snapshot must be a file directly under harness/`)
        byProducer.set(HOOK_DATA_PRODUCER, [fileEntry(f, raw, HOOK_DATA_PRODUCER)])
      } catch (e) {
        failed.add(HOOK_DATA_PRODUCER)
        report.errors.push({ source: HOOK_DATA_PRODUCER, error: errText(e) })
      }
    }

    for (const a of scope) {
      const files: GeneratedFile[] = []
      try {
        const out = await a.build(ctx)
        if (!Array.isArray(out)) throw new Error('build() did not return an array')
        for (const f of out) {
          if (!isRecord(f) || typeof f['content'] !== 'string') throw new Error(`build() returned an invalid entry for ${JSON.stringify(isRecord(f) ? f['path'] : f)}`)
          const norm = normalizeOutputPath(f['path'], a.harness, repoRoot)
          if ('error' in norm) throw new Error(norm.error)
          files.push(fileEntry(f, norm.rel, a.harness))
        }
        byProducer.set(a.harness, files)
      } catch (e) {
        failed.add(a.harness)
        report.errors.push({ source: a.harness, error: errText(e) })
      }
    }

    const wantsShared = opts.harnesses === undefined || opts.harnesses.some(h => SHARED_SKILL_CONSUMERS.includes(h))
    if (wantsShared && opts.sharedSkills !== false) {
      try {
        const out = await (opts.sharedSkills ?? defaultSharedSkills)(ctx)
        if (!Array.isArray(out)) throw new Error('the shared skills render did not return an array')
        const files: GeneratedFile[] = []
        for (const f of out) {
          if (!isRecord(f) || typeof f['content'] !== 'string' || typeof f['path'] !== 'string') throw new Error(`invalid shared skill entry ${JSON.stringify(isRecord(f) ? f['path'] : f)}`)
          const rel = posix.normalize(`harness/agents-skills/${f['path']}`)
          if (isAbsolute(f['path']) || f['path'].includes('\\') || !rel.startsWith('harness/agents-skills/')) throw new Error(`${f['path']}: escapes harness/agents-skills/`)
          files.push(fileEntry(f, rel, AGENTS_SKILLS_PRODUCER))
        }
        byProducer.set(AGENTS_SKILLS_PRODUCER, files)
      } catch (e) {
        failed.add(AGENTS_SKILLS_PRODUCER)
        report.errors.push({ source: AGENTS_SKILLS_PRODUCER, error: errText(e) })
      }
    }

    if (opts.docs !== false && !opts.check) {
      try {
        const reg = opts.commands ?? await loadCommandInfos()
        const docs = referenceDocs({ canonical: bundle, commands: reg.commands, exitCodes: reg.exitCodes })
        byProducer.set(DOCS_PRODUCER, docs.map(d => ({ path: d.path, content: d.content, exec: false, by: DOCS_PRODUCER })))
      } catch (e) {
        failed.add(DOCS_PRODUCER)
        report.errors.push({ source: DOCS_PRODUCER, error: errText(e) })
      }
    }
  })

  const needles = machinePaths(repoRoot)
  for (const [by, files] of byProducer) {
    const bad = files.find(f => needles.some(n => n.test(f.content)))
    if (bad) {
      byProducer.delete(by)
      failed.add(by)
      report.errors.push({ source: by, error: `${bad.path} contains a machine-specific absolute path; use \${HOME}, $HOME or {env:HOME} forms (CONTRACTS §8)` })
    }
  }
  const all = new Map<string, GeneratedFile>()
  for (const [by, files] of [...byProducer.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const f of files) {
      const prev = all.get(f.path)
      if (!prev) { all.set(f.path, f); continue }
      if (prev.content === f.content && prev.exec === f.exec) continue
      report.errors.push({ source: by, error: `${f.path} is also generated by ${prev.by} with different content` })
      failed.add(by)
      failed.add(prev.by)
    }
  }
  for (const by of failed) byProducer.delete(by)
  const fresh = new Map<string, GeneratedFile>()
  for (const [, files] of byProducer) for (const f of files) fresh.set(f.path, f)
  report.producers = [...byProducer.keys()].sort()
  report.generated = fresh.size

  const manifestAbs = join(repoRoot, MANIFEST_REL)
  const manifestText = readTextSync(manifestAbs)
  let old: BuildManifest = { v: 1, files: {} }
  if (manifestText.ok) {
    const parsed = parseManifest(manifestText.value)
    if (parsed) old = parsed
    else report.warnings.push(`${MANIFEST_REL} is unreadable; stale generated files cannot be detected this time`)
  }
  const ran = new Set(report.producers)
  const next: BuildManifest = { v: 1, files: {} }
  for (const [p, e] of Object.entries(old.files)) if (!ran.has(e.by) && safeManifestPath(p)) next.files[p] = e
  for (const f of fresh.values()) if (f.by !== DOCS_PRODUCER) next.files[f.path] = { by: f.by, sha256: sha256(f.content), exec: f.exec }
  const stale = Object.entries(old.files).filter(([p, e]) => ran.has(e.by) && !fresh.has(p) && safeManifestPath(p)).map(([p]) => p).sort()
  const nextText = renderManifest(next)

  const repoReal = (() => { try { return realPath(repoRoot) } catch { return repoRoot } })()
  const ordered = [...fresh.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
  if (opts.check) {
    for (const f of ordered) {
      const d = readDisk(join(repoRoot, f.path))
      if (!d.exists) report.drift.push({ path: f.path, kind: 'missing', by: f.by })
      else if (d.content === undefined || d.content !== f.content) report.drift.push({ path: f.path, kind: 'changed', by: f.by })
      else if (!sameExec(d, f)) report.drift.push({ path: f.path, kind: 'mode', by: f.by })
      else report.unchanged++
    }
    for (const p of stale) if (readDisk(join(repoRoot, p)).exists) report.drift.push({ path: p, kind: 'stale', by: old.files[p]?.by })
    if (!manifestText.ok || manifestText.value !== nextText) report.drift.push({ path: MANIFEST_REL, kind: 'manifest' })
  } else {
    for (const f of ordered) {
      const abs = join(repoRoot, f.path)
      const d = readDisk(abs)
      if (d.exists && d.content === f.content && sameExec(d, f)) { report.unchanged++; continue }
      try {
        writeGenerated(abs, f, repoReal)
        report.written.push(f.path)
      } catch (e) {
        report.errors.push({ source: f.by, error: `${f.path}: ${errText(e)}` })
      }
    }
    for (const p of stale) {
      const abs = join(repoRoot, p)
      try {
        assertInsideRepo(abs, repoReal)
        const st = lstatSync(abs)
        if (st.isDirectory()) { report.warnings.push(`${p}: is a directory now; not removed`); continue }
        unlinkSync(abs)
        report.removed.push(p)
        const top = p.startsWith('harness/') ? join(repoRoot, 'harness') : p.startsWith('docs/reference/') ? join(repoRoot, 'docs', 'reference') : repoRoot
        removeEmptyDirs(dirname(abs), top)
      } catch (e) {
        if ((e as { code?: string }).code !== 'ENOENT') report.errors.push({ source: old.files[p]?.by ?? 'build', error: `${p}: ${errText(e)}` })
      }
    }
    if (!manifestText.ok || manifestText.value !== nextText) {
      try { atomicWriteSync(manifestAbs, nextText, { mode: 0o644 }) } catch (e) { report.errors.push({ source: 'manifest', error: errText(e) }) }
    }
  }
  report.ok = report.errors.length === 0 && report.drift.length === 0
  return report
}

export function hasManifest(repoRoot: string): boolean {
  try { return statSync(join(repoRoot, MANIFEST_REL)).isFile() } catch { return false }
}
