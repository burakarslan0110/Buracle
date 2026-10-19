import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CM_SERVER_ID } from '../../core/context-mode'
import type { StartGate, StartGateOptions } from '../../workflow/workspace-index'
import type { CommandIO } from '../router'

export const name = 'mcp'
export const summary = 'Run Buracle\'s stdio MCP servers (buracle mcp memory, buracle mcp run <id>)'
export const usage = `Usage: buracle mcp memory
       buracle mcp run <id>
       buracle mcp install <id>
       buracle mcp list [--json]

memory    Starts the buracle-memory MCP server on stdin/stdout (newline-delimited JSON-RPC 2.0)
          over the CortexDB brains of the current project and the person. Tools: memory_search,
          memory_get, memory_write, memory_update, memory_status, memory_context. It stops when
          stdin closes.
run <id>  Starts package server <id> of canonical/mcp.yaml with stdio passed through: the copy
          \`buracle install\` put in ~/.buracle/toolchain (newest release), which takes over this
          process (no launcher stays behind; on Windows it runs as a child), else the package
          runner (npx with Buracle's own npm cache, or uvx on Python 3.12) as a child while a
          background install fills the toolchain for the next start. codegraph in a project
          without an index first starts Buracle's index run (index.auto) and waits up to 4 s while
          it builds, so the server usually starts with the index in place and still answers within
          the 5 s Claude Code gives an always-loaded server. A server that cannot start, or exits
          with an error while starting, is marked down in ~/.buracle/state/health.json for 10
          minutes, so routing sends the built-in tool it stands in for to the next fallback until
          then (web-fetch: context-mode's ctx_fetch_and_index, then the built-in fetch; web-search:
          web-fetch, then the built-in web search).
          context-mode runs on Bun with its storage under ~/.buracle/context-mode/<harness>/,
          one folder per project. While config contextMode.enabled is false it is served as a
          server without tools instead (nothing is installed or run); a change of the switch
          reaches the server at its next start (a new session or an MCP reconnect).
install <id>  Installs package server <id> into ~/.buracle/toolchain, as \`buracle install\`
          would (the background install of \`run\` uses it). Quiet; BURACLE_NO_TOOLCHAIN=1 skips it.
          Exit codes: 0 installed or already there, 1 error, 2 the install failed.
list      Every server and the command that starts it now.
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
    const paths = await import('../../engine/paths')
    const { readJsonSafeSync } = await import('../../engine/fsx')
    const r = readJsonSafeSync<unknown>(paths.healthFile())
    if (!r.ok || !isRecord(r.value) || !isRecord(r.value['mcp']) || !Object.values(r.value['mcp']).some(v => launchRecordExpired(v, nowMs))) return
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
  const { spawnArgv, windowsVerbatim } = await import('../../engine/platform')
  const started = Date.now()
  let child: ReturnType<typeof Bun.spawn>
  try {
    const spawned = spawnArgv(argv)
    child = Bun.spawn(spawned, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env, windowsVerbatimArguments: windowsVerbatim(spawned) })
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

export async function contextModeOff(): Promise<boolean> {
  try {
    const { loadConfigSync } = await import('../../engine/config')
    return !loadConfigSync().config.contextMode.enabled
  } catch {
    return false
  }
}

export async function contextModeEnv(env: Record<string, string | undefined>, cwd: string): Promise<Record<string, string>> {
  const cm = await import('../../engine/context-mode')
  const out = cm.cmServerEnv(env, { cwd })
  const h = cm.cmHarnessOfPlatform(out['CONTEXT_MODE_PLATFORM'])
  if (h !== undefined) cm.ensureCmDirs(h, cm.cmProjectDir(h, { claudeProjectDir: out['CLAUDE_PROJECT_DIR'], cwd }))
  const stale = cm.cmStaleClaudePlugin(out, { cwd })
  if (stale.length > 0) {
    const { log } = await import('../../engine/log')
    const empty = cm.cmEmptyClaudeConfigDir()
    try { mkdirSync(empty, { recursive: true, mode: 0o700 }) } catch {  }
    out['CLAUDE_CONFIG_DIR'] = empty
    log('warn', "mcp run: Claude Code's plugin registry names context-mode's own plugin in a folder that is gone, and the server would link itself there (Claude Code would then run that plugin's hooks again); the server gets an empty Claude config folder instead. Remove the plugin: `claude plugin uninstall context-mode@context-mode`", { installPaths: stale, claudeConfigDir: empty })
  }
  return out
}

export function startMjsRefusal(id: string, argv: readonly string[]): string | undefined {
  if (id !== CM_SERVER_ID || !argv.some(a => /(?:^|[\\/])start\.mjs$/.test(a))) return undefined
  return `${id}: the installed package starts through start.mjs, which changes harness settings outside Buracle; run \`buracle doctor context-mode\``
}

async function runServer(id: string | undefined, io: CommandIO): Promise<number> {
  const { log } = await import('../../engine/log')
  if (id === undefined) { io.stderr.write(`buracle mcp run: missing <id>\n\n${usage}`); return 1 }
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
  if (id === CM_SERVER_ID && await contextModeOff()) {
    log('info', 'mcp run: contextMode.enabled is false; serving context-mode without tools', { id })
    const { runStubServer } = await import('../../engine/toolchain/stub')
    return runStubServer({ name: id, write: line => io.stdout.write(line) })
  }
  await expireLaunchFailures(Date.now())
  const planned = launchPlan(id, spec, readToolchainState())
  const refused = 'error' in planned ? undefined : startMjsRefusal(id, planned.argv)
  const plan = refused !== undefined ? { error: refused } : planned
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
  const base: Record<string, string | undefined> = { ...process.env, ...plan.env }
  const env: Record<string, string | undefined> = id === CM_SERVER_ID ? await contextModeEnv(base, process.cwd()) : base
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
  const catalog = readMcpCatalog()
  const state = readToolchainState()
  const cmOff = await contextModeOff()
  const rows = Object.keys(catalog.servers).sort().map(id => {
    const spec = catalog.servers[id]!
    if (spec.transport === 'http') return { id, transport: 'http', source: 'remote', start: spec.url ?? '' }
    if (id === CM_SERVER_ID && cmOff) return { id, transport: 'stdio', source: 'disabled', start: 'a server without tools (contextMode.enabled: false)' }
    if (!isPackageServer(spec)) return { id, transport: 'stdio', source: 'buracle', start: [spec.command ?? '', ...(spec.args ?? [])].join(' ') }
    const p = launchPlan(id, spec, state)
    return 'error' in p ? { id, transport: 'stdio', source: 'missing', start: p.error } : { id, transport: 'stdio', source: p.source === 'toolchain' ? `toolchain ${p.version ?? ''}`.trim() : 'fallback', start: p.argv.join(' ') }
  })
  if (json) { io.stdout.write(JSON.stringify({ servers: rows }, null, 2) + '\n'); return 0 }
  const w = Math.max(...rows.map(r => r.id.length)) + 2
  for (const r of rows) io.stdout.write(`${r.id.padEnd(w)}${r.source.padEnd(18)}${r.start}\n`)
  return 0
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const server = argv.find(a => !a.startsWith('-'))
  if (server === 'run') return runServer(argv.filter(a => !a.startsWith('-'))[1], io)
  if (server === 'list') return listServers(argv, io)
  if (server === 'install') return installServer(argv.filter(a => !a.startsWith('-'))[1], io)
  if (server !== 'memory') {
    io.stderr.write(server === undefined ? usage : `buracle mcp: unknown server '${server}'\n\n${usage}`)
    return server === undefined ? 0 : 1
  }
  const { runMemoryMcpServer } = await import('../../memory/mcp')
  return runMemoryMcpServer({ version: version(), write: line => io.stdout.write(line) })
}
