import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BuracleConfig } from '../../core/config'
import type { CheckerFacts, CheckerPlan, DirScan } from '../../core/checkers'
import { CHECKER_PROBES, checkerDirs, checkerFacts, checkerTool, missingToolKey, missingToolNote, skippedNote } from '../../core/checkers'
import * as paths from '../../engine/paths'
import { findExecutable } from '../../engine/platform'

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

export function scanUpward(fs: CheckFs, file: string, root: string | undefined, home?: string): DirScan[] {
  return checkerDirs(file, root, home).map(dir => {
    const names = fs.list(dir).map(e => e.name)
    const scan: DirScan = { dir, names }
    if (names.includes('pyproject.toml')) { const t = fs.read(join(dir, 'pyproject.toml'), MANIFEST_MAX_BYTES); if (t !== undefined) scan.pyproject = t }
    if (names.includes('package.json')) { const t = fs.read(join(dir, 'package.json'), MANIFEST_MAX_BYTES); if (t !== undefined) scan.packageJson = t }
    const present = CHECKER_PROBES.filter(p => names.includes(p.split('/')[0] as string) && fs.exists(join(dir, ...p.split('/'))))
    if (present.length > 0) scan.present = present
    return scan
  })
}

export interface CheckerApi {
  checkersFor(path: string, facts: CheckerFacts, cfg: BuracleConfig['checkers']): CheckerPlan[]
  findingsOf(plan: CheckerPlan, result: { code: number, stdout: string, stderr: string } | null): string | undefined
  checkerFacts?: typeof checkerFacts
  missingToolNote?: typeof missingToolNote
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
  return [resolved, ...rest]
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

export type FileNoteKind = 'finding' | 'missing' | 'skipped'
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

export async function checkOneFile(env: FileCheckEnv, t: FileCheckTarget, cfg: BuracleConfig['checkers']): Promise<FileNote[]> {
  const { api, fs, guard } = env
  const notes: FileNote[] = []
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
  return notes
}
