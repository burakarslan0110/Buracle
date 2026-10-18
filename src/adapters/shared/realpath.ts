import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const MAX_HOPS = 40

function resolveFrom(p: string, hops: number): string | undefined {
  if (hops > MAX_HOPS) return undefined
  try { return realpathSync(p) } catch {  }
  let st: ReturnType<typeof lstatSync> | undefined
  try { st = lstatSync(p) } catch { st = undefined }
  if (st?.isSymbolicLink()) {
    let target: string
    try { target = readlinkSync(p) } catch { return undefined }
    return resolveFrom(isAbsolute(target) ? target : resolve(dirname(p), target), hops + 1)
  }
  const parent = dirname(p)
  if (parent === p) return p
  const real = resolveFrom(parent, hops + 1)
  return real === undefined ? undefined : join(real, basename(p))
}

export function realWriteTarget(p: string): string | undefined {
  if (typeof p !== 'string' || !isAbsolute(p)) return undefined
  return resolveFrom(resolve(p), 0)
}

export function withRealpath<T extends object>(ctx: T): T & { realpath: (p: string) => string | undefined } {
  return { ...ctx, realpath: realWriteTarget }
}
