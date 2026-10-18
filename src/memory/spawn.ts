import { existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { log } from '../engine/log'
import * as paths from '../engine/paths'

export const MEMORY_RUNNER_DIR_PREFIX = 'buracle-runner-'

export function isMemoryRunnerDir(dir: string | undefined): boolean {
  return dir !== undefined && basename(dir.replace(/\/+$/, '')).startsWith(MEMORY_RUNNER_DIR_PREFIX)
}

function bunBinary(): string | undefined {
  const exe = process.execPath
  if (/^bun(?:-[^/]*)?$/.test(basename(exe))) return exe
  return Bun.which('bun') ?? undefined
}

export function bunExecutable(): string {
  return bunBinary() ?? process.execPath
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}

export function moduleCheckout(): string | undefined {
  return paths.findCheckout(import.meta.dir)
}

export function cliArgv(): string[] {
  const shim = paths.shimPath()
  const haveShim = isFile(shim)
  if (haveShim && moduleCheckout() === undefined) return [shim]
  const main = join(paths.repoRoot(), 'src', 'cli', 'main.ts')
  const bun = bunBinary()
  if (bun !== undefined && isFile(main)) return [bun, main]
  if (haveShim) return [shim]
  return [bun ?? process.execPath, main]
}

export function spawnCli(args: readonly string[], env: Record<string, string> = {}): number | undefined {
  try {
    const checkout = moduleCheckout() ?? paths.configuredRepoRoot()
    const proc = Bun.spawn([...cliArgv(), ...args], {
      cwd: checkout !== undefined ? checkout : existsSync(paths.home()) ? paths.home() : '/',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    })
    proc.unref()
    return proc.pid
  } catch (e) {
    log('warn', 'memory: cannot start a background job', { args: args.slice(0, 3), error: e })
    return undefined
  }
}
