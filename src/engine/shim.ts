import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import * as paths from './paths'

export interface ShimInfo {
  mode: 'frozen' | 'checkout' | 'legacy'
  bun: string
  main: string
  checkout?: string
}

const SQ = "((?:[^']|'\\\\'')*)"
const unquote = (s: string) => s.replace(/'\\''/g, "'")

// Reads the bun and the main.ts the sh shim runs.
export function parseShimText(text: string): ShimInfo | undefined {
  const legacy = new RegExp(`^exec '${SQ}' '${SQ}' "\\$@"$`, 'm').exec(text)
  if (legacy?.[1] !== undefined && legacy[2] !== undefined) {
    const main = unquote(legacy[2])
    return { mode: 'legacy', bun: unquote(legacy[1]), main, checkout: resolve(main, '..', '..', '..') }
  }
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

// The start of an argv that runs the Buracle CLI through the installed shim: the shim itself, or undefined
// when there is no shim.
export function shimLaunch(shim: string = paths.shimPath()): string[] | undefined {
  return isFile(shim) ? [shim] : undefined
}

// A whole argv for one CLI call through the shim, or undefined when there is no shim.
export function shimArgv(args: readonly string[], shim: string = paths.shimPath()): string[] | undefined {
  const launch = shimLaunch(shim)
  return launch !== undefined ? [...launch, ...args] : undefined
}
