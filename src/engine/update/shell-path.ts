import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import { atomicWriteSync, readJsonSafeSync } from '../fsx'
import * as paths from '../paths'

// The `buracle` command lives in ~/.local/bin. When PATH lacks that folder, the install adds one marked block to the
// startup file of the user's shell, once, and records which file; `buracle uninstall` takes the same block out again.
// Windows is left to scripts/install.ps1, which puts the folder on the user PATH.

const START = '# >>> buracle >>>'
const END = '# <<< buracle <<<'

export type ShellPathSkip = 'on-path' | 'in-file' | 'unsafe' | 'windows' | 'error'
export interface ShellPathResult { changed: boolean, file?: string, skipped?: ShellPathSkip, reason?: string }

interface ShellPathRecord { v: 1, file: string }

/**
 * The startup file an interactive shell of this user reads: zsh honours ZDOTDIR. Bash on macOS opens login shells, which
 * read only the first of ~/.bash_profile, ~/.bash_login and ~/.profile that exists, so the block goes into that one; a new
 * ~/.bash_profile is made only when none exists (making one beside a ~/.profile would stop bash from reading it).
 */
export function startupFile(env: Readonly<Record<string, string | undefined>>, os: string, home: string): string {
  const shell = basename(env['SHELL'] ?? '')
  if (shell === 'zsh') return join(env['ZDOTDIR'] !== undefined && env['ZDOTDIR'] !== '' ? env['ZDOTDIR'] : home, '.zshrc')
  if (shell === 'bash' && os === 'darwin') return ['.bash_profile', '.bash_login', '.profile'].map(f => join(home, f)).find(f => existsSync(f)) ?? join(home, '.bash_profile')
  if (shell === 'bash') return join(home, '.bashrc')
  if (shell === 'fish') return join(home, '.config', 'fish', 'config.fish')
  return join(home, '.profile')
}

function blockFor(file: string): string {
  const line = file.endsWith('.fish') ? 'fish_add_path "$HOME/.local/bin"' : 'export PATH="$HOME/.local/bin:$PATH"'
  return `${START}\n${line}\n${END}\n`
}

function onPath(dir: string, PATH: string | undefined): boolean {
  return (PATH ?? '').split(delimiter).some(d => d !== '' && resolve(d) === dir)
}

/** A line that already puts ~/.local/bin on PATH (an export, a fish_add_path or a set -x PATH). */
const ALREADY = /^\s*(?:export\s+PATH=|PATH=|fish_add_path\b|set\s+(?:-\S+\s+)*PATH\b).*(?:\$HOME|~|\$\{HOME\})\/\.local\/bin/m

function inside(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The file to write, following a link only when it ends inside the home folder. */
function writeTarget(file: string, home: string): { path: string } | { unsafe: string } {
  let st
  try { st = lstatSync(file) } catch { return { path: file } }
  if (!st.isSymbolicLink()) return { path: file }
  let real: string
  try { real = realpathSync(file) } catch { return { unsafe: `${file} is a broken symbolic link` } }
  let homeReal = home
  try { homeReal = realpathSync(home) } catch {  }
  if (!inside(homeReal, real)) return { unsafe: `${file} links to ${real}, outside your home folder` }
  return { path: real }
}

export function addLocalBinToPath(opts: { env?: Readonly<Record<string, string | undefined>>, os?: string, home?: string } = {}): ShellPathResult {
  const env = opts.env ?? process.env
  const os = opts.os ?? process.platform
  if (os === 'win32') return { changed: false, skipped: 'windows' }
  const home = opts.home ?? paths.home()
  const localBin = join(home, '.local', 'bin')
  if (onPath(localBin, env['PATH'])) return { changed: false, skipped: 'on-path' }
  const file = startupFile(env, os, home)
  let homeReal = home
  try { homeReal = realpathSync(home) } catch {  }
  // ZDOTDIR may name any folder; Buracle writes only inside the home folder.
  if (!inside(home, file) && !inside(homeReal, file)) return { changed: false, file, skipped: 'unsafe', reason: `${file} is outside your home folder` }
  const target = writeTarget(file, home)
  if ('unsafe' in target) return { changed: false, file, skipped: 'unsafe', reason: target.unsafe }
  const remember = (): void => atomicWriteSync(paths.shellPathStateFile(), JSON.stringify({ v: 1, file } satisfies ShellPathRecord, null, 2) + '\n')
  try {
    const text = existsSync(target.path) ? readFileSync(target.path, 'utf8') : ''
    if (text.includes(START)) {
      // Buracle's own block: its record may be gone (a wiped ~/.buracle), and uninstall needs it to find the block.
      if (!existsSync(paths.shellPathStateFile())) remember()
      return { changed: false, file, skipped: 'in-file' }
    }
    if (ALREADY.test(text)) return { changed: false, file, skipped: 'in-file' }
    // The record first: a block written without one could never be taken out again.
    remember()
    const sep = text === '' || text.endsWith('\n') ? '' : '\n'
    atomicWriteSync(target.path, `${text}${sep}${blockFor(file)}`)
    return { changed: true, file }
  } catch (e) {
    return { changed: false, file, skipped: 'error', reason: `cannot write ${file}: ${(e as Error).message}` }
  }
}

/** Takes the block the install added out of the recorded file: only a whole start-to-end block, nothing else. */
export function removeLocalBinFromPath(): { removed: boolean, file?: string, note?: string } {
  const r = readJsonSafeSync<ShellPathRecord>(paths.shellPathStateFile())
  if (!r.ok || r.value === null || typeof r.value !== 'object' || typeof r.value.file !== 'string') return { removed: false }
  const file = r.value.file
  const forget = (): void => { try { rmSync(paths.shellPathStateFile(), { force: true }) } catch {  } }
  const target = writeTarget(file, paths.home())
  if ('unsafe' in target) return { removed: false, file, note: `${target.unsafe}; remove the lines between ${START} and ${END} by hand` }
  if (!existsSync(target.path)) { forget(); return { removed: false, file } }
  const text = readFileSync(target.path, 'utf8')
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.trimEnd() === START)
  const end = start < 0 ? -1 : lines.findIndex((l, i) => i > start && l.trimEnd() === END)
  if (start < 0) { forget(); return { removed: false, file } }
  if (end < 0) return { removed: false, file, note: `${file} has ${START} without ${END}, so it was left as it is; remove Buracle's PATH lines by hand` }
  const next = [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n')
  try {
    atomicWriteSync(target.path, next)
  } catch (e) {
    return { removed: false, file, note: `cannot write ${file}: ${(e as Error).message}` }
  }
  forget()
  return { removed: true, file }
}
