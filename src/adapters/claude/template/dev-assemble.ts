import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { loadCanonicalSync } from '../../../engine/canonical'
import { packageVersion, readTemplate, readTree } from '../build'
import { generatePlugin, type GenFile } from '../plugin'

export { TESTED_WITH } from '../constants'

export type AssembledFile = GenFile

function repoRootOf(start: string): string {
  let dir = start
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'canonical', 'buracle.yaml')) && existsSync(join(dir, 'package.json'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return resolve(start, '..', '..', '..', '..')
}

export function assembleFiles(repoRoot: string = repoRootOf(import.meta.dir)): AssembledFile[] {
  return generatePlugin({
    canonical: loadCanonicalSync(join(repoRoot, 'canonical')),
    buracleVersion: packageVersion(repoRoot),
    coreFiles: readTree(join(repoRoot, 'src', 'core'), rel => rel.endsWith('.ts')),
    templateFiles: readTemplate(repoRoot),
  })
}

const ENGINE_OWNED = ['.claude-plugin/types', 'tsconfig.json']

function engineOwned(path: string): boolean {
  return ENGINE_OWNED.some(o => path === o || path.startsWith(`${o}/`))
}

export function writeAssembly(outDir: string, files: readonly AssembledFile[] = assembleFiles()): string[] {
  mkdirSync(outDir, { recursive: true })
  for (const name of readdirSync(outDir)) {
    if (name === '.claude-plugin') {
      for (const inner of readdirSync(join(outDir, name))) if (inner !== 'types') rmSync(join(outDir, name, inner), { recursive: true, force: true })
      continue
    }
    if (!ENGINE_OWNED.includes(name)) rmSync(join(outDir, name), { recursive: true, force: true })
  }
  for (const file of files) {
    const abs = join(outDir, file.path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, file.content)
    if (file.mode !== undefined) chmodSync(abs, file.mode)
  }
  return files.map(f => f.path)
}

export function driftOf(outDir: string, files: readonly AssembledFile[] = assembleFiles()): string[] {
  const want = new Map(files.map(f => [f.path, f.content]))
  const have = existsSync(outDir) ? walkAll(outDir).filter(p => !engineOwned(p)) : []
  const drift: string[] = []
  for (const [path, content] of want) {
    const abs = join(outDir, path)
    if (!existsSync(abs) || readFileSync(abs, 'utf8') !== content) drift.push(path)
  }
  for (const path of have) if (!want.has(path)) drift.push(path)
  return drift.sort()
}

function walkAll(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name)
    const relPath = rel === '' ? name : `${rel}/${name}`
    const st = statSync(abs)
    if (st.isDirectory()) out.push(...walkAll(abs, relPath))
    else if (st.isFile()) out.push(relPath)
  }
  return out
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const outDir = resolve(args.find(a => !a.startsWith('--')) ?? join(tmpdir(), 'buracle-claude-mod'))
  const files = assembleFiles()
  if (check) {
    const drift = driftOf(outDir, files)
    if (drift.length > 0) {
      process.stderr.write(`drift in ${outDir}:\n${drift.map(d => `  ${d}`).join('\n')}\n`)
      process.exit(1)
    }
    process.stdout.write(`${outDir}: up to date (${files.length} files)\n`)
  } else {
    writeAssembly(outDir, files)
    process.stdout.write(`${outDir}\n`)
  }
}
