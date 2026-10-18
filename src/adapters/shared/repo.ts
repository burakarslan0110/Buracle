import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { revParse } from '../../engine/git'

export interface BuracleRepoOptions {
  known?: ReadonlyArray<string | undefined>
  home?: string
  toplevel?: (cwd: string) => Promise<string | undefined>
}

function real(p: string): string {
  try { return realpathSync(p) } catch { return resolve(p) }
}

function expand(p: string, home: string | undefined): string | undefined {
  const t = p.trim()
  if (t === '') return undefined
  const e = t === '~' ? home : t.startsWith('~/') && home !== undefined ? join(home, t.slice(2)) : t
  return e !== undefined && isAbsolute(e) ? resolve(e) : undefined
}

function packageName(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as unknown
    const name = pkg !== null && typeof pkg === 'object' ? (pkg as Record<string, unknown>)['name'] : undefined
    return typeof name === 'string' ? name : undefined
  } catch {
    return undefined
  }
}

export async function buracleRepoFor(cwd: string, opts: BuracleRepoOptions = {}): Promise<string | undefined> {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return undefined
  let top: string | undefined
  try {
    top = await (opts.toplevel ?? (dir => revParse(dir, '--show-toplevel')))(cwd)
  } catch {
    return undefined
  }
  if (top === undefined || top === '' || !isAbsolute(top)) return undefined
  const realTop = real(top)
  const known = (opts.known ?? []).flatMap(k => {
    const e = typeof k === 'string' ? expand(k, opts.home) : undefined
    return e === undefined ? [] : [real(e)]
  })
  if (packageName(top) !== 'buracle' && !known.includes(realTop)) return undefined
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (real(dir) === realTop) return dir
    if (dirname(dir) === dir) break
  }
  return top
}
