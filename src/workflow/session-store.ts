import { existsSync, lstatSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { Harness } from '../core/events'
import { HARNESSES, isHarness } from '../core/events'
import { configDirOf, harnessProfile, processMatches } from '../core/harness/index'
import type { SessionState } from '../core/plan/state'
import { isPlanFinished } from '../core/plan/state'
import type { RateWindow } from '../core/status/model'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../engine/fsx'
import { log } from '../engine/log'
import { isValidSessionId, memoryStateDir, runDir, sessionDir, sessionsDir } from '../engine/paths'
import { tryLock } from '../memory/lock'

export function freshState(): SessionState {
  return { v: 1, guard: { blocksForPlan: 0, blocksInChain: 0 } }
}

export function statePath(h: Harness, sid: string): string { return join(sessionDir(h, sid), 'state.json') }
export function telemetryPath(h: Harness, sid: string): string { return join(sessionDir(h, sid), 'telemetry.json') }

function isSessionState(x: unknown): x is SessionState {
  if (x === null || typeof x !== 'object') return false
  const s = x as Record<string, unknown>
  const g = s['guard'] as Record<string, unknown> | undefined
  return s['v'] === 1 && g !== undefined && typeof g['blocksForPlan'] === 'number' && typeof g['blocksInChain'] === 'number'
}

export function loadState(h: Harness, sid: string): SessionState {
  const r = readJsonSafeSync<unknown>(statePath(h, sid))
  if (!r.ok) {
    if (r.code !== 'missing') log('warn', 'session state unreadable; using fresh state', { h, sid, error: r.error })
    return freshState()
  }
  if (!isSessionState(r.value)) {
    log('warn', 'session state has an unexpected shape; using fresh state', { h, sid })
    return freshState()
  }
  return r.value
}

export function saveState(h: Harness, sid: string, state: SessionState): void {
  ensureDirSync(sessionDir(h, sid))
  atomicWriteSync(statePath(h, sid), JSON.stringify(state, null, 2) + '\n')
}

export function updateState(h: Harness, sid: string, fn: (s: SessionState) => SessionState, opts: { timeoutMs?: number, staleMs?: number } = {}): SessionState {
  ensureDirSync(sessionDir(h, sid))
  return withFileLock(statePath(h, sid), () => {
    const next = fn(loadState(h, sid))
    saveState(h, sid, next)
    return next
  }, opts.timeoutMs ?? 2000, opts.staleMs ?? 10_000)
}

export const LANE_INFIX = '.lane-'

export function laneSessionId(sid: string, lane: string): string { return `${sid}${LANE_INFIX}${lane}` }

export function laneLead(owner: { harness: Harness, session: string } | null | undefined, s: ResolvedSession | undefined): ResolvedSession | undefined {
  const known = owner !== undefined && owner !== null && HARNESSES.includes(owner.harness) && isValidSessionId(owner.session)
  return known ? { harness: owner.harness, sessionId: owner.session, source: 'lane worktree owner' } : s
}

export function laneSessions(h: Harness, sid: string): Array<{ lane: string, sessionId: string }> {
  if (!isValidSessionId(sid) || sid.includes(LANE_INFIX)) return []
  const prefix = laneSessionId(sid, '')
  let names: string[] = []
  try { names = readdirSync(sessionsDir(h)) } catch { return [] }
  return names.filter(n => n.length > prefix.length && n.startsWith(prefix) && isValidSessionId(n)).sort().map(n => ({ lane: n.slice(prefix.length), sessionId: n }))
}

export function reviewSubjects(h: Harness, sid: string | undefined): string[] {
  if (!isValidSessionId(sid)) return []
  try {
    const out = new Set<string>()
    for (const id of [sid, ...laneSessions(h, sid).map(l => l.sessionId)]) {
      const st = loadState(h, id)
      if (st.plan !== undefined && !isPlanFinished(st)) out.add(st.plan.path)
    }
    return [...out]
  } catch (e) {
    log('debug', 'review subjects unavailable', { h, error: e })
    return []
  }
}

export interface Telemetry {
  v: 1
  harness: Harness
  sessionId: string
  at: number
  model?: string
  modelId?: string
  effort?: string
  ctx?: { pct: number, tokens?: number, window?: number, autoCompactAt?: number }
  windows?: RateWindow[]
  windowsAt?: number
  costUsd?: number
  cwd?: string
  runner?: true
}

export function writeTelemetry(h: Harness, sid: string, t: Omit<Telemetry, 'v' | 'harness' | 'sessionId'>): void {
  ensureDirSync(sessionDir(h, sid))
  const prev = readTelemetry(h, sid)
  const merged: Telemetry = { ...(prev ?? {}), ...t, v: 1, harness: h, sessionId: sid }
  if (process.env['BURACLE_MEMORY_RUNNER'] === '1') merged.runner = true
  atomicWriteSync(telemetryPath(h, sid), JSON.stringify(merged) + '\n')
}

export function readTelemetry(h: Harness, sid: string): Telemetry | undefined {
  const r = readJsonSafeSync<Telemetry>(telemetryPath(h, sid))
  return r.ok && r.value && r.value.v === 1 ? r.value : undefined
}

export const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

function newestMtime(dir: string): number {
  let newest = 0
  try { newest = statSync(dir).mtimeMs } catch { return 0 }
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return newest }
  for (const n of names) {
    try { newest = Math.max(newest, lstatSync(join(dir, n)).mtimeMs) } catch {  }
  }
  return newest
}

function mtimeOf(path: string): number | undefined {
  try { return lstatSync(path).mtimeMs } catch { return undefined }
}

export function pruneSessions(h: Harness, opts: { keep?: Iterable<string>, maxAgeMs?: number, nowMs: number }): string[] {
  const keep = new Set(opts.keep ?? [])
  const maxAge = opts.maxAgeMs ?? SESSION_MAX_AGE_MS
  const removed: string[] = []
  const sessions = sessionsDir(h)
  const run = runDir(h)
  let names: string[] = []
  try { names = readdirSync(sessions) } catch { names = [] }
  for (const sid of names) {
    if (!isValidSessionId(sid) || keep.has(sid)) continue
    const dir = join(sessions, sid)
    try {
      const st = lstatSync(dir)
      if (!st.isDirectory() || st.isSymbolicLink()) continue
      const activity = Math.max(newestMtime(dir), mtimeOf(join(run, `${sid}.json`)) ?? 0)
      if (opts.nowMs - activity < maxAge) continue
      rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch {  }
  }
  try { names = readdirSync(run) } catch { names = [] }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const sid = name.slice(0, -'.json'.length)
    if (!isValidSessionId(sid) || keep.has(sid)) continue
    const file = join(run, name)
    try {
      const st = lstatSync(file)
      if (!st.isFile()) continue
      const activity = Math.max(st.mtimeMs, mtimeOf(join(sessions, sid)) ?? 0)
      if (opts.nowMs - activity < maxAge) continue
      unlinkSync(file)
      removed.push(file)
    } catch {  }
  }
  return removed
}

function spoolActiveDir(): string {
  return join(memoryStateDir(), 'spool')
}

function spoolDoneDir(): string {
  return join(spoolActiveDir(), 'done')
}

function sessionRecordPath(h: Harness, sid: string): string {
  return join(memoryStateDir(), 'sessions', `${h}-${sid}.json`)
}

function pruneSpoolFiles(dir: string, h: Harness, nowMs: number, maxAgeMs: number, keep: (rest: string) => boolean, removed: string[]): void {
  let names: string[] = []
  try { names = readdirSync(dir) } catch { names = [] }
  for (const name of names) {
    if (!name.startsWith(`${h}-`) || !name.endsWith('.jsonl')) continue
    const file = join(dir, name)
    try {
      const st = lstatSync(file)
      if (!st.isFile() || nowMs - st.mtimeMs < maxAgeMs || keep(name.slice(h.length + 1, -'.jsonl'.length))) continue
      unlinkSync(file)
      removed.push(file)
    } catch {  }
  }
}

export function sessionMaint(h: Harness, nowMs: number, opts: { keep?: Iterable<string>, maxAgeMs?: number } = {}): { removed: string[] } {
  const maxAgeMs = opts.maxAgeMs ?? SESSION_MAX_AGE_MS
  const live = new Set(opts.keep ?? [])
  const removed = pruneSessions(h, { keep: live, maxAgeMs, nowMs })
  pruneSessionAliases(h)
  pruneSpoolFiles(spoolDoneDir(), h, nowMs, maxAgeMs, () => false, removed)
  const owned = (rest: string): boolean => {
    for (let i = rest.length; i > 0; i = rest.lastIndexOf('-', i - 1)) {
      const sid = rest.slice(0, i)
      if (live.has(sid) || (isValidSessionId(sid) && existsSync(sessionRecordPath(h, sid)))) return true
    }
    return false
  }
  pruneSpoolFiles(spoolActiveDir(), h, nowMs, maxAgeMs, owned, removed)
  if (removed.length > 0) log('info', 'session maintenance', { h, removed: removed.length })
  return { removed }
}

export function liveHarnessDir(h: Harness, env: Record<string, string | undefined>): string | undefined {
  return configDirOf(harnessProfile(h), env)
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => posix.normalize(p).replace(/(.)\/+$/, '$1')
  return norm(a) === norm(b)
}

export function profileGuard(h: Harness, runtimeCfg: unknown, env: Record<string, string | undefined>): string | undefined {
  const profile = (isHarness(h) ? harnessProfile(h) : undefined)
  if (profile === undefined) return undefined
  const spec = { key: profile.configDir.key, label: profile.label, variable: profile.configDir.env }
  const resolved = runtimeCfg !== null && typeof runtimeCfg === 'object' ? (runtimeCfg as { resolved?: unknown }).resolved : undefined
  const installed = resolved !== null && typeof resolved === 'object' ? (resolved as Record<string, unknown>)[spec.key] : undefined
  if (typeof installed !== 'string' || !posix.isAbsolute(installed)) return undefined
  const live = liveHarnessDir(h, env)
  if (live === undefined || samePath(installed, live)) return undefined
  return `Buracle was installed for ${spec.label} into ${installed}, but this session reads ${live} (${spec.variable}), where Buracle's hooks, rules and settings are missing. Run \`buracle install ${h}\` with this environment, or start ${spec.label} without the override.`
}

export const SESSION_ALIASES_MAX = 500

export function sessionAliasesPath(h: Harness): string { return join(sessionsDir(h), 'aliases.json') }

export function readSessionAliases(h: Harness): Record<string, string> {
  const r = readJsonSafeSync<unknown>(sessionAliasesPath(h))
  if (!r.ok || r.value === null || typeof r.value !== 'object' || Array.isArray(r.value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(r.value as Record<string, unknown>)) {
    if (isValidSessionId(k) && isValidSessionId(v) && k !== v) out[k] = v
  }
  return out
}

export function withFileLock<T>(file: string, fn: () => T, timeoutMs = 2000, staleMs = 10_000): T {
  const lock = `${file}.lock`
  const start = Date.now()
  for (;;) {
    const release = tryLock(lock, staleMs)
    if (release !== undefined) {
      try { return fn() } finally { release() }
    }
    if (Date.now() - start > timeoutMs) throw new Error(`lock busy: ${lock}`)
    Bun.sleepSync(15)
  }
}

export function recordSessionAlias(h: Harness, from: string, to: string): boolean {
  if (!isValidSessionId(from) || !isValidSessionId(to) || from === to) return false
  const file = sessionAliasesPath(h)
  try {
    ensureDirSync(sessionsDir(h))
    return withFileLock(file, () => {
      const cur = readSessionAliases(h)
      if (cur[from] === to) return true
      delete cur[from]
      cur[from] = to
      const keys = Object.keys(cur)
      const kept: Record<string, string> = {}
      for (const k of keys.slice(Math.max(0, keys.length - SESSION_ALIASES_MAX))) kept[k] = cur[k] as string
      atomicWriteSync(file, JSON.stringify(kept, null, 2) + '\n')
      return true
    })
  } catch (e) {
    log('warn', 'session alias not recorded', { h, error: e })
    return false
  }
}

export function pruneSessionAliases(h: Harness): number {
  const file = sessionAliasesPath(h)
  if (!existsSync(file)) return 0
  try {
    return withFileLock(file, () => {
      const cur = readSessionAliases(h)
      const kept: Record<string, string> = {}
      let dropped = 0
      for (const [k, v] of Object.entries(cur)) {
        if (existsSync(sessionDir(h, v))) kept[k] = v
        else dropped++
      }
      if (dropped > 0) atomicWriteSync(file, JSON.stringify(kept, null, 2) + '\n')
      return dropped
    })
  } catch {
    return 0
  }
}

export interface ResolvedSession { harness: Harness, sessionId: string, source: string }

export type AncestorProbe = () => Harness | undefined

export interface ResolveOptions {
  ancestor?: AncestorProbe
}

const NATIVE_CLAIMS: ReadonlyArray<[string, Harness]> = HARNESSES.flatMap(h => harnessProfile(h).sessionEnv.map((name): [string, Harness] => [name, h]))

function harnessName(x: string | undefined): Harness | undefined {
  return x !== undefined && (HARNESSES as readonly string[]).includes(x) ? x as Harness : undefined
}

function validId(env: Record<string, string | undefined>, name: string): string | undefined {
  const v = env[name]
  return v !== undefined && v !== '' && isValidSessionId(v) ? v : undefined
}

export function claimedHarnesses(env: Record<string, string | undefined>): Harness[] {
  const out: Harness[] = []
  const bh = harnessName(env['BURACLE_HARNESS'])
  if (bh !== undefined) out.push(bh)
  for (const [name, h] of NATIVE_CLAIMS) if (validId(env, name) !== undefined && !out.includes(h)) out.push(h)
  return out
}

export function harnessSessionIds(h: Harness, env: Record<string, string | undefined>): Array<{ id: string, source: string }> {
  const bh = harnessName(env['BURACLE_HARNESS'])
  const bsid = validId(env, 'BURACLE_SESSION_ID')
  const buracle = bsid !== undefined && (bh === h || bh === undefined) ? [{ id: bsid, source: 'BURACLE_SESSION_ID' }] : []
  const native = (name: string): Array<{ id: string, source: string }> => {
    const v = validId(env, name)
    return v !== undefined ? [{ id: v, source: name }] : []
  }
  // Codex names a thread, which may be a subagent's: the session it belongs to comes first.
  if (h === 'codex') {
    const out = native('CODEX_SESSION_ID')
    const thread = validId(env, 'CODEX_THREAD_ID')
    if (thread !== undefined) {
      if (out.length === 0) {
        const root = readSessionAliases('codex')[thread]
        if (root !== undefined) out.push({ id: root, source: 'CODEX_THREAD_ID (aliases.json)' })
      }
      out.push({ id: thread, source: 'CODEX_THREAD_ID' })
    }
    return [...out, ...buracle]
  }
  return [...buracle, ...harnessProfile(h).sessionEnv.flatMap(native)]
}

export function harnessOfProcess(comm: string, pid?: number, env: Record<string, string | undefined> = {}): Harness | undefined {
  return HARNESSES.find(h => processMatches(harnessProfile(h), comm, pid, env))
}

function psRow(pid: number): { ppid: number, comm: string } | undefined {
  try {
    const r = Bun.spawnSync(['ps', '-o', 'ppid=,comm=', '-p', String(pid)], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: 1000,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LC_ALL: 'C' },
    })
    if (r.exitCode !== 0) return undefined
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(new TextDecoder().decode(r.stdout).split('\n')[0] ?? '')
    return m ? { ppid: Number(m[1]), comm: m[2] as string } : undefined
  } catch {
    return undefined
  }
}

export function nearestHarnessAncestor(env: Record<string, string | undefined> = process.env, opts: { startPid?: number, maxDepth?: number, budgetMs?: number } = {}): Harness | undefined {
  let pid = opts.startPid ?? process.ppid
  const deadline = Date.now() + (opts.budgetMs ?? 250)
  const maxDepth = opts.maxDepth ?? 24
  for (let depth = 0; depth < maxDepth && pid > 1 && Date.now() <= deadline; depth++) {
    const row = psRow(pid)
    if (row === undefined) return undefined
    const h = harnessOfProcess(row.comm, pid, env)
    if (h !== undefined) return h
    if (row.ppid === pid) return undefined
    pid = row.ppid
  }
  return undefined
}

export function sessionHarness(flags: { harness?: string }, env: Record<string, string | undefined>, opts: ResolveOptions = {}): Harness | undefined {
  const explicit = harnessName(flags.harness)
  if (explicit !== undefined) return explicit
  const claimed = claimedHarnesses(env)
  if (claimed.length <= 1) return claimed[0]
  const nearest = (opts.ancestor ?? (() => nearestHarnessAncestor(env)))()
  return nearest ?? claimed[0]
}

export function resolveSession(flags: { session?: string, harness?: string } = {}, env: Record<string, string | undefined> = process.env, opts: ResolveOptions = {}): ResolvedSession | undefined {
  if (flags.session !== undefined) {
    if (!isValidSessionId(flags.session)) return undefined
    const h = sessionHarness(flags, env, opts)
    return h === undefined ? undefined : { harness: h, sessionId: flags.session, source: '--session' }
  }
  const h = sessionHarness(flags, env, opts)
  if (h === undefined) return undefined
  const best = harnessSessionIds(h, env)[0]
  return best === undefined ? undefined : { harness: h, sessionId: best.id, source: best.source }
}
