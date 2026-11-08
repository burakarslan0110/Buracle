import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import { atomicWriteSync, readJsonSafeSync } from '../fsx'
import * as paths from '../paths'

// The `buracle` command lives in ~/.local/bin, and so do the links to the harness programs a shell cannot find by name.
// When PATH lacks that folder, the install adds one marked block to the startup file of the user's shell, once, and
// records which file; the same goes for the other of zsh and bash, because a terminal opened in it never reads the first
// one's file. `buracle uninstall` takes the same blocks out again.

const START = '# >>> buracle >>>'
const END = '# <<< buracle <<<'

export type ShellPathSkip = 'on-path' | 'in-file' | 'unsafe' | 'error'
export interface ShellPathResult { changed: boolean, file?: string, skipped?: ShellPathSkip, reason?: string }

/** `file` is the first block written, `others` the blocks of the other shells (absent when there are none). */
interface ShellPathRecord { v: 1, file: string, others?: string[] }

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

/** The record of the blocks Buracle wrote, or undefined when there is none (or it is unreadable). */
function readRecord(): ShellPathRecord | undefined {
  const r = readJsonSafeSync<ShellPathRecord>(paths.shellPathStateFile())
  if (!r.ok || r.value === null || typeof r.value !== 'object' || typeof r.value.file !== 'string') return undefined
  const others = Array.isArray(r.value.others) ? r.value.others.filter((f): f is string => typeof f === 'string') : []
  return { v: 1, file: r.value.file, ...(others.length > 0 ? { others } : {}) }
}

function isRecorded(file: string): boolean {
  const rec = readRecord()
  return rec !== undefined && (rec.file === file || (rec.others ?? []).includes(file))
}

/** Adds `file` to the record: the first one is `file`, every later one goes to `others`. */
function remember(file: string): void {
  const rec = readRecord()
  if (rec !== undefined && isRecorded(file)) return
  const next: ShellPathRecord = rec === undefined ? { v: 1, file } : { v: 1, file: rec.file, others: [...(rec.others ?? []), file] }
  atomicWriteSync(paths.shellPathStateFile(), JSON.stringify(next, null, 2) + '\n')
}

/** Puts the block into `file` once (inside the home folder, through no link that leaves it), after recording the file. */
function insertBlock(file: string, home: string): ShellPathResult {
  let homeReal = home
  try { homeReal = realpathSync(home) } catch {  }
  // ZDOTDIR may name any folder; Buracle writes only inside the home folder.
  if (!inside(home, file) && !inside(homeReal, file)) return { changed: false, file, skipped: 'unsafe', reason: `${file} is outside your home folder` }
  const target = writeTarget(file, home)
  if ('unsafe' in target) return { changed: false, file, skipped: 'unsafe', reason: target.unsafe }
  try {
    const text = existsSync(target.path) ? readFileSync(target.path, 'utf8') : ''
    if (text.includes(START)) {
      // Buracle's own block: its record may be gone (a wiped ~/.buracle), and uninstall needs it to find the block.
      if (!isRecorded(file)) remember(file)
      return { changed: false, file, skipped: 'in-file' }
    }
    if (ALREADY.test(text)) return { changed: false, file, skipped: 'in-file' }
    // The record first: a block written without one could never be taken out again.
    remember(file)
    const sep = text === '' || text.endsWith('\n') ? '' : '\n'
    atomicWriteSync(target.path, `${text}${sep}${blockFor(file)}`)
    return { changed: true, file }
  } catch (e) {
    return { changed: false, file, skipped: 'error', reason: `cannot write ${file}: ${(e as Error).message}` }
  }
}

export function addLocalBinToPath(opts: { env?: Readonly<Record<string, string | undefined>>, os?: string, home?: string } = {}): ShellPathResult {
  const env = opts.env ?? process.env
  const os = opts.os ?? process.platform
  const home = opts.home ?? paths.home()
  const localBin = join(home, '.local', 'bin')
  if (onPath(localBin, env['PATH'])) return { changed: false, skipped: 'on-path' }
  return insertBlock(startupFile(env, os, home), home)
}

export type LoginShell = 'zsh' | 'bash'
const LOGIN_SHELLS: readonly LoginShell[] = ['zsh', 'bash']
export type ShellProbe = (shell: LoginShell, home: string) => string | undefined

const PATH_MARK = '__BURACLE_PATH__'

/**
 * The PATH a fresh login shell of this kind starts with (what a new terminal gets), or undefined when the shell is not
 * installed or does not answer. It runs with a clean environment, so the PATH of the process that asks cannot leak in.
 */
export function probeLoginPath(shell: LoginShell, home: string): string | undefined {
  const exe = Bun.which(shell, { PATH: '/bin:/usr/bin:/usr/local/bin:/opt/homebrew/bin' })
  if (exe === null) return undefined
  try {
    const r = Bun.spawnSync([exe, shell === 'zsh' ? '-lic' : '-lc', `printf '%s%s' ${PATH_MARK} "$PATH"`], {
      env: { HOME: home, USER: basename(home), LOGNAME: basename(home), TERM: 'dumb', SHELL: exe },
      stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: 5000,
    })
    if (r.exitCode !== 0) return undefined
    const out = r.stdout.toString()
    const at = out.lastIndexOf(PATH_MARK)
    return at < 0 ? undefined : out.slice(at + PATH_MARK.length)
  } catch {
    return undefined
  }
}

/**
 * The same for the shell the user does not log in with: a terminal opened in bash (or zsh) never reads the other one's
 * startup file, so `omp`, `codex`, `claude` and `buracle` were "command not found" there. Each installed shell other than
 * $SHELL is asked for its fresh login PATH; one that lacks ~/.local/bin gets the block in its own startup file.
 */
export function addLocalBinToOtherShells(opts: { env?: Readonly<Record<string, string | undefined>>, os?: string, home?: string, probe?: ShellProbe } = {}): ShellPathResult[] {
  const env = opts.env ?? process.env
  const os = opts.os ?? process.platform
  const home = opts.home ?? paths.home()
  const probe = opts.probe ?? probeLoginPath
  const localBin = join(home, '.local', 'bin')
  const mine = basename(env['SHELL'] ?? '')
  const out: ShellPathResult[] = []
  for (const shell of LOGIN_SHELLS) {
    if (shell === mine) continue
    const file = startupFile({ ...env, SHELL: `/bin/${shell}` }, os, home)
    // A file that already has Buracle's block, or puts the folder on PATH itself, settles it: no shell is started. The probe
    // runs the whole rc file of the user (plugins, version managers), so it runs only when a block would be written.
    if (putsOnPath(file, home)) { out.push(insertBlock(file, home)); continue }
    const loginPath = probe(shell, home)
    if (loginPath === undefined) continue
    if (onPath(localBin, loginPath)) { out.push({ changed: false, file, skipped: 'on-path' }); continue }
    out.push(insertBlock(file, home))
  }
  return out
}

/** Whether `file` already holds Buracle's block or a line that puts ~/.local/bin on PATH. */
function putsOnPath(file: string, home: string): boolean {
  const target = writeTarget(file, home)
  if ('unsafe' in target) return false
  try {
    const text = readFileSync(target.path, 'utf8')
    return text.includes(START) || ALREADY.test(text)
  } catch {
    return false
  }
}

/** Takes the block out of one file: only a whole start-to-end block, nothing else. `settled` says the record of it can go. */
function removeBlock(file: string): { removed: boolean, file: string, settled: boolean, note?: string } {
  const target = writeTarget(file, paths.home())
  if ('unsafe' in target) return { removed: false, file, settled: false, note: `${target.unsafe}; remove the lines between ${START} and ${END} by hand` }
  if (!existsSync(target.path)) return { removed: false, file, settled: true }
  const text = readFileSync(target.path, 'utf8')
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.trimEnd() === START)
  const end = start < 0 ? -1 : lines.findIndex((l, i) => i > start && l.trimEnd() === END)
  if (start < 0) return { removed: false, file, settled: true }
  if (end < 0) return { removed: false, file, settled: false, note: `${file} has ${START} without ${END}, so it was left as it is; remove Buracle's PATH lines by hand` }
  const next = [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n')
  try {
    atomicWriteSync(target.path, next)
  } catch (e) {
    return { removed: false, file, settled: false, note: `cannot write ${file}: ${(e as Error).message}` }
  }
  return { removed: true, file, settled: true }
}

/**
 * Takes the blocks the install added out of the recorded files. `file` is the first block, `also` the files of the
 * other shells whose block was taken out. The record goes once every block is settled.
 */
export function removeLocalBinFromPath(): { removed: boolean, file?: string, also?: string[], note?: string } {
  const rec = readRecord()
  if (rec === undefined) return { removed: false }
  const results = [rec.file, ...(rec.others ?? [])].map(removeBlock)
  if (results.every(r => r.settled)) { try { rmSync(paths.shellPathStateFile(), { force: true }) } catch {  } }
  const first = results[0] as ReturnType<typeof removeBlock>
  const also = results.slice(1).filter(r => r.removed).map(r => r.file)
  const note = results.map(r => r.note).find((n): n is string => n !== undefined)
  return { removed: results.some(r => r.removed), file: results.find(r => r.removed)?.file ?? first.file, ...(also.length > 0 && first.removed ? { also } : {}), ...(note !== undefined ? { note } : {}) }
}
