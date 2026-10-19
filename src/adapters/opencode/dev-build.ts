import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { AdapterContext } from '../registry'
import { loadCanonicalSync } from '../../engine/canonical'
import { atomicWriteSync } from '../../engine/fsx'
import * as paths from '../../engine/paths'
import { buildFiles, type BuiltFile } from './build'

export function devContext(repoRoot: string = paths.repoRoot()): AdapterContext {
  const canonical = loadCanonicalSync(join(repoRoot, 'canonical'))
  return { repoRoot, config: canonical.config, canonical, paths, buracleBin: paths.shimPath() }
}

function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    let names: string[]
    try { names = readdirSync(d) } catch { return }
    for (const n of names.sort()) {
      const p = join(d, n)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) walk(p)
      else out.push(relative(dir, p).split('\\').join('/'))
    }
  }
  walk(dir)
  return out
}

export function diffTree(files: BuiltFile[], dir: string): { changed: string[], extra: string[] } {
  const changed: string[] = []
  for (const f of files) {
    let cur: string | undefined
    try { cur = readFileSync(join(dir, f.path), 'utf8') } catch { cur = undefined }
    if (cur !== f.content) changed.push(f.path)
  }
  const want = new Set(files.map(f => f.path))
  const extra = listFiles(dir).filter(p => !want.has(p))
  return { changed, extra }
}

export function writeTree(files: BuiltFile[], dir: string): { written: string[], removed: string[] } {
  const { changed, extra } = diffTree(files, dir)
  for (const f of files) if (changed.includes(f.path)) atomicWriteSync(join(dir, f.path), f.content, { mode: f.mode ?? 0o644 })
  for (const p of extra) rmSync(join(dir, p), { force: true })
  return { written: changed, removed: extra }
}

if (import.meta.main) {
  const check = process.argv.includes('--check')
  const ctx = devContext()
  const files = await buildFiles(ctx)
  const dir = paths.harnessDir('opencode')
  if (check) {
    const d = diffTree(files, dir)
    if (d.changed.length + d.extra.length > 0) {
      process.stderr.write(`harness/opencode is stale:\n${[...d.changed.map(p => `  changed ${p}`), ...d.extra.map(p => `  extra   ${p}`)].join('\n')}\n`)
      process.exit(1)
    }
    process.stdout.write(`harness/opencode is up to date (${files.length} files)\n`)
  } else {
    const r = writeTree(files, dir)
    process.stdout.write(`harness/opencode: ${files.length} files, ${r.written.length} written, ${r.removed.length} removed\n`)
  }
}
