import { existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const rootOf = new Map<string, string | null>()
interface IndexModes { executables: ReadonlySet<string>, tracked: ReadonlySet<string> }

const modesOf = new Map<string, IndexModes | null>()

function gitRoot(dir: string): string | undefined {
  const known = rootOf.get(dir)
  if (known !== undefined) return known ?? undefined
  let found: string | null = null
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) { found = d; break }
    if (dirname(d) === d) break
  }
  rootOf.set(dir, found)
  return found ?? undefined
}

function indexModes(root: string): IndexModes | undefined {
  const known = modesOf.get(root)
  if (known !== undefined) return known ?? undefined
  let modes: IndexModes | null = null
  try {
    const r = Bun.spawnSync(['git', '-C', root, 'ls-files', '--stage', '-z'], { env: { ...process.env }, stdout: 'pipe', stderr: 'ignore' })
    if (r.exitCode === 0) {
      const executables = new Set<string>()
      const tracked = new Set<string>()
      for (const entry of r.stdout.toString().split('\0')) {
        const tab = entry.indexOf('\t')
        if (tab <= 0) continue
        tracked.add(entry.slice(tab + 1))
        if (entry.startsWith('100755 ')) executables.add(entry.slice(tab + 1))
      }
      modes = { executables, tracked }
    }
  } catch {  }
  modesOf.set(root, modes)
  return modes ?? undefined
}

// Windows keeps no executable bit on disk; the git index holds the one the repository records.
export function executableBit(abs: string, fsMode: number, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return (fsMode & 0o111) !== 0
  const root = gitRoot(dirname(abs))
  const modes = root === undefined ? undefined : indexModes(root)
  if (root === undefined || modes === undefined) return (fsMode & 0o111) !== 0
  return modes.executables.has(relative(root, abs).replace(/\\/g, '/'))
}

// undefined where nothing records the bit: on Windows, a file the git index does not track.
export function knownExecutableBit(abs: string, fsMode: number, platform: NodeJS.Platform = process.platform): boolean | undefined {
  if (platform !== 'win32') return (fsMode & 0o111) !== 0
  const root = gitRoot(dirname(abs))
  const modes = root === undefined ? undefined : indexModes(root)
  const rel = root === undefined ? undefined : relative(root, abs).replace(/\\/g, '/')
  if (modes === undefined || rel === undefined || !modes.tracked.has(rel)) return undefined
  return modes.executables.has(rel)
}

export function fileMode(abs: string, fsMode: number, platform: NodeJS.Platform = process.platform): number {
  if (platform !== 'win32') return fsMode & 0o777
  return executableBit(abs, fsMode, platform) ? 0o755 : 0o644
}
