import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export type OsName = 'darwin' | 'linux'

// BURACLE_PLATFORM=darwin or linux makes a test run as that host; any other value is ignored.
export function osName(): OsName {
  const forced = process.env['BURACLE_PLATFORM']
  if (forced === 'darwin' || forced === 'linux') return forced
  return process.platform === 'darwin' ? 'darwin' : 'linux'
}

const PROC_VERSION = '/proc/version'
const BINFMT_DIR = '/proc/sys/fs/binfmt_misc'
let wslKernel: boolean | undefined

function microsoftKernel(versionFile: string): boolean {
  try {
    const v = readFileSync(versionFile, 'utf8').toLowerCase()
    return v.includes('microsoft') || v.includes('wsl')
  } catch { return false }
}

// WSL is Linux with a Microsoft kernel; its shells carry WSL_DISTRO_NAME and WSL_INTEROP, which a process started
// outside such a shell (a service, a hook) may lack, so the kernel's version text decides then.
export function isWsl(env: Readonly<Record<string, string | undefined>> = process.env, versionFile = PROC_VERSION): boolean {
  if (osName() !== 'linux') return false
  if ((env['WSL_DISTRO_NAME'] ?? '') !== '' || (env['WSL_INTEROP'] ?? '') !== '') return true
  if (versionFile !== PROC_VERSION) return microsoftKernel(versionFile)
  wslKernel ??= microsoftKernel(versionFile)
  return wslKernel
}

// WSL starts Windows programs through a binfmt_misc entry: WSLInterop, or WSLInterop-late in a distribution that runs
// systemd. Interop turned off in wsl.conf (or by writing 0 to the entry) leaves it missing or disabled.
export function wslInterop(dir = BINFMT_DIR): boolean {
  for (const name of ['WSLInterop', 'WSLInterop-late']) {
    try {
      if (readFileSync(join(dir, name), 'utf8').split('\n')[0]?.trim() === 'enabled') return true
    } catch {  }
  }
  return false
}

/** Where a page or a notification reaches the person: the macOS or Linux desktop, or Windows from inside WSL. */
export type DesktopHost = 'darwin' | 'linux' | 'wsl' | 'wsl-no-interop'

export function desktopHost(env: Readonly<Record<string, string | undefined>> = process.env, versionFile = PROC_VERSION, binfmtDir = BINFMT_DIR): DesktopHost {
  if (osName() === 'darwin') return 'darwin'
  if (!isWsl(env, versionFile)) return 'linux'
  return wslInterop(binfmtDir) ? 'wsl' : 'wsl-no-interop'
}

// The Windows programs Buracle starts from WSL, at their usual place on drive C: for a shell whose PATH lacks the
// Windows folders (appendWindowsPath = false in wsl.conf).
const WINDOWS_PROGRAMS: Readonly<Record<string, string>> = {
  'rundll32.exe': '/mnt/c/Windows/System32/rundll32.exe',
  'powershell.exe': '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
}

/** A program a WSL process can start: on PATH, else a known Windows program at its usual place. */
export function findWslProgram(name: string, places: Readonly<Record<string, string>> = WINDOWS_PROGRAMS): string | undefined {
  const hit = findExecutable(name)
  if (hit !== undefined) return hit
  const fixed = places[name]
  return fixed !== undefined && isFile(fixed) ? fixed : undefined
}

function homeDir(): string {
  const h = process.env['HOME']
  return h !== undefined && h.trim() !== '' ? h : homedir()
}

const ACCOUNT_LOOKUP_MS = 1500

const SHELL_HOME_LOOKUP = 'n=$(id -un) || exit 1; case $n in ""|-*|*[!A-Za-z0-9._@-]*) exit 1;; esac; eval "printf %s ~$n"'

let accountHomeCache: { home: string | undefined } | undefined

const posixAbsolute = (p: string | undefined): p is string => p !== undefined && p.startsWith('/') && !p.includes('\n')

function lookupOutput(argv: string[]): string | undefined {
  try {
    const r = Bun.spawnSync(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: ACCOUNT_LOOKUP_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, env: { ...process.env } })
    return r.exitCode === 0 && r.exitedDueToTimeout !== true ? r.stdout.toString() : undefined
  } catch {
    return undefined
  }
}

function passwdHome(text: string | undefined, uid: number): string | undefined {
  for (const line of (text ?? '').split('\n')) {
    const f = line.trim().split(':')
    if (f.length < 7 || f[2] !== String(uid)) continue
    const home = f[f.length - 2]
    if (posixAbsolute(home)) return home
  }
  return undefined
}

function lookUpAccountHome(): string | undefined {
  const uid = process.getuid?.()
  if (uid === undefined) return undefined
  const entry = process.platform === 'darwin' ? lookupOutput(['id', '-P']) : lookupOutput(['getent', 'passwd', String(uid)])
  const fromEntry = passwdHome(entry, uid)
  if (fromEntry !== undefined) return fromEntry
  const viaShell = lookupOutput(['/bin/sh', '-c', SHELL_HOME_LOOKUP])?.trim()
  return posixAbsolute(viaShell) ? viaShell : undefined
}

export function accountHome(): string | undefined {
  accountHomeCache ??= { home: lookUpAccountHome() }
  return accountHomeCache.home
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}

export function extraBinDirs(): string[] {
  const home = homeDir()
  const dirs: string[] = [join(home, '.local', 'bin'), join(home, '.bun', 'bin'), join(home, 'go', 'bin'), join(home, '.cargo', 'bin')]
  if (osName() === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  if (osName() === 'linux') dirs.push('/home/linuxbrew/.linuxbrew/bin', '/usr/local/bin')
  return dirs
}

export function findExecutable(name: string, opts: { extra?: readonly string[] } = {}): string | undefined {
  const PATH = process.env['PATH']
  const hit = PATH !== undefined ? Bun.which(name, { PATH }) : Bun.which(name)
  if (hit !== null && hit !== undefined) return hit
  for (const dir of [...(opts.extra ?? []), ...extraBinDirs()]) {
    const p = join(dir, name)
    if (isFile(p)) return p
  }
  return undefined
}

export function augmentedPath(base: string | undefined = process.env['PATH']): string {
  const have = (base ?? '').split(':').filter(s => s !== '')
  const add = extraBinDirs().filter(d => !have.includes(d) && existsSync(d))
  return [...have, ...add].join(':')
}

type ExecveFn = (file: string, args: readonly string[], env: Record<string, string | undefined>) => never

export function execServer(argv: readonly string[], env: Record<string, string | undefined>): string | undefined {
  const execve = (process as { execve?: ExecveFn }).execve
  const file = argv[0]
  if (typeof execve !== 'function' || file === undefined || !isAbsolute(file)) return undefined
  const noop = () => {  }
  const reset: NodeJS.Signals[] = []
  for (const s of ['SIGPIPE', 'SIGXFSZ'] as NodeJS.Signals[]) { try { process.on(s, noop); reset.push(s) } catch {  } }
  try {
    execve.call(process, file, [...argv], env)
  } catch (e) {
    for (const s of reset) process.off(s, noop)
    return e instanceof Error ? e.message : String(e)
  }
  return undefined
}
