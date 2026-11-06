// The running shared backends and the other Buracle MCP processes, for `buracle mcp status|stop` and doctor.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as paths from '../paths'
import { pidAlive } from './common'

export interface BackendState {
  file: string
  id: string
  key: string
  pid: number
  upstreamPid?: number
  startedAt?: number
  log?: string
  clients: number[]
  idleSince?: number
}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

/** The state files of the shared backends, in the run directory and its /tmp fallback. */
export function backendStates(): BackendState[] {
  const out: BackendState[] = []
  for (const dir of [paths.mcpRunDir(), paths.mcpFallbackRunDir()]) {
    let names: string[]
    try { names = readdirSync(dir) } catch { continue }
    for (const name of names.filter(n => n.endsWith('.json')).sort()) {
      const file = join(dir, name)
      let raw: unknown
      try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
      if (!isObj(raw) || typeof raw['id'] !== 'string' || typeof raw['key'] !== 'string' || typeof raw['pid'] !== 'number') continue
      const s: BackendState = { file, id: raw['id'], key: raw['key'], pid: raw['pid'], clients: Array.isArray(raw['clients']) ? raw['clients'].filter((c): c is number => typeof c === 'number') : [] }
      if (typeof raw['upstreamPid'] === 'number') s.upstreamPid = raw['upstreamPid']
      if (typeof raw['startedAt'] === 'number') s.startedAt = raw['startedAt']
      if (typeof raw['log'] === 'string') s.log = raw['log']
      if (typeof raw['idleSince'] === 'number') s.idleSince = raw['idleSince']
      out.push(s)
    }
  }
  return out
}

export interface PsRow { pid: number, ppid: number, rssKb: number, etime: string, command: string }

export type McpRole = 'forwarder' | 'backend' | 'upstream' | 'lazy' | 'session' | 'codegraph'
export interface McpProcess extends PsRow { role: McpRole, server: string }

/** Rows of `ps -axo pid=,ppid=,rss=,etime=,command=`. */
export function parsePs(text: string): PsRow[] {
  const out: PsRow[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (m === null) continue
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), etime: m[4] as string, command: m[5] as string })
  }
  return out
}

const BURACLE_ARGS = /(?:^|\s)(?:\S*\/)?(?:buracle(?:\.ts)?|main\.ts)\s+(mcp (backend|run) (\S+)|mcp memory|lsp mcp)(?:\s|$)/
const CODEGRAPH = /codegraph(?:-[a-z]+-[a-z0-9]+)?\/.*\bserve --mcp\b|@colbymchenry\/codegraph\b.*\bserve --mcp\b/

/**
 * The Buracle MCP processes among `rows`, each with its role: `backend` (`mcp backend <id>`), `forwarder`
 * (`mcp run <id>`), `upstream` (a child of a backend), `lazy` (a child of a forwarder of a lazy server),
 * `session` (`mcp memory`, `lsp mcp`) and `codegraph` (its proxy or per-project daemon). A server that took
 * over `mcp run` itself looks like any other program and is not listed.
 */
export function classifyMcpProcesses(rows: readonly PsRow[], lazyIds: ReadonlySet<string>): McpProcess[] {
  const out: McpProcess[] = []
  const byPid = new Map<number, McpProcess>()
  for (const r of rows) {
    const m = BURACLE_ARGS.exec(r.command)
    let p: McpProcess | undefined
    if (m !== null) {
      if (m[2] === 'backend') p = { ...r, role: 'backend', server: m[3] as string }
      else if (m[2] === 'run') p = { ...r, role: 'forwarder', server: m[3] as string }
      else p = { ...r, role: 'session', server: m[1] === 'mcp memory' ? 'buracle-memory' : 'lsp' }
    } else if (CODEGRAPH.test(r.command)) p = { ...r, role: 'codegraph', server: 'codegraph' }
    if (p !== undefined) { out.push(p); byPid.set(p.pid, p) }
  }
  for (const r of rows) {
    if (byPid.has(r.pid)) continue
    const parent = byPid.get(r.ppid)
    if (parent?.role === 'backend') out.push({ ...r, role: 'upstream', server: parent.server })
    else if (parent?.role === 'forwarder' && lazyIds.has(parent.server)) out.push({ ...r, role: 'lazy', server: parent.server })
  }
  return out
}

/** This user's Buracle MCP processes running now: `ps` (LC_ALL=C, at most 2 s) classified with the catalog's lazy servers. */
export function listMcpProcesses(lazyIds: ReadonlySet<string>): McpProcess[] {
  try {
    // Only this user's: another user's processes are not ours to report or stop.
    const uid = process.getuid?.()
    const who = uid === undefined ? ['-ax'] : ['-U', String(uid)]
    const r = Bun.spawnSync(['ps', ...who, '-o', 'pid=,ppid=,rss=,etime=,command='],{ stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: 2_000, env: { ...process.env, LC_ALL: 'C' } })
    if (r.exitCode !== 0) return []
    return classifyMcpProcesses(parsePs(new TextDecoder().decode(r.stdout)), lazyIds)
  } catch {
    return []
  }
}

export interface OrphanCheck { level: 'ok' | 'warn', check: string, detail: string }

/**
 * Doctor's `processes` check: each Buracle MCP process that no live harness needs, with the command that
 * stops it. A per-session process (forwarder, lazy child, memory, lsp, codegraph proxy) whose parent is pid 1
 * or has no harness ancestor; a backend idle for longer than the linger time plus 15 s; an upstream whose
 * backend is gone. codegraph's per-project daemon outlives its clients by design and is never reported.
 */
export function orphanChecks(procs: readonly McpProcess[], states: readonly BackendState[], o: { now: number, lingerMs: number, hasHarness: (pid: number) => boolean, alive: (pid: number) => boolean }): OrphanCheck[] {
  const warn: OrphanCheck[] = []
  const perSession = (p: McpProcess) => p.role === 'forwarder' || p.role === 'lazy' || p.role === 'session' || (p.role === 'codegraph' && !/--path\b/.test(p.command))
  for (const p of procs) {
    if (!perSession(p)) continue
    if (p.ppid === 1 || !o.hasHarness(p.pid)) warn.push({ level: 'warn', check: 'processes', detail: `${p.server} ${p.role} ${p.pid} has no live harness; stop it with \`kill ${p.pid}\`` })
  }
  for (const s of states) {
    if (o.alive(s.pid)) {
      if (s.idleSince !== undefined && o.now - s.idleSince > o.lingerMs + 15_000) warn.push({ level: 'warn', check: 'processes', detail: `the ${s.id} backend ${s.pid} has had no client for ${Math.round((o.now - s.idleSince) / 1000)} s; stop it with \`buracle mcp stop ${s.id}\`` })
    } else if (s.upstreamPid !== undefined && o.alive(s.upstreamPid)) {
      warn.push({ level: 'warn', check: 'processes', detail: `the ${s.id} upstream ${s.upstreamPid} outlived its backend; stop it with \`kill ${s.upstreamPid}\`` })
    }
  }
  if (warn.length > 0) return warn
  const counts = new Map<McpRole, number>()
  for (const p of procs) counts.set(p.role, (counts.get(p.role) ?? 0) + 1)
  const text = [...counts].sort().map(([r, n]) => `${n} ${r}`).join(', ')
  return [{ level: 'ok', check: 'processes', detail: text === '' ? 'no Buracle MCP process runs' : `every Buracle MCP process has a live harness (${text})` }]
}

/** Sends SIGTERM to the live shared backends (all, or the ones of `id`) and returns their pids. */
export function signalBackends(id?: string): number[] {
  const pids: number[] = []
  for (const s of backendStates()) {
    if (id !== undefined && s.id !== id) continue
    if (!pidAlive(s.pid)) continue
    try { process.kill(s.pid, 'SIGTERM'); pids.push(s.pid) } catch {  }
  }
  return pids
}
