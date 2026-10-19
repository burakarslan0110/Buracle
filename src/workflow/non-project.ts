import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { memNonProjectReason } from '../core/memory/project'
import * as paths from '../engine/paths'

// The native realpath also expands Windows 8.3 short names (C:\Users\RUNNER~1 is C:\Users\runneradmin).
function realOr(p: string): string {
  try { return realpathSync.native(p) } catch {
    try { return realpathSync(p) } catch { return p }
  }
}

const POSIX_TEMP = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders']

export function tempRoots(): string[] {
  const out = new Set<string>()
  const candidates = [tmpdir(), process.env['TMPDIR'], process.env['TEMP'], process.env['TMP'], ...(process.platform === 'win32' ? [] : POSIX_TEMP)]
  for (const c of candidates) {
    if (c === undefined || c === '') continue
    out.add(resolve(c).replace(/[\\/]+$/, ''))
    out.add(realOr(c).replace(/[\\/]+$/, ''))
  }
  return [...out].filter(p => p !== '' && p !== '/')
}

export function nonProjectReason(dir: string): string | undefined {
  const abs = resolve(dir)
  const env = {
    home: resolve(paths.home()), vault: resolve(paths.oldVaultRoot()), buracleHome: resolve(paths.buracleHome()),
    claudeDir: resolve(paths.claudeDir()), tempRoots: tempRoots(),
  }
  const resolved = { ...env, home: realOr(env.home), vault: realOr(env.vault), buracleHome: realOr(env.buracleHome), claudeDir: realOr(env.claudeDir) }
  return memNonProjectReason(abs, env) ?? memNonProjectReason(realOr(abs), resolved)
}
