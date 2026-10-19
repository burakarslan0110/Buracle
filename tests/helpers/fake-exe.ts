import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'

// Fake executables that work on every platform. The logic is a Bun script, so macOS and Linux run the
// same code Windows does; only the launcher differs. POSIX: an extensionless `#!/bin/sh` file that
// execs Bun on the script. Windows: `<name>.cmd`, because Bun.which (and so the product) finds only
// PATHEXT names there.

export const IS_WINDOWS = process.platform === 'win32'

/** Whether stat reads back the POSIX mode a test set: Windows keeps none (it reads 0o666, or 0o444 when read-only). */
export const KEEPS_MODES = !IS_WINDOWS

export type LauncherPlatform = 'posix' | 'win32'

const hostPlatform = (): LauncherPlatform => (IS_WINDOWS ? 'win32' : 'posix')

// What the script sees besides the Node and Bun globals: `argv` (its arguments), `self` (the fake's
// own name, as `$(basename "$0")` gives it), `fs` (node:fs) and `append(file, line)`.
const preamble = (name: string): string => [
  "import * as fs from 'node:fs'",
  'const argv = process.argv.slice(2)',
  `const self = ${JSON.stringify(name)}`,
  "const append = (file, line) => fs.appendFileSync(file, line + '\\n')",
  '',
].join('\n')

let scriptDir: string | undefined

// The scripts live outside the fake's folder: a test that lists a bin folder sees only the fakes, and
// a `.js` next to the fake would be another PATHEXT match on Windows.
function scriptsHome(): string {
  if (scriptDir === undefined) {
    const runRoot = globalThis.__BURACLE_REAL_HOME_GUARD__?.runRoot
    scriptDir = runRoot !== undefined ? join(runRoot, 'fake-exe') : mkdtempSync(join(tmpdir(), 'buracle-fake-exe-'))
  }
  mkdirSync(scriptDir, { recursive: true })
  return scriptDir
}

let counter = 0

/** The path a fake written at `path` is run by: `path` itself on POSIX, `path.cmd` on Windows. */
export function exePath(path: string, platform: LauncherPlatform = hostPlatform()): string {
  return platform === 'win32' ? `${path}.cmd` : path
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** The launcher text that runs `script` with `bun`, passing every argument through. */
export function launcherText(bun: string, script: string, platform: LauncherPlatform = hostPlatform()): string {
  if (platform === 'win32') {
    if (/["%\r\n]/.test(bun + script)) throw new Error(`a fake's paths cannot hold ", % or a line break on Windows: ${bun} ${script}`)
    return `@echo off\r\n"${bun}" --no-env-file "${script}" %*\r\nexit /b %ERRORLEVEL%\r\n`
  }
  return `#!/bin/sh\nexec ${shQuote(bun)} --no-env-file ${shQuote(script)} "$@"\n`
}

/**
 * Writes a fake executable at `path` (`path.cmd` on Windows) that runs `js` with this Bun, and returns
 * the path to run it by. `js` is an ES module; see the preamble for the names it can use.
 */
export function fakeExe(path: string, js: string): string {
  const name = basename(path)
  const script = join(scriptsHome(), `${++counter}-${name.replace(/[^\w.-]/g, '_')}.mjs`)
  writeFileSync(script, preamble(name) + js + '\n')
  const exe = exePath(path)
  mkdirSync(dirname(exe), { recursive: true })
  writeFileSync(exe, launcherText(process.execPath, script))
  chmodSync(exe, 0o755)
  return exe
}

/** A PATH made of `dirs`, joined the way this platform joins them. */
export function pathOf(...dirs: string[]): string {
  return dirs.join(delimiter)
}

// Read once at load, before a test narrows PATH.
const gitDir = ((): string | undefined => {
  const git = Bun.which('git')
  return git !== null ? dirname(git) : undefined
})()

// Git for Windows runs the other end of a fetch or push to a local path through sh: its folder stays on a
// narrowed PATH too (with Git Bash's PATH, git is mingw64\bin\git.exe and sh lives in usr\bin).
const shDir = ((): string | undefined => {
  const sh = Bun.which('sh')
  return sh !== null ? dirname(sh) : undefined
})()

/**
 * The system folders a test keeps on a narrowed PATH: `/usr/bin` and `/bin` on POSIX (git and the
 * shell live there). On Windows: System32 (cmd.exe, which runs every `.cmd`), the Windows folder,
 * and the folders of git and sh, so a narrowed PATH still finds git (and git its sh) as on macOS and Linux.
 */
export function systemPathDirs(): string[] {
  if (!IS_WINDOWS) return ['/usr/bin', '/bin']
  const root = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows'
  return [join(root, 'System32'), root, ...[...new Set([gitDir, shDir])].filter((d): d is string => d !== undefined)]
}

/** `dirs` followed by the system folders, as one PATH. */
export function narrowPath(...dirs: string[]): string {
  return pathOf(...dirs, ...systemPathDirs())
}

/**
 * A PATH of `dirs` alone, for a test that wants nothing else found. On Windows System32 stays on
 * it: cmd.exe lives there, and every `.cmd` (the fakes included) runs through it.
 */
export function onlyPath(...dirs: string[]): string {
  return pathOf(...dirs, ...(IS_WINDOWS ? systemPathDirs().slice(0, 1) : []))
}

// The words of a cmd.exe line written by quoteCmd: a word is bare, or quoted with "" for a quote
// inside, and `^x` outside quotes is x (quoteCmd writes a % as "^%" so cmd does not expand it).
// With `strict`, a quote quoteCmd would not write makes the line no such line (undefined).
function cmdWords(line: string, strict: boolean): string[] | undefined {
  const words: string[] = []
  let word = ''
  let inWord = false
  let quoted = false
  let escaped = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { word += '"'; i++ }
      else if (ch === '"') {
        quoted = false
        const next = line[i + 1]
        if (strict && next !== undefined && next !== ' ' && next !== '^') return undefined
      } else word += ch
    } else if (ch === '"') {
      if (strict && inWord && !escaped) return undefined
      quoted = true
      inWord = true
    } else if (ch === '^' && i + 1 < line.length) {
      word += line[++i]
      inWord = true
      escaped = true
      continue
    } else if (ch === ' ') {
      if (inWord) words.push(word)
      word = ''
      inWord = false
    } else {
      word += ch
      inWord = true
    }
    escaped = false
  }
  if (quoted && strict) return undefined
  if (inWord) words.push(word)
  return words
}

/**
 * The words of an argv the product built for this platform: on Windows spawnArgv runs a `.cmd` as
 * `cmd.exe /d /s /c <line>`, and a fake that intercepts opsDeps.run wants the words of that line back.
 * A line holding quotes comes wrapped in one more pair (cmd's /s strips the first and the last quote);
 * a line without them comes as it is.
 */
export function unwrapCmd(argv: readonly string[]): string[] {
  const [exe, d, s, c, line, ...rest] = argv
  if (exe === undefined || !/(^|[\\/])cmd(\.exe)?$/i.test(exe) || d !== '/d' || s !== '/s' || c !== '/c' || line === undefined || rest.length > 0) return [...argv]
  if (line.length >= 2 && line.startsWith('"') && line.endsWith('"')) {
    const inner = cmdWords(line.slice(1, -1), true)
    if (inner !== undefined) return inner
  }
  return cmdWords(line, false) ?? []
}
