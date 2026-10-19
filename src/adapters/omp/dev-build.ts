import { chmodSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { loadCanonicalSync } from '../../engine/canonical'
import * as paths from '../../engine/paths'
import type { AdapterContext } from '../registry'
import { buildOmp, type BuildFile } from './build'

export function devContext(repoRoot: string = paths.repoRoot()): AdapterContext {
  const canonical = loadCanonicalSync(join(repoRoot, 'canonical'))
  return { repoRoot, config: canonical.config, canonical, paths, buracleBin: paths.shimPath() }
}

export function listFiles(root: string, rel = ''): string[] {
  let names: string[]
  try { names = readdirSync(join(root, rel)).sort() } catch { return [] }
  const out: string[] = []
  for (const n of names) {
    const r = rel === '' ? n : `${rel}/${n}`
    const st = statSync(join(root, r))
    if (st.isDirectory()) out.push(...listFiles(root, r))
    else if (st.isFile()) out.push(r)
  }
  return out
}

export function diffTree(dir: string, files: BuildFile[]): string[] {
  const want = new Set(files.map(f => f.path))
  const problems: string[] = []
  for (const f of files) {
    let have: string | undefined
    try { have = readFileSync(join(dir, f.path), 'utf8') } catch { have = undefined }
    if (have === undefined) problems.push(`missing ${f.path}`)
    else if (have !== f.content) problems.push(`changed ${f.path}`)
  }
  for (const p of listFiles(dir)) if (!want.has(p)) problems.push(`stale ${p}`)
  return problems
}

function pruneEmptyDirs(dir: string, isRoot = true): void {
  let names: string[]
  try { names = readdirSync(dir) } catch { return }
  for (const n of names) {
    const abs = join(dir, n)
    if (statSync(abs).isDirectory()) pruneEmptyDirs(abs, false)
  }
  if (!isRoot && readdirSync(dir).length === 0) rmdirSync(dir)
}

export function writeTree(dir: string, files: BuildFile[]): void {
  const want = new Set(files.map(f => f.path))
  for (const p of listFiles(dir)) if (!want.has(p)) rmSync(join(dir, p))
  for (const f of files) {
    const abs = join(dir, f.path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, f.content)
    chmodSync(abs, f.mode ?? 0o644)
  }
  pruneEmptyDirs(dir)
}

if (import.meta.main) {
  const repoRoot = paths.repoRoot()
  const files = await buildOmp(devContext(repoRoot))
  const out = paths.harnessDir('omp')
  if (process.argv.includes('--check')) {
    const problems = diffTree(out, files)
    if (problems.length > 0) {
      process.stderr.write(`harness/omp is out of date:\n- ${problems.join('\n- ')}\n`)
      process.exit(1)
    }
    process.stdout.write(`harness/omp is up to date (${files.length} files)\n`)
  } else {
    writeTree(out, files)
    process.stdout.write(`wrote ${files.length} files to ${relative(repoRoot, out) || '.'}\n`)
  }
}
