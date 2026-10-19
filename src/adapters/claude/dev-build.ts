import { lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadCanonicalSync } from '../../engine/canonical'
import { loadConfigSync } from '../../engine/config'
import { atomicWriteSync } from '../../engine/fsx'
import * as paths from '../../engine/paths'
import type { AdapterContext } from '../registry'
import { buildClaude } from './build'
import { HARNESS_REL } from './constants'
import type { GenFile } from './plugin'

function preserved(rel: string): boolean {
  return rel.startsWith('.claude-plugin/types/') || rel === 'tsconfig.json' || rel.split('/').includes('node_modules') || rel.endsWith('.DS_Store')
}

function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (abs: string, rel: string) => {
    let names: string[]
    try { names = readdirSync(abs).sort() } catch { return }
    for (const n of names) {
      const a = join(abs, n)
      const r = rel === '' ? n : `${rel}/${n}`
      const st = lstatSync(a)
      if (st.isDirectory()) walk(a, r)
      else out.push(r)
    }
  }
  walk(dir, '')
  return out
}

function removeEmptyDirs(dir: string, isRoot = true): boolean {
  let names: string[]
  try { names = readdirSync(dir) } catch { return false }
  let empty = true
  for (const n of names) {
    const a = join(dir, n)
    if (lstatSync(a).isDirectory()) { if (!removeEmptyDirs(a, false)) empty = false } else empty = false
  }
  if (empty && !isRoot) { rmdirSync(dir); return true }
  return empty
}

export interface SyncReport { written: string[]; removed: string[]; unchanged: number }

export function syncTree(outDir: string, files: readonly GenFile[], opts: { check?: boolean, keepsModes?: boolean } = {}): SyncReport {
  const report: SyncReport = { written: [], removed: [], unchanged: 0 }
  // Windows keeps no POSIX mode (a file reads back as 0o666), so there only the content counts.
  const keepsModes = opts.keepsModes ?? process.platform !== 'win32'
  const want = new Map(files.map(f => [f.path, f]))
  for (const f of files) {
    const abs = join(outDir, f.path)
    const mode = f.mode ?? 0o644
    let same = false
    try {
      const st = statSync(abs)
      same = st.isFile() && (!keepsModes || (st.mode & 0o777) === mode) && readFileSync(abs, 'utf8') === f.content
    } catch { same = false }
    if (same) { report.unchanged++; continue }
    report.written.push(f.path)
    if (!opts.check) atomicWriteSync(abs, f.content, { mode })
  }
  for (const rel of listFiles(outDir)) {
    if (want.has(rel) || preserved(rel)) continue
    report.removed.push(rel)
    if (!opts.check) unlinkSync(join(outDir, rel))
  }
  if (!opts.check) removeEmptyDirs(outDir)
  return report
}

export function devContext(repoRoot: string = paths.repoRoot()): AdapterContext {
  return {
    repoRoot,
    config: loadConfigSync({ repoRoot }).config,
    canonical: loadCanonicalSync(join(repoRoot, 'canonical')),
    paths,
    buracleBin: paths.shimPath(),
  }
}

async function main(argv: string[]): Promise<number> {
  const check = argv.includes('--check')
  const outIdx = argv.indexOf('--out')
  const repoRoot = paths.repoRoot()
  const outDir = outIdx >= 0 && argv[outIdx + 1] !== undefined ? resolve(argv[outIdx + 1] as string) : join(repoRoot, HARNESS_REL)
  const files = await buildClaude(devContext(repoRoot))
  if (!check) mkdirSync(outDir, { recursive: true })
  const r = syncTree(outDir, files, { check })
  const verb = check ? 'would write' : 'wrote'
  for (const p of r.written) process.stderr.write(`${verb} ${p}\n`)
  for (const p of r.removed) process.stderr.write(`${check ? 'would remove' : 'removed'} ${p}\n`)
  process.stderr.write(`harness/claude: ${files.length} files, ${r.written.length} ${verb}, ${r.removed.length} stale, ${r.unchanged} unchanged\n`)
  return check && (r.written.length > 0 || r.removed.length > 0) ? 1 : 0
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => process.exit(code), (e: unknown) => {
    process.stderr.write(`dev-build failed: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  })
}
