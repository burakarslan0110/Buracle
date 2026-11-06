import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StartGate, StartGateOptions } from '../../workflow/workspace-index'
import type { CommandIO } from '../router'

export const name = 'mcp'
export const summary = 'Run, share, turn off and inspect Buracle\'s MCP servers and set their API keys (buracle mcp run <id>, disable, status, key)'
export const usage = `Usage: buracle mcp memory
       buracle mcp run <id>
       buracle mcp disable <id> [--harness <h>]
       buracle mcp enable <id> [--harness <h>]
       buracle mcp list [--json]
       buracle mcp status [--json]
       buracle mcp stop [<id>]
       buracle mcp key [<id> [<key>]] [--clear] [--json]
       buracle mcp install <id>
       buracle mcp backend <id> [--package-version=<v>] [--api-key-env=<name>]

memory    Starts the buracle-memory MCP server on stdin/stdout (newline-delimited JSON-RPC 2.0)
          over the CortexDB brains of the current project and the person. Tools: memory_search,
          memory_get, memory_write, memory_update, memory_status, memory_context. It stops when
          stdin closes.
run <id>  A server with a shared backend (context7, semble, web-search, web-fetch) stays a thin
          forwarder: it answers initialize and tools/list from a cache and connects to the one
          backend of the machine on the first real call (starting it when none runs); after 10
          idle minutes (BURACLE_MCP_IDLE_MS) it lets go of it. chrome-devtools starts as this
          process's child on its first call and stops after 10 idle minutes. Every other package
          server, and every server with mcp.shared: false, starts as before: the copy
          \`buracle install\` put in ~/.buracle/toolchain (newest release), which takes over this
          process, else the package
          runner (npx with Buracle's own npm cache, or uvx on Python 3.12) as a child while a
          background install fills the toolchain for the next start. codegraph in a project
          without an index first starts Buracle's index run (index.auto) and waits up to 4 s while
          it builds, so the server usually starts with the index in place and still answers within
          the 5 s Claude Code gives an always-loaded server. A server that cannot start, or exits
          with an error while starting, is marked down in ~/.buracle/state/health.json for 10
          minutes, so routing sends the built-in tool it stands in for to the next fallback until
          then (web-fetch: the built-in fetch; web-search: web-fetch, then the built-in web
          search).
install <id>  Installs package server <id> into ~/.buracle/toolchain, as \`buracle install\`
          would (the background install of \`run\` uses it). Quiet; BURACLE_NO_TOOLCHAIN=1 skips it.
          Exit codes: 0 installed or already there, 1 error, 2 the install failed.
disable <id> [--harness <h>]  Turns server <id> off in every harness it ships to, or in <h>
          only: mcp.off.<harness> in config.yaml, then \`buracle install\` of those harnesses writes
          each one's own setting. Their next session lists none of its tools and starts no
          process for it, and routing allows the built-in tool it stands in for. Exit codes: 0
          done or nothing to change, 1 bad input, 2 a harness was running or a file conflicts.
enable <id> [--harness <h>]   Turns it on again, the same way.
list      Every server, its state per harness (on, off, - when it does not ship there) and
          the command that starts it now.
status    Every running Buracle MCP process: server, role (forwarder, backend, upstream,
          lazy, session, codegraph), sessions, memory and uptime.
stop [<id>]  Stops the shared backends (or the one of <id>) now; the next call starts them again.
key <id> [<key>]  Stores the API key of server <id> (context7: CONTEXT7_API_KEY) in
          ~/.buracle/secrets/mcp-keys.json, which only this user can read, and stops the running
          backends of <id>, so the next call of every session starts the server with the key (a
          call that runs at that moment fails once). Without <key> it reads the key from piped
          input (pbpaste | buracle mcp key context7; on Linux wl-paste or xclip -o), which keeps
          it out of the shell history. The variable in a session's environment wins over the
          stored key, and sessions with different keys get separate backends. --clear
          removes the stored key. Without <id> it lists the servers that take a key and where
          each key comes from: env, stored or none.
backend <id>  The shared backend a forwarder starts: one upstream for every session, on a
          private Unix socket; it stops 60 s after its last client (BURACLE_MCP_LINGER_MS).
          --package-version is the version the forwarder read (latest for none): the socket
          key both sides use, even when the toolchain changed in between. --api-key-env names
          the variable that holds the API key the forwarder resolved; the key is part of the
          socket key too.
`

function version(): string {
  try {
    return (JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function backgroundInstallArgv(main: string, id: string): string[] {
  return [process.execPath, main, 'mcp', 'install', id]
}

async function installServer(id: string | undefined, io: CommandIO): Promise<number> {
  if (id === undefined) { io.stderr.write(`buracle mcp install: missing <id>\n\n${usage}`); return 1 }
  if (process.env['BURACLE_NO_TOOLCHAIN'] === '1') return 0
  const { readMcpCatalog } = await import('../../engine/toolchain/launch')
  const { isPackageServer } = await import('../../core/catalog')
  let spec
  try {
    spec = readMcpCatalog().servers[id]
  } catch (e) {
    io.stderr.write(`buracle mcp install: ${errText(e)}\n`)
    return 1
  }
  if (spec === undefined || !isPackageServer(spec)) { io.stderr.write(`buracle mcp install: '${id}' is not a package server of canonical/mcp.yaml\n`); return 1 }
  const { loadConfigSync } = await import('../../engine/config')
  const { runToolchainLive } = await import('../ui/toolchain-live')
  const { blockingProblems } = await import('../../engine/toolchain/index')
  const cfg = loadConfigSync().config
  const r = await runToolchainLive({ install: true, upgrade: cfg.toolchain.upgrade, system: false, checkLatest: true, only: [`mcp:${id}`] }, io, { quiet: true })
  if ('error' in r) { io.stderr.write(`buracle mcp install: ${r.error}\n`); return 1 }
  const failed = blockingProblems(r.items).concat(r.items.filter(i => !i.required && i.status === 'failed'))
  for (const i of failed) io.stderr.write(`buracle mcp install: ${i.label}: ${i.detail}\n`)
  return failed.length > 0 ? 2 : 0
}

async function backgroundInstall(id: string): Promise<void> {
  const { existsSync, mkdirSync, statSync, writeFileSync } = await import('node:fs')
  const paths = await import('../../engine/paths')
  const marker = join(paths.stateDir(), `toolchain.spawn.${id}`)
  try {
    if (existsSync(marker) && Date.now() - statSync(marker).mtimeMs < 10 * 60_000) return
    mkdirSync(paths.stateDir(), { recursive: true })
    writeFileSync(marker, String(Date.now()))
  } catch { return }
  const main = join(import.meta.dir, '..', 'main.ts')
  try {
    const child = Bun.spawn(backgroundInstallArgv(main, id), {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true, cwd: paths.home(), env: { ...process.env, BURACLE_TOOLCHAIN_BACKGROUND: '1' },
    })
    child.unref()
  } catch {  }
}

export const CODEGRAPH_GATE_MS = 4_000

export async function codegraphGate(cwd: string, o: Omit<StartGateOptions, 'timeoutMs'> = {}): Promise<StartGate | undefined> {
  const { log } = await import('../../engine/log')
  try {
    const { codegraphStartGate } = await import('../../workflow/workspace-index')
    const r = await codegraphStartGate(cwd, { ...o, timeoutMs: CODEGRAPH_GATE_MS })
    if (r.waitedMs > 0) log('info', 'mcp run: waited for the first codegraph index', { root: r.root, outcome: r.outcome, ms: r.waitedMs })
    return r
  } catch (e) {
    log('warn', 'mcp run: the codegraph start gate failed', { error: e })
    return undefined
  }
}

export const LAUNCH_DOWN_TTL_MS = 10 * 60_000
export const STARTUP_WINDOW_MS = 60_000

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function editMcpHealth(nowMs: number, edit: (mcp: Record<string, unknown>) => boolean): Promise<void> {
  const { log } = await import('../../engine/log')
  try {
    const paths = await import('../../engine/paths')
    const { atomicWriteSync, ensureDirSync, readJsonSafeSync } = await import('../../engine/fsx')
    const { withFileLock } = await import('../../workflow/session-store')
    const file = paths.healthFile()
    ensureDirSync(paths.stateDir())
    withFileLock(file, () => {
      const r = readJsonSafeSync<unknown>(file)
      let doc: Record<string, unknown>
      if (r.ok && isRecord(r.value)) doc = { ...r.value }
      else if (!r.ok && r.code === 'missing') doc = { v: 1, checked_at: new Date(nowMs).toISOString() }
      else return
      const mcp: Record<string, unknown> = isRecord(doc['mcp']) ? { ...doc['mcp'] } : {}
      if (!edit(mcp)) return
      doc['mcp'] = Object.fromEntries(Object.keys(mcp).sort().map(k => [k, mcp[k]]))
      atomicWriteSync(file, JSON.stringify(doc, null, 2) + '\n')
    })
  } catch (e) {
    log('warn', 'mcp run: health.json was not updated', { error: e })
  }
}

export async function recordLaunchFailure(id: string, error: string, nowMs: number): Promise<void> {
  await editMcpHealth(nowMs, mcp => {
    const prev = mcp[id]
    const entry = isRecord(prev) ? prev : {}
    const status = typeof prev === 'string' ? prev : entry['status']
    if (status === 'down' && entry['until'] === undefined) return false
    mcp[id] = { ...entry, status: 'down', error: error.slice(0, 300), checked_at: new Date(nowMs).toISOString(), until: new Date(nowMs + LAUNCH_DOWN_TTL_MS).toISOString(), source: 'launch' }
    return true
  })
}

function launchRecordExpired(v: unknown, nowMs: number): boolean {
  if (!isRecord(v) || v['source'] !== 'launch' || v['status'] !== 'down' || typeof v['until'] !== 'string') return false
  const until = Date.parse(v['until'])
  return Number.isFinite(until) && until <= nowMs
}

export async function expireLaunchFailures(nowMs: number): Promise<void> {
  try {
    // A plain read first: a shared server's forwarder lives for the whole session, and the file helpers load node:crypto.
    const paths = await import('../../engine/paths')
    const value = JSON.parse(readFileSync(paths.healthFile(), 'utf8')) as unknown
    if (!isRecord(value) || !isRecord(value['mcp']) || !Object.values(value['mcp']).some(v => launchRecordExpired(v, nowMs))) return
  } catch { return }
  await editMcpHealth(nowMs, mcp => {
    let changed = false
    for (const [id, v] of Object.entries(mcp)) {
      if (!launchRecordExpired(v, nowMs) || !isRecord(v)) continue
      const { until: _until, source: _source, error: _error, ...rest } = v
      mcp[id] = { ...rest, status: 'unknown', checked_at: new Date(nowMs).toISOString() }
      changed = true
    }
    return changed
  })
}

async function spawnServer(id: string, argv: readonly string[], env: Record<string, string | undefined>, io: CommandIO): Promise<number> {
  const started = Date.now()
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn([...argv], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env })
  } catch (e) {
    const error = `cannot start ${argv[0] ?? id}: ${errText(e)}`
    io.stderr.write(`buracle mcp run: ${error}\n`)
    await recordLaunchFailure(id, error, Date.now())
    return 1
  }
  let forwarded = false
  const forward = (sig: NodeJS.Signals) => () => { forwarded = true; try { child.kill(sig) } catch {  } }
  const handlers: Array<[NodeJS.Signals, () => void]> = (['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]).map(s => [s, forward(s)])
  for (const [s, h] of handlers) { try { process.on(s, h) } catch {  } }
  const code = await child.exited
  for (const [s, h] of handlers) process.off(s, h)
  const ms = Date.now() - started
  if (code !== 0 && child.signalCode === null && !forwarded && ms < STARTUP_WINDOW_MS) {
    await recordLaunchFailure(id, `the server exited with code ${code} ${Math.round(ms / 100) / 10} s after it started`, Date.now())
  }
  return typeof code === 'number' ? code : 1
}

async function runServer(id: string | undefined, io: CommandIO): Promise<number> {
  if (id === undefined) { io.stderr.write(`buracle mcp run: missing <id>\n\n${usage}`); return 1 }
  // The process entry takes this path before the router (src/cli/router.ts, runProcess); here for a caller of run().
  const { fastMcpRun } = await import('../mcp-run')
  const fast = await fastMcpRun(['mcp', 'run', id], line => io.stdout.write(line))
  if (fast !== undefined) return fast
  const { log } = await import('../../engine/log')
  const { launchPlan, readMcpCatalog } = await import('../../engine/toolchain/launch')
  const { readToolchainState } = await import('../../engine/toolchain/state')
  const { isPackageServer } = await import('../../core/catalog')
  let spec
  try {
    spec = readMcpCatalog().servers[id]
  } catch (e) {
    io.stderr.write(`buracle mcp run: ${errText(e)}\n`)
    return 1
  }
  if (spec === undefined) { io.stderr.write(`buracle mcp run: unknown server '${id}'\n`); return 1 }
  await expireLaunchFailures(Date.now())
  const plan = launchPlan(id, spec, readToolchainState())
  if ('error' in plan) {
    io.stderr.write(`buracle mcp run: ${plan.error}\n`)
    log('error', 'mcp run: cannot start the server', { id, error: plan.error })
    if (isPackageServer(spec)) await recordLaunchFailure(id, plan.error, Date.now())
    return 1
  }
  if (plan.source === 'fallback' && process.env['BURACLE_NO_TOOLCHAIN'] !== '1') {
    log('info', 'mcp run: not in the toolchain yet; starting through the package runner and installing in the background', { id })
    await backgroundInstall(id)
  }
  if (id === 'codegraph') await codegraphGate(process.cwd())
  const env: Record<string, string | undefined> = { ...process.env, ...plan.env }
  // A server that starts `node`, `npx` or `uvx` itself finds the copies Buracle downloaded when the system has none.
  const { withSystemTools } = await import('../../engine/toolchain/packages')
  const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = withSystemTools(env[pathKey])
  if (plan.source === 'toolchain') {
    const { execServer } = await import('../../engine/platform')
    const failed = execServer(plan.argv, env)
    if (failed !== undefined) log('warn', 'mcp run: could not hand the process over to the server; starting it as a child', { id, error: failed })
  }
  return spawnServer(id, plan.argv, env, io)
}

async function listServers(argv: string[], io: CommandIO): Promise<number> {
  const json = io.flags.json || argv.includes('--json')
  const { launchPlan, readMcpCatalog } = await import('../../engine/toolchain/launch')
  const { readToolchainState } = await import('../../engine/toolchain/state')
  const { isPackageServer } = await import('../../core/catalog')
  const { HARNESSES } = await import('../../core/events')
  const { loadConfigSync } = await import('../../engine/config')
  const catalog = readMcpCatalog()
  const state = readToolchainState()
  const off = loadConfigSync().config.mcp.off
  const rows = Object.keys(catalog.servers).sort().map(id => {
    const spec = catalog.servers[id]!
    const harnesses = Object.fromEntries(HARNESSES.map(h => [h, !spec.harnesses.includes(h) ? 'none' : off[h].includes(id) ? 'off' : 'on']))
    if (spec.transport === 'http') return { id, transport: 'http', source: 'remote', start: spec.url ?? '', harnesses }
    if (!isPackageServer(spec)) return { id, transport: 'stdio', source: 'buracle', start: [spec.command ?? '', ...(spec.args ?? [])].join(' '), harnesses }
    const p = launchPlan(id, spec, state)
    return 'error' in p ? { id, transport: 'stdio', source: 'missing', start: p.error, harnesses } : { id, transport: 'stdio', source: p.source === 'toolchain' ? `toolchain ${p.version ?? ''}`.trim() : 'fallback', start: p.argv.join(' '), harnesses }
  })
  if (json) { io.stdout.write(JSON.stringify({ servers: rows }, null, 2) + '\n'); return 0 }
  const w = Math.max('server'.length, ...rows.map(r => r.id.length)) + 2
  const cols = HARNESSES.map(h => h.length + 2)
  const cell = (v: string) => (v === 'none' ? '-' : v)
  io.stdout.write(`${'server'.padEnd(w)}${HARNESSES.map((h, i) => h.padEnd(cols[i] as number)).join('')}${'source'.padEnd(18)}start\n`)
  for (const r of rows) io.stdout.write(`${r.id.padEnd(w)}${HARNESSES.map((h, i) => cell(String(r.harnesses[h])).padEnd(cols[i] as number)).join('')}${r.source.padEnd(18)}${r.start}\n`)
  return 0
}

async function statusCmd(argv: string[], io: CommandIO): Promise<number> {
  const json = io.flags.json || argv.includes('--json')
  const { readMcpCatalog } = await import('../../engine/toolchain/launch')
  const { backendStates, listMcpProcesses } = await import('../../engine/mcp-share/procs')
  const { nearestHarnessAncestor } = await import('../../workflow/session-store')
  const catalog = readMcpCatalog()
  const lazy = new Set(Object.keys(catalog.servers).filter(id => catalog.servers[id]?.backend === 'lazy'))
  const states = new Map(backendStates().map(s => [s.pid, s]))
  const rows = listMcpProcesses(lazy).map(p => {
    const st = p.role === 'backend' ? states.get(p.pid) : undefined
    const sessions: number[] | string = st !== undefined ? st.clients : p.ppid <= 1 ? 'none' : (nearestHarnessAncestor(process.env, { startPid: p.ppid }) ?? 'none')
    return { server: p.server, role: p.role, pid: p.pid, ppid: p.ppid, sessions, rssMb: Math.round(p.rssKb / 102.4) / 10, uptime: p.etime, ...(st?.log !== undefined ? { log: st.log } : {}) }
  })
  if (json) { io.stdout.write(JSON.stringify({ processes: rows }, null, 2) + '\n'); return 0 }
  if (rows.length === 0) { io.stdout.write('no Buracle MCP process runs\n'); return 0 }
  const w = Math.max(...rows.map(r => r.server.length)) + 2
  io.stdout.write(`${'server'.padEnd(w)}${'role'.padEnd(11)}${'pid'.padEnd(8)}${'sessions'.padEnd(14)}${'MB'.padEnd(8)}${'uptime'.padEnd(12)}log\n`)
  for (const r of rows) io.stdout.write(`${r.server.padEnd(w)}${r.role.padEnd(11)}${String(r.pid).padEnd(8)}${(Array.isArray(r.sessions) ? `${r.sessions.length} session(s)` : r.sessions).padEnd(14)}${String(r.rssMb).padEnd(8)}${r.uptime.padEnd(12)}${r.log ?? ''}\n`)
  return 0
}

/** Stops the live shared backends (all, or the ones of `id`): SIGTERM, then SIGKILL after 5 s. Returns them as `<id> backend <pid>`. */
async function stopBackends(id: string | undefined): Promise<string[]> {
  const { backendStates, signalBackends } = await import('../../engine/mcp-share/procs')
  const { pidAlive } = await import('../../engine/mcp-share/common')
  const ids = new Map(backendStates().map(s => [s.pid, s.id]))
  const pids = signalBackends(id)
  const end = Date.now() + 5_000
  while (Date.now() < end && pids.some(pidAlive)) await Bun.sleep(50)
  for (const pid of pids) if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL') } catch {  } }
  return pids.map(p => `${ids.get(p) ?? '?'} backend ${p}`)
}

async function stopCmd(id: string | undefined, io: CommandIO): Promise<number> {
  const stopped = await stopBackends(id)
  if (stopped.length === 0) { io.stdout.write(id !== undefined ? `no shared backend of ${id} runs\n` : 'no shared backend runs\n'); return 0 }
  io.stdout.write(`stopped ${stopped.join(', ')}; the next call starts it again\n`)
  return 0
}

/** Far above any real API key; a longer value is a paste gone wrong and would only fail later, as an environment variable. */
const MAX_API_KEY_LENGTH = 4096

async function keyCmd(argv: string[], io: CommandIO): Promise<number> {
  const json = io.flags.json || argv.includes('--json')
  const [, id, given] = argv.filter(a => !a.startsWith('-'))
  const { readMcpCatalog } = await import('../../engine/toolchain/launch')
  const { apiKeyFor, maskKey, writeStoredKey } = await import('../../engine/mcp-share/keys')
  const { mcpKeysFile } = await import('../../engine/paths')
  let catalog
  try {
    catalog = readMcpCatalog()
  } catch (e) {
    io.stderr.write(`buracle mcp key: ${errText(e)}\n`)
    return 1
  }
  const servers = catalog.servers
  const describe = (s: string) => {
    const spec = servers[s]!
    const key = apiKeyFor(s, spec, process.env)
    const row = { id: s, env: spec.api_key?.env ?? '', source: key?.source ?? 'none', ...(spec.api_key?.url !== undefined ? { url: spec.api_key.url } : {}) }
    const text = key === undefined ? `not set${row.url !== undefined ? `; get one at ${row.url}` : ''}` : `${key.source === 'env' ? 'from the environment' : 'stored'} (${maskKey(key.value)})`
    return { row, line: `${s.padEnd(12)}${row.env.padEnd(20)}${text}\n` }
  }
  if (id === undefined) {
    const keyed = Object.keys(servers).sort().filter(s => servers[s]?.api_key !== undefined).map(describe)
    if (json) { io.stdout.write(JSON.stringify({ servers: keyed.map(k => k.row) }, null, 2) + '\n'); return 0 }
    io.stdout.write(`${'server'.padEnd(12)}${'variable'.padEnd(20)}key\n${keyed.map(k => k.line).join('')}`)
    return 0
  }
  const spec = servers[id]
  if (spec === undefined) { io.stderr.write(`buracle mcp key: unknown server '${id}'\n`); return 1 }
  const name = spec.api_key?.env
  if (name === undefined) { io.stderr.write(`buracle mcp key: ${id} takes no API key\n`); return 1 }
  const clear = argv.includes('--clear')
  let value: string | undefined
  if (!clear) {
    if (given === undefined && io.stdin.isTTY) {
      io.stdout.write(`${describe(id).line}Set it with \`buracle mcp key ${id} <key>\`, or pipe it in to keep it out of the shell history: pbpaste | buracle mcp key ${id}\n`)
      return 0
    }
    value = (given ?? await io.stdin.text()).trim()
    if (value === '') { io.stderr.write('buracle mcp key: empty key; nothing stored\n'); return 1 }
    if (/[\s\u0000-\u001f\u007f]/.test(value)) { io.stderr.write('buracle mcp key: the key holds spaces or control characters; nothing stored\n'); return 1 }
    if (value.length > MAX_API_KEY_LENGTH) { io.stderr.write(`buracle mcp key: the key is longer than ${MAX_API_KEY_LENGTH} characters; nothing stored\n`); return 1 }
  }
  let changed: boolean
  try {
    changed = writeStoredKey(id, value)
  } catch (e) {
    io.stderr.write(`buracle mcp key: cannot write ${mcpKeysFile()}: ${errText(e)}\n`)
    return 1
  }
  if (!changed && value === undefined) { io.stdout.write(`no stored ${id} API key\n`); return 0 }
  // Also when the same key was stored already: a run stopped between the write and this step left the old backends.
  const stopped = await stopBackends(id)
  const next = stopped.length > 0 ? `; stopped ${stopped.join(', ')}, so the next call starts ${id} ${value === undefined ? 'without a stored key' : 'with this key'}` : `; the next call of ${id} uses ${value === undefined ? 'no stored key' : 'it'}`
  const done = value === undefined ? `removed the stored ${id} API key` : changed ? `stored the ${id} API key (${maskKey(value)}) in ${mcpKeysFile()}` : `the ${id} API key (${maskKey(value)}) was already stored`
  io.stdout.write(`${done}${next}\n`)
  const shell = process.env[name]
  if (shell !== undefined && shell.trim() !== '' && shell !== value) io.stdout.write(`note: ${name} is set in this environment; a session that has it uses it instead of the stored key\n`)
  return 0
}

async function runBackend(argv: string[], io: CommandIO): Promise<number> {
  const id = argv.filter(a => !a.startsWith('-'))[1]
  if (id === undefined) { io.stderr.write(`buracle mcp backend: missing <id>\n\n${usage}`); return 1 }
  const pinned = argv.find(a => a.startsWith('--package-version='))?.slice('--package-version='.length)
  const keyEnv = argv.find(a => a.startsWith('--api-key-env='))?.slice('--api-key-env='.length)
  const { runMcpBackend } = await import('../../engine/mcp-share/backend')
  return runMcpBackend(id, { stderr: io.stderr, version: version(), ...(pinned !== undefined && pinned !== '' ? { packageVersion: pinned } : {}), ...(keyEnv !== undefined && keyEnv !== '' ? { apiKeyEnv: keyEnv } : {}), recordFailure: (error, nowMs) => recordLaunchFailure(id, error, nowMs), onFallback: () => backgroundInstall(id) })
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const server = argv.find(a => !a.startsWith('-'))
  if (server === 'run') return runServer(argv.filter(a => !a.startsWith('-'))[1], io)
  if (server === 'backend') return runBackend(argv, io)
  if (server === 'status') return statusCmd(argv, io)
  if (server === 'stop') return stopCmd(argv.filter(a => !a.startsWith('-'))[1], io)
  if (server === 'key') return keyCmd(argv, io)
  if (server === 'disable' || server === 'enable') {
    const at = argv.indexOf('--harness')
    const eq = argv.find(a => a.startsWith('--harness='))
    const harness = eq !== undefined ? eq.slice('--harness='.length) : at >= 0 ? argv[at + 1] : undefined
    const pos = argv.filter((a, i) => !a.startsWith('-') && !(at >= 0 && i === at + 1))
    const { setMcpOff } = await import('../../engine/mcp-off')
    return setMcpOff({ id: pos[1], turnOff: server === 'disable', ...(harness !== undefined ? { harness } : {}) }, io)
  }
  if (server === 'list') return listServers(argv, io)
  if (server === 'install') return installServer(argv.filter(a => !a.startsWith('-'))[1], io)
  if (server !== 'memory') {
    io.stderr.write(server === undefined ? usage : `buracle mcp: unknown server '${server}'\n\n${usage}`)
    return server === undefined ? 0 : 1
  }
  const { runMemoryMcpServer } = await import('../../memory/mcp')
  return runMemoryMcpServer({ version: version(), write: line => io.stdout.write(line) })
}
