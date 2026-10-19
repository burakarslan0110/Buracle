import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness } from '../core/events'
import type { BarInfo } from '../core/status/bar'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import * as paths from '../engine/paths'
import { findExecutable, spawnArgv, windowsVerbatim } from '../engine/platform'
import { run } from '../engine/proc'
import { shimLaunch } from '../engine/shim'
import { anySessionOpen } from '../memory/session-open'
import { captureOff } from '../memory/spool'
import { sameUiBuild, uiBuildId } from '../memory/ui-build'

const HARNESS_LABEL: Readonly<Record<Harness, string>> = { claude: 'CC', codex: 'Codex', opencode: 'OpenCode', omp: 'OMP' }

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export function buracleVersion(repoRoot: string = paths.repoRoot()): string {
  try {
    const v = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown }).version
    return typeof v === 'string' ? v : '?'
  } catch { return '?' }
}

export function claudePlan(): string | undefined {
  const file = paths.claudeJson()
  let mtime: number
  try { mtime = statSync(file).mtimeMs } catch { return undefined }
  const cacheFile = join(paths.buracleHome(), 'cache', 'claude-plan.json')
  const cached = readJsonSafeSync<{ mtime?: number, plan?: string | null }>(cacheFile)
  if (cached.ok && cached.value?.mtime === mtime) return cached.value.plan ?? undefined
  let plan: string | undefined
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const oa = isRecord(j) && isRecord(j['oauthAccount']) ? j['oauthAccount'] : undefined
    if (oa === undefined) plan = 'API'
    else {
      const org = typeof oa['organizationType'] === 'string' ? oa['organizationType'] : ''
      const tier = `${typeof oa['organizationRateLimitTier'] === 'string' ? oa['organizationRateLimitTier'] : ''} ${typeof oa['userRateLimitTier'] === 'string' ? oa['userRateLimitTier'] : ''}`
      const mult = /(\d+)x/u.exec(tier)?.[1]
      if (/max/iu.test(org)) plan = mult !== undefined && mult !== '1' ? `Max ${mult}x` : 'Max'
      else if (/pro/iu.test(org)) plan = 'Pro'
      else if (/team/iu.test(org)) plan = 'Team'
      else if (/enterprise/iu.test(org)) plan = 'Enterprise'
      else plan = org !== '' ? org.replace(/^claude_/u, '') : undefined
    }
  } catch { plan = undefined }
  try { atomicWriteSync(cacheFile, JSON.stringify({ mtime, plan: plan ?? null }) + '\n') } catch {  }
  return plan
}

const VERSION_TTL_MS = 12 * 60 * 60_000
const VERSION_CMD: Readonly<Record<Harness, string>> = { claude: 'claude', codex: 'codex', opencode: 'opencode', omp: 'omp' }

function versionCacheFile(): string {
  return join(paths.buracleHome(), 'cache', 'harness-versions.json')
}

export function forgetHarnessVersion(h: Harness): void {
  const cacheFile = versionCacheFile()
  const r = readJsonSafeSync<Record<string, unknown>>(cacheFile)
  if (!r.ok || !isRecord(r.value) || !(h in r.value)) return
  const rest: Record<string, unknown> = { ...r.value }
  delete rest[h]
  try { atomicWriteSync(cacheFile, JSON.stringify(rest) + '\n') } catch {  }
}

// What the cache holds without running the harness: the version, null for "read, but no version
// found", undefined when the cache has nothing fresh.
export function cachedHarnessVersion(h: Harness, nowMs: number): string | null | undefined {
  const r = readJsonSafeSync<Record<string, { v?: string, at?: number }>>(versionCacheFile())
  const hit = r.ok && isRecord(r.value) ? (r.value as Record<string, { v?: string, at?: number }>)[h] : undefined
  if (hit === undefined || typeof hit.at !== 'number' || nowMs - hit.at >= VERSION_TTL_MS || nowMs < hit.at) return undefined
  return typeof hit.v === 'string' ? hit.v : null
}

export async function harnessVersion(h: Harness, nowMs: number): Promise<string | undefined> {
  const cacheFile = versionCacheFile()
  const r = readJsonSafeSync<Record<string, { v?: string, at?: number }>>(cacheFile)
  const all = r.ok && isRecord(r.value) ? r.value as Record<string, { v?: string, at?: number }> : {}
  const hit = all[h]
  if (hit !== undefined && typeof hit.at === 'number' && nowMs - hit.at < VERSION_TTL_MS && nowMs >= hit.at) return hit.v
  const bin = findExecutable(VERSION_CMD[h])
  if (bin === undefined) return undefined
  const out = await run([bin, '--version'], { timeoutMs: 1500 })
  const v = /(\d+\.\d+\.\d+)/u.exec(`${out.stdout}\n${out.stderr}`)?.[1]
  all[h] = v !== undefined ? { v, at: nowMs } : { at: nowMs }
  try { atomicWriteSync(cacheFile, JSON.stringify(all) + '\n') } catch {  }
  return v
}

export interface MemoryUiRecord { pid: number; port: number; host: string; url: string; startedAt: string; version?: string; build?: string }

export function liveMemoryUi(): MemoryUiRecord | undefined {
  const r = readJsonSafeSync<unknown>(paths.memoryUiStateFile())
  if (!r.ok || !isRecord(r.value)) return undefined
  const v = r.value
  if (typeof v['pid'] !== 'number' || typeof v['port'] !== 'number' || typeof v['url'] !== 'string') return undefined
  if (v['build'] !== undefined && typeof v['build'] !== 'string') return undefined
  try { process.kill(v['pid'], 0) } catch (e) { if ((e as { code?: string }).code !== 'EPERM') return undefined }
  return v as unknown as MemoryUiRecord
}

export function ensureMemoryUi(nowMs: number, opts: { sessionStarting?: boolean } = {}): void {
  if (process.env['BURACLE_NO_AUTOSTART'] === '1') return
  const live = liveMemoryUi()
  if (live !== undefined && sameUiBuild(live.build, uiBuildId())) return
  if (opts.sessionStarting !== true && !captureOff() && !anySessionOpen(nowMs)) return
  const marker = join(paths.stateDir(), 'memory-ui.spawn')
  try {
    if (existsSync(marker) && nowMs - statSync(marker).mtimeMs < 60_000) return
    atomicWriteSync(marker, String(nowMs))
  } catch { return }
  try {
    const argv = buracleArgv()
    if (argv === undefined) return
    const spawned = spawnArgv([...argv, 'mem', 'ui', '--serve', '--for-session'])
    const child = Bun.spawn(spawned, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true, cwd: paths.home(), env: { ...process.env }, windowsVerbatimArguments: windowsVerbatim(spawned) })
    child.unref()
  } catch {  }
}

export function buracleArgv(): string[] | undefined {
  const main = join(paths.repoRoot(), 'src', 'cli', 'main.ts')
  const bun = findExecutable('bun')
  if (bun !== undefined && existsSync(main)) return [bun, main]
  return shimLaunch()
}

export async function barInfo(h: Harness, o: { nowMs: number, version?: string, memoryUi: { port: number }, lines?: { added: number, removed: number } }): Promise<BarInfo> {
  const info: BarInfo = { product: { name: 'Buracle', version: buracleVersion() } }
  const version = o.version ?? await harnessVersion(h, o.nowMs).catch(() => undefined)
  const harness: NonNullable<BarInfo['harness']> = { label: HARNESS_LABEL[h] }
  if (version !== undefined) harness.version = version
  if (h === 'claude') {
    const plan = claudePlan()
    if (plan !== undefined) harness.plan = plan
  }
  info.harness = harness
  ensureMemoryUi(o.nowMs)
  const live = liveMemoryUi()
  info.memoryUrl = live?.url ?? `http://localhost:${o.memoryUi.port}`
  if (o.lines !== undefined) info.lines = o.lines
  return info
}
