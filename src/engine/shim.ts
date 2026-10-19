import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import * as paths from './paths'
import { isWindows, spawnArgv } from './platform'

export interface ShimInfo {
  mode: 'frozen' | 'checkout' | 'legacy'
  bun: string
  main: string
  checkout?: string
}

const SQ = "((?:[^']|'\\\\'')*)"
const unquote = (s: string) => s.replace(/'\\''/g, "'")

function parseWindowsShim(text: string): ShimInfo | undefined {
  const mode = /^rem buracle-shim: (frozen|checkout)\r?$/m.exec(text)?.[1] as 'frozen' | 'checkout' | undefined
  const run = /^"([^"]+)" "([^"]+)" %\*\r?$/m.exec(text)
  if (mode === undefined || run?.[1] === undefined || run[2] === undefined) return undefined
  const info: ShimInfo = { mode, bun: run[1], main: run[2] }
  const c = /^if exist "([^"]+)" "[^"]+" "[^"]+" %\*\r?$/m.exec(text)?.[1]
  if (c !== undefined) info.checkout = resolve(c, '..', '..', '..')
  else if (mode === 'checkout') info.checkout = resolve(info.main, '..', '..', '..')
  return info
}

// Reads the bun and the main.ts a shim runs, from the sh shim or from buracle.cmd.
export function parseShimText(text: string): ShimInfo | undefined {
  const legacy = new RegExp(`^exec '${SQ}' '${SQ}' "\\$@"$`, 'm').exec(text)
  if (legacy?.[1] !== undefined && legacy[2] !== undefined) {
    const main = unquote(legacy[2])
    return { mode: 'legacy', bun: unquote(legacy[1]), main, checkout: resolve(main, '..', '..', '..') }
  }
  if (/^@echo off\r?$/m.test(text)) return parseWindowsShim(text)
  const mode = /^# buracle-shim: (frozen|checkout)$/m.exec(text)?.[1] as 'frozen' | 'checkout' | undefined
  const b = new RegExp(`^b='${SQ}'$`, 'm').exec(text)?.[1]
  const m = new RegExp(`^m='${SQ}'$`, 'm').exec(text)?.[1]
  const c = new RegExp(`^c='${SQ}'$`, 'm').exec(text)?.[1]
  if (mode === undefined || b === undefined || m === undefined) return undefined
  const info: ShimInfo = { mode, bun: unquote(b), main: unquote(m) }
  if (c !== undefined) info.checkout = resolve(unquote(c), '..', '..', '..')
  else if (mode === 'checkout') info.checkout = resolve(info.main, '..', '..', '..')
  return info
}

export function readShim(shim: string = paths.shimPath()): ShimInfo | undefined {
  try { return parseShimText(readFileSync(shim, 'utf8')) } catch { return undefined }
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}

const mainOf = (dir: string): string => join(dir, 'src', 'cli', 'main.ts')

function recordedLaunch(): string[] | undefined {
  try {
    const r = (JSON.parse(readFileSync(paths.runtimeConfigFile(), 'utf8')) as { resolved?: { bun?: unknown, repoRoot?: unknown } } | null)?.resolved
    if (typeof r?.bun !== 'string' || typeof r.repoRoot !== 'string' || !isAbsolute(r.repoRoot)) return undefined
    return isFile(r.bun) && isFile(mainOf(r.repoRoot)) ? [r.bun, mainOf(r.repoRoot)] : undefined
  } catch {
    return undefined
  }
}

// The start of an argv that runs the Buracle CLI through the installed shim. POSIX: the shim itself. Windows:
// Bun does not start a .cmd reliably, so what buracle.cmd would run comes first: its own bun and main.ts (the
// checkout's when the runtime is gone), else the bun and checkout runtime-config.json recorded. undefined when
// there is no shim, or on Windows nothing it names exists.
export function shimLaunch(shim: string = paths.shimPath()): string[] | undefined {
  if (!isFile(shim)) return undefined
  if (!isWindows()) return [shim]
  const info = readShim(shim)
  if (info !== undefined && isFile(info.bun)) {
    if (isFile(info.main)) return [info.bun, info.main]
    if (info.checkout !== undefined && isFile(mainOf(info.checkout))) return [info.bun, mainOf(info.checkout)]
  }
  return recordedLaunch()
}

// A whole argv for one CLI call through the shim; on Windows the last resort is buracle.cmd through cmd.exe,
// which must be spawned with windowsVerbatimArguments: windowsVerbatim(argv).
export function shimArgv(args: readonly string[], shim: string = paths.shimPath()): string[] | undefined {
  const launch = shimLaunch(shim)
  if (launch !== undefined) return [...launch, ...args]
  return isWindows() && isFile(shim) ? spawnArgv([shim, ...args]) : undefined
}
