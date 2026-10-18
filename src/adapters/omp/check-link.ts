import { realpathSync } from 'node:fs'
import { run } from '../../engine/proc'
import { PACKAGE_NAME } from './generated'

export interface LinkStatus { state: 'linked' | 'absent' | 'disabled' | 'elsewhere' | 'unknown'; path?: string; detail?: string }

function real(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

export function linkStatus(listJson: string, pluginDir: string): LinkStatus {
  let parsed: unknown
  try { parsed = JSON.parse(listJson) } catch { return { state: 'unknown', detail: 'omp plugin list --json did not print JSON' } }
  const npm = parsed !== null && typeof parsed === 'object' ? (parsed as { npm?: unknown }).npm : undefined
  if (!Array.isArray(npm)) return { state: 'unknown', detail: 'unexpected omp plugin list --json shape' }
  const entry = npm.find(p => p !== null && typeof p === 'object' && (p as { name?: unknown }).name === PACKAGE_NAME) as { path?: unknown, enabled?: unknown } | undefined
  if (entry === undefined) return { state: 'absent' }
  const at = typeof entry.path === 'string' ? real(entry.path) : undefined
  if (at === undefined || at !== real(pluginDir)) return at !== undefined ? { state: 'elsewhere', path: at } : { state: 'elsewhere' }
  if (entry.enabled === false) return { state: 'disabled', path: at }
  return { state: 'linked', path: at }
}

export async function checkLink(pluginDir: string, ompBin = 'omp', timeoutMs = 30_000): Promise<LinkStatus> {
  const r = await run([ompBin, 'plugin', 'list', '--json'], { timeoutMs })
  if (r.code !== 0) return { state: 'unknown', detail: `omp plugin list exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300)}` }
  return linkStatus(r.stdout, pluginDir)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const absent = args.includes('--absent')
  const ompAt = args.indexOf('--omp')
  const ompBin = ompAt >= 0 ? args[ompAt + 1] ?? 'omp' : 'omp'
  const dir = args.find((a, i) => !a.startsWith('--') && (ompAt < 0 || i !== ompAt + 1))
  if (dir === undefined) {
    process.stderr.write('usage: check-link.ts <pluginDir> [--omp <bin>] [--absent]\n')
    process.exit(2)
  }
  const st = await checkLink(dir, ompBin)
  if (absent) process.exit(st.state === 'absent' ? 0 : 1)
  process.exit(st.state === 'linked' ? 0 : 1)
}
