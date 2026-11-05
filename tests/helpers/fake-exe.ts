import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'

// Fake executables: an extensionless `#!/bin/sh` file that execs Bun on a script, so the logic is a Bun script.

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

// The scripts live outside the fake's folder, so a test that lists a bin folder sees only the fakes.
function scriptsHome(): string {
  if (scriptDir === undefined) {
    const runRoot = globalThis.__BURACLE_REAL_HOME_GUARD__?.runRoot
    scriptDir = runRoot !== undefined ? join(runRoot, 'fake-exe') : mkdtempSync(join(tmpdir(), 'buracle-fake-exe-'))
  }
  mkdirSync(scriptDir, { recursive: true })
  return scriptDir
}

let counter = 0

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** The launcher text that runs `script` with `bun`, passing every argument through. */
export function launcherText(bun: string, script: string): string {
  return `#!/bin/sh\nexec ${shQuote(bun)} --no-env-file ${shQuote(script)} "$@"\n`
}

/**
 * Writes a fake executable at `path` that runs `js` with this Bun, and returns its path. `js` is an ES module;
 * see the preamble for the names it can use.
 */
export function fakeExe(path: string, js: string): string {
  const name = basename(path)
  const script = join(scriptsHome(), `${++counter}-${name.replace(/[^\w.-]/g, '_')}.mjs`)
  writeFileSync(script, preamble(name) + js + '\n')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, launcherText(process.execPath, script))
  chmodSync(path, 0o755)
  return path
}

/** A PATH made of `dirs`. */
export function pathOf(...dirs: string[]): string {
  return dirs.join(delimiter)
}

/** The system folders a test keeps on a narrowed PATH: git and the shell live there. */
export const SYSTEM_PATH_DIRS: readonly string[] = ['/usr/bin', '/bin']

/** `dirs` followed by the system folders, as one PATH. */
export function narrowPath(...dirs: string[]): string {
  return pathOf(...dirs, ...SYSTEM_PATH_DIRS)
}

/** A PATH of `dirs` alone, for a test that wants nothing else found. */
export function onlyPath(...dirs: string[]): string {
  return pathOf(...dirs)
}
