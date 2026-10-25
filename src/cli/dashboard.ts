import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpCatalog, McpServerSpec, ToolSpec } from '../core/catalog'
import type { BuracleConfig } from '../core/config'
import { HARNESSES, type Harness } from '../core/events'
import * as paths from '../engine/paths'
import { spawnArgv, windowsVerbatim } from '../engine/platform'
import type { HealthFile } from '../engine/update/mcp'
import { errText } from '../engine/update/output'
import { staleServers, staleTools, updatesStale, type Verifier } from '../engine/update/refresh'
import { parseShimText, type RuntimeHealth } from '../engine/update/runtime'
import type { UpdateItem, UpdateKind, UpdatesCache } from '../engine/update/updates-cache'
import type { ToolchainState } from '../engine/toolchain/state'
import { dashboardStep, initialView, renderDashboard, type DashAction, type DashRow, type DashView, type RowState } from './ui/dashboard'
import { initialMenu, menuStep, renderMenu, type MenuAction, type MenuView } from './ui/menu'
import { colorLevel, makeStyle, type Style } from './ui/style'
import type { Terminal } from './ui/terminal'

export const REEXEC_ENV = 'BURACLE_DASHBOARD_REEXEC'
export const MIN_SIZE = { columns: 40, rows: 10 } as const

const LABEL: Readonly<Record<Harness, string>> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', omp: 'Oh My Pi' }
const BIN: Readonly<Record<Harness, string>> = { claude: 'claude', codex: 'codex', opencode: 'opencode', omp: 'omp' }

export interface DashData { version: string; rows: DashRow[]; checkedAt?: string; working?: string }

// read() is what the files say right now (no network, no harness binary); fill() reads the slow
// facts in the background and hands over the new rows each time one arrives. With a verifier it also
// re-checks what is stale (all of it with `force`), one verification at a time: asking again while one
// runs starts nothing, and the newest `changed` hears its results.
export interface DashSource {
  read(): DashData
  fill(changed: (d: DashData) => void, opts?: { force?: boolean }): Promise<void>
}

export interface ChildHandle { exited: Promise<number>; kill(sig: 'SIGINT' | 'SIGTERM'): void }
export interface SigintHost { on(sig: 'SIGINT', f: () => void): unknown; off(sig: 'SIGINT', f: () => void): unknown }

export interface DashboardDeps {
  terminal: Terminal
  spawn: (argv: readonly string[], env: Record<string, string | undefined>) => ChildHandle
  now: () => number
  source?: DashSource
  command?: readonly string[] // how a Buracle command runs: [bun, main.ts]
  shim?: () => { path: string, main: string } | undefined
  env?: Readonly<Record<string, string | undefined>>
  signals?: SigintHost
  write?: (s: string) => void
  style?: Style
}

interface Facts {
  nowMs: number
  version: string
  config: BuracleConfig
  installed: ReadonlySet<string>
  bins: Partial<Record<Harness, string>>
  origins: Partial<Record<Harness, string>>
  versions: Partial<Record<Harness, string | null>> // null: read, but no version found; missing: still reading
  updates?: UpdatesCache
  health?: HealthFile
  mcpHealth: Record<string, 'ok' | 'down' | 'unknown'>
  toolchain: ToolchainState
  mcp?: McpCatalog
  tools: ToolSpec[]
  toolPackage: (t: ToolSpec) => { version: string, registry: string, name: string } | undefined
  ui?: string
  cortexdb?: string
  runtime?: RuntimeHealth | null // null: could not be checked; missing: still checking
  shim: boolean // the buracle shim exists; the servers Buracle itself runs start through it
  checking: ReadonlySet<string> // row ids ('mcp:<id>', 'tool:<name>') and 'updates' being verified right now
  failed: ReadonlyMap<string, string> // the same ids whose verification itself broke, with why
}

const tilde = (p: string): string => (p.startsWith(paths.home()) ? `~${p.slice(paths.home().length)}` : p)
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
// With toolchain.autoInstall off, `buracle install` skips the toolchain, so i alone installs nothing.
const toolchainHint = (f: Facts): string => (f.config.toolchain.autoInstall ? 'press i to install it' : 'toolchain.autoInstall is off: turn it on (buracle config set toolchain.autoInstall true), then press i')

function updateOf(f: Facts, kind: UpdateKind, id: string): UpdateItem | undefined {
  return f.updates?.items.find(i => i.kind === kind && i.id === id && i.latest !== null && i.latest !== i.current)
}

function withUpdate(row: DashRow, up: UpdateItem | undefined, name: string, fallback: { argv: string[], label: string }): DashRow {
  if (up?.latest === undefined || up.latest === null) return { ...row, action: fallback }
  const out: DashRow = { ...row, update: up.latest, action: { argv: ['update', name], label: `update ${row.label}` } }
  if (up.source !== undefined) out.source = up.source
  return out
}

function buracleRow(f: Facts): DashRow {
  const row: DashRow = { id: 'buracle', section: 'buracle', label: 'Buracle', version: f.version, state: 'off', status: 'checking the runtime', source: 'git checkout' }
  const r = f.runtime
  if (r === null) Object.assign(row, { status: 'runtime not checked', detail: 'the runtime could not be compared with the checkout' })
  else if (r !== undefined) {
    if (r.shim === undefined) Object.assign(row, { state: 'warn', status: 'not installed', detail: 'there is no buracle shim yet; press i to install' })
    else if (r.problems.length > 0) Object.assign(row, { state: 'err', status: 'runtime needs repair', detail: r.problems[0] })
    else if (r.shim.mode !== 'frozen') Object.assign(row, { state: 'warn', status: 'runs the checkout', detail: 'the hooks run the checkout directly; press i to give them a frozen runtime' })
    else if (r.drift === 'current' || r.drift === undefined) Object.assign(row, { state: 'ok', status: 'runtime current', detail: r.detail ?? `the hooks run ${tilde(r.dir ?? '')}` })
    else Object.assign(row, { state: 'warn', status: r.drift === 'unknown' ? 'runtime not comparable' : 'checkout edits not live', detail: r.detail })
  }
  return withUpdate(row, updateOf(f, 'self', 'buracle'), 'buracle', { argv: ['doctor', 'runtime'], label: 'check the runtime' })
}

function harnessRow(f: Facts, h: Harness): DashRow {
  const base: DashRow = { id: `harness:${h}`, section: 'harnesses', label: LABEL[h], state: 'off', status: '' }
  const doctor = { argv: ['doctor', h], label: `check ${LABEL[h]}` }
  if (!f.config.harnesses[h].enabled) return { ...base, status: 'off in config', detail: `harnesses.${h}.enabled is false`, action: doctor }
  const bin = f.bins[h]
  if (bin === undefined) return { ...base, status: 'not installed', detail: `\`${BIN[h]}\` is not on PATH`, action: doctor }
  const v = f.versions[h]
  const set = f.installed.has(h)
  const row: DashRow = {
    ...base,
    version: v === undefined ? '…' : v ?? '?',
    state: set ? 'ok' : 'warn',
    status: set ? 'Buracle installed' : 'not set up',
    detail: set ? tilde(bin) : `Buracle is not set up for ${LABEL[h]}; press i to install`,
  }
  const origin = f.origins[h]
  if (origin !== undefined) row.source = origin
  return withUpdate(row, updateOf(f, 'harness', h), h, doctor)
}

function mcpRow(f: Facts, id: string, spec: McpServerSpec): DashRow {
  const row: DashRow = { id: `mcp:${id}`, section: 'mcp', label: id, state: 'off', status: 'not checked yet', detail: 'press d or enter to run the handshake' }
  const doctor = { argv: ['doctor', 'mcp'], label: 'check the MCP servers' }
  const pkg = spec.package !== undefined ? f.toolchain.packages[`${spec.package.registry}:${spec.package.name}`] : undefined
  if (spec.transport === 'http') row.source = spec.url ?? 'remote'
  else if (spec.package !== undefined) row.source = `${spec.package.registry} ${spec.package.name}`
  else row.source = 'Buracle'
  if (pkg !== undefined) row.version = pkg.version
  const h = f.health?.mcp[id]
  const status = f.mcpHealth[id] ?? 'unknown'
  if (status === 'ok') Object.assign(row, { state: 'ok', status: h?.tools !== undefined ? `handshake ok, ${plural(h.tools, 'tool')}` : 'handshake ok', detail: verifiedDetail(h, f.nowMs) })
  else if (status === 'down') Object.assign(row, { state: 'err', status: 'down', detail: h?.error ?? 'the last handshake failed; press enter to check again' })
  if (spec.package !== undefined && pkg === undefined && status !== 'down') Object.assign(row, { state: 'warn', status: status === 'ok' ? 'not in the toolchain' : 'not installed', detail: `not in the toolchain yet: it starts through the package runner; ${toolchainHint(f)}` })
  if (spec.package === undefined && spec.command?.includes('{buracle}') === true && !f.shim && status !== 'down') Object.assign(row, { state: 'warn', status: 'not installed', detail: 'it runs through the buracle shim, which is not installed yet; press i to install' })
  return withUpdate(verifying(f, row, `mcp:${id}`, 'running the handshake'), updateOf(f, 'mcp', id), id, doctor)
}

// What a check is doing or why it could not run replaces what the last one found.
function verifying(f: Facts, row: DashRow, key: string, doing: string): DashRow {
  if (f.checking.has(key)) return { ...row, state: 'off', status: 'checking…', detail: doing }
  const why = f.failed.get(key)
  return why === undefined ? row : { ...row, state: 'warn', status: 'check failed', detail: why }
}

function verifiedDetail(h: { checked_at?: string, ms?: number, version?: string } | undefined, nowMs: number): string {
  const parts = [`verified ${ago(h?.checked_at, nowMs) ?? 'at an unknown time'}`, ...(h?.ms !== undefined ? [`${h.ms} ms`] : []), ...(h?.version !== undefined ? [`v${h.version}`] : [])]
  return parts.join(' · ')
}

function toolRow(f: Facts, t: ToolSpec): DashRow {
  const need = t.required ? 'required' : 'optional'
  const row: DashRow = { id: `tool:${t.name}`, section: t.kind === 'lsp' ? 'lsp' : 'tools', label: t.name, state: 'off', status: 'not checked yet', detail: `${t.purpose ?? t.name} (${need}); press d or enter to check` }
  const pkg = f.toolPackage(t)
  const h = f.health?.tools?.[t.name]
  const version = pkg?.version ?? h?.version
  if (version !== undefined) row.version = version
  if (pkg !== undefined) row.source = `${pkg.registry} ${pkg.name} (Buracle toolchain)`
  else if (t.brew !== undefined) row.source = `Homebrew ${t.brew}`
  if (pkg !== undefined || h?.status === 'ok') {
    const seen = h?.status === 'ok' ? ago(h.checked_at, f.nowMs) : undefined
    Object.assign(row, { state: 'ok', status: `installed, ${need}`, detail: `${t.purpose ?? t.name} (${need})${seen !== undefined ? `; verified ${seen}` : ''}` })
  } else if (h !== undefined) Object.assign(row, { state: t.required ? 'err' : 'warn', status: `missing, ${need}`, detail: `${t.purpose ?? t.name} (${need}); ${toolchainHint(f)}` })
  return withUpdate(verifying(f, row, `tool:${t.name}`, 'running its version check'), updateOf(f, 'tools', t.name), t.name, { argv: ['doctor', 'tools'], label: 'check the tools' })
}

function memoryRow(f: Facts): DashRow {
  const brain = tilde(paths.brainDir())
  const row: DashRow = {
    id: 'memory', section: 'memory', label: 'Memory', state: 'ok',
    status: f.ui !== undefined ? f.ui.replace('http://127.0.0.1', 'localhost') : 'web UI not running',
    source: brain, detail: `the brains live in ${brain}; press m to open the web UI`,
    action: { argv: ['doctor', 'memory'], label: 'check the memory' },
  }
  if (f.cortexdb !== undefined) row.version = f.cortexdb
  else Object.assign(row, { state: 'err' as RowState, detail: `CortexDB is not installed, so the brain cannot be read; ${toolchainHint(f)}` })
  return row
}

function ago(iso: string | undefined, nowMs: number): string | undefined {
  const at = iso === undefined ? NaN : Date.parse(iso)
  if (!Number.isFinite(at)) return undefined
  const min = Math.max(0, Math.round((nowMs - at) / 60_000))
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`
}

// Skills, plugins and prices have no row of their own; their waiting updates share one.
const ROWLESS_KINDS: readonly UpdateKind[] = ['skills', 'plugins', 'pricing']

function rowlessRow(f: Facts): DashRow | undefined {
  // Every cached item is a pending update; a price refresh or a skill clone has no version (latest: null).
  const waiting = (f.updates?.items ?? []).filter(i => ROWLESS_KINDS.includes(i.kind))
  if (waiting.length === 0) return undefined
  const kinds = ROWLESS_KINDS.filter(k => waiting.some(i => i.kind === k))
  return {
    id: 'rowless-updates', section: 'buracle', label: 'Skills, plugins, prices', state: 'ok',
    status: `${plural(waiting.length, 'update')} waiting`, update: kinds.join(', '),
    detail: waiting.slice(0, 4).map(i => `${i.kind} ${i.id}`).join(', ') + (waiting.length > 4 ? ', …' : ''),
    action: { argv: ['update', ...kinds], label: `update ${kinds.join(' ')}` },
  }
}

function dataOf(f: Facts): DashData {
  const rowless = rowlessRow(f)
  const rows: DashRow[] = [buracleRow(f), ...(rowless !== undefined ? [rowless] : []), ...HARNESSES.map(h => harnessRow(f, h))]
  for (const id of Object.keys(f.mcp?.servers ?? {}).sort()) {
    const spec = f.mcp?.servers[id]
    if (spec !== undefined) rows.push(mcpRow(f, id, spec))
  }
  rows.push(...f.tools.map(t => toolRow(f, t)), memoryRow(f))
  const out: DashData = { version: f.version, rows }
  const checkedAt = ago(f.updates?.checked_at, f.nowMs)
  if (checkedAt !== undefined) out.checkedAt = checkedAt
  const working = workingText(f)
  if (working !== undefined) out.working = working
  return out
}

function workingText(f: Facts): string | undefined {
  const parts = f.checking.size - (f.checking.has('updates') ? 1 : 0)
  const text = [...(parts > 0 ? [`verifying ${plural(parts, 'part')}`] : []), ...(f.checking.has('updates') ? ['checking for updates'] : [])]
  return text.length > 0 ? text.join(' · ') : undefined
}

function originLabel(o: { method: string, name?: string }): string | undefined {
  switch (o.method) {
    case 'brew-formula': return `Homebrew ${o.name ?? ''}`.trim()
    case 'brew-cask': return `Homebrew cask ${o.name ?? ''}`.trim()
    case 'npm': return `npm ${o.name ?? ''}`.trim()
    case 'bun': return `bun ${o.name ?? ''}`.trim()
    case 'native': return 'native installer'
    default: return undefined
  }
}

// The dashboard's data straight from Buracle's state files; only harness versions missing from the
// version cache and the runtime comparison (git, file hashes) come later, in fill().
export async function fileSource(now: () => number, verifier?: Verifier): Promise<DashSource> {
  const [{ loadConfigSync }, { readInstallRecord }, { readUpdatesCache }, mcp, { readToolchainState }, { readMcpCatalog }, { readToolsCatalog }, toolchain, system, platform, origin, bar, cortex, router] = await Promise.all([
    import('../engine/config'), import('../engine/update/install-core'), import('../engine/update/updates-cache'), import('../engine/update/mcp'),
    import('../engine/toolchain/state'), import('../engine/toolchain/launch'), import('../engine/toolchain/lsp'), import('../engine/toolchain/index'),
    import('../engine/toolchain/system'), import('../engine/platform'), import('../engine/update/origin'), import('../usage/bar-info'),
    import('../engine/toolchain/cortexdb'), import('./router'),
  ])
  let facts: Facts | undefined
  // One verification at a time. Its state outlives a read(): every Facts shares these two, and a result
  // lands in whichever Facts is current when it arrives.
  const verify = { checking: new Set<string>(), failed: new Map<string, string>(), running: undefined as Promise<void> | undefined, sink: undefined as ((d: DashData) => void) | undefined }
  const read = (): Facts => {
    const nowMs = now()
    const config = loadConfigSync({ repoRoot: paths.repoRoot() }).config
    const bins: Facts['bins'] = {}
    const origins: Facts['origins'] = {}
    const versions: Facts['versions'] = {}
    for (const h of HARNESSES) {
      if (!config.harnesses[h].enabled) continue
      const bin = platform.findExecutable(BIN[h])
      if (bin === undefined) continue
      bins[h] = bin
      const label = originLabel(origin.detectOrigin(origin.resolveBinary(bin) ?? bin))
      if (label !== undefined) origins[h] = label
      const v = bar.cachedHarnessVersion(h, nowMs)
      if (v !== undefined) versions[h] = v
    }
    let catalog: McpCatalog | undefined
    try { catalog = readMcpCatalog() } catch { catalog = undefined }
    let tools: ToolSpec[] = []
    try { tools = readToolsCatalog().tools.filter(t => system.toolApplies(t)) } catch { tools = [] }
    const health = mcp.readHealth()
    const state = readToolchainState()
    const f: Facts = {
      nowMs, version: router.cliVersion(), config, bins, origins, versions, health, toolchain: state, tools,
      installed: new Set(Object.keys(readInstallRecord().record.plans)),
      mcpHealth: catalog !== undefined ? mcp.mcpHealthMap(catalog, health, nowMs) : {},
      toolPackage: t => toolchain.toolPackage(t, state),
      shim: existsSync(paths.shimPath()), checking: verify.checking, failed: verify.failed,
    }
    const updates = readUpdatesCache()
    if (updates !== undefined) f.updates = updates
    if (catalog !== undefined) f.mcp = catalog
    const ui = bar.liveMemoryUi()
    if (ui !== undefined) f.ui = ui.url
    const db = cortex.cortexdbBinary()
    if (db !== undefined) f.cortexdb = db.version
    // A later read keeps what the slow part already found until that part runs again.
    if (facts?.runtime !== undefined) f.runtime = facts.runtime
    return f
  }
  // A verification wrote its result to the files; the current Facts takes it from there.
  const take = (): void => {
    const f = facts
    if (f === undefined) return
    f.health = mcp.readHealth()
    f.mcpHealth = f.mcp !== undefined ? mcp.mcpHealthMap(f.mcp, f.health, f.nowMs) : {}
    const updates = readUpdatesCache()
    if (updates !== undefined) f.updates = updates
    verify.sink?.(dataOf(f))
  }
  const runVerify = async (v: Verifier, force: boolean): Promise<void> => {
    const f = facts
    if (f === undefined) return
    const catalog = f.mcp
    const servers = catalog !== undefined ? staleServers(catalog, f.health, f.toolchain, existsSync(paths.shimPath()), f.nowMs, force) : []
    const jobs: Array<[string, () => Promise<void>]> = [
      ...servers.map((id): [string, () => Promise<void>] => [`mcp:${id}`, () => v.mcp(id, catalog as McpCatalog)]),
      ...staleTools(f.tools, f.health, f.nowMs, force).map((t): [string, () => Promise<void>] => [`tool:${t.name}`, () => v.tool(t)]),
      ...(updatesStale(f.updates, f.nowMs, force) ? [['updates', () => v.updates()] as [string, () => Promise<void>]] : []),
    ]
    if (jobs.length === 0) return
    for (const [key] of jobs) { verify.checking.add(key); verify.failed.delete(key) }
    verify.sink?.(dataOf(f))
    await Promise.all(jobs.map(async ([key, work]) => {
      try { await work() } catch (e) { verify.failed.set(key, errText(e)) }
      verify.checking.delete(key)
      take()
    }))
  }
  return {
    read() {
      facts = read()
      return dataOf(facts)
    },
    async fill(changed, opts) {
      verify.sink = changed
      const f = facts ?? read()
      facts = f
      const missing = HARNESSES.filter(h => f.bins[h] !== undefined && f.config.harnesses[h].enabled && !(h in f.versions))
      const versions = missing.map(async h => {
        const v = await bar.harnessVersion(h, f.nowMs).catch(() => undefined)
        f.versions[h] = v ?? null
        changed(dataOf(f))
      })
      const runtime = (async () => {
        await new Promise(r => setTimeout(r, 0)) // after the first frame is on the screen
        const { readShim, runtimeHealth } = await import('../engine/update/runtime')
        try {
          const checkout = paths.isFrozenRuntime() ? paths.checkoutRoot() : paths.repoRoot()
          f.runtime = runtimeHealth(checkout, readShim())
        } catch {
          f.runtime = null
        }
        changed(dataOf(f))
      })()
      if (verifier !== undefined && verify.running === undefined) {
        const run = runVerify(verifier, opts?.force === true).catch(() => {  }).finally(() => { verify.running = undefined })
        verify.running = run
      }
      await Promise.all([...versions, runtime, verify.running])
    },
  }
}

export function resultLine(code: number): string {
  if (code === 0) return 'done'
  if (code === 2) return 'done, with points that need your attention (exit code 2)'
  return `failed (exit code ${code})`
}

function viewOf(prev: DashView | undefined, data: DashData, size: { columns: number, rows: number }): DashView {
  const next = initialView(data.version, data.rows, size)
  if (data.checkedAt !== undefined) next.summary = { ...next.summary, checkedAt: data.checkedAt }
  if (data.working !== undefined) next.summary = { ...next.summary, working: data.working }
  if (prev === undefined) return next
  const id = prev.items[prev.selected]?.id
  const at = id === undefined ? -1 : next.items.findIndex(r => r.id === id)
  const out: DashView = { ...next, selected: at >= 0 ? at : Math.min(prev.selected, Math.max(0, next.items.length - 1)), scroll: prev.scroll, help: prev.help }
  if (prev.message !== undefined) out.message = prev.message
  return out
}

function menuOf(prev: MenuView, view: DashView): MenuView {
  return { ...prev, version: view.version, columns: view.columns, rows: view.rows, summary: view.summary }
}

export async function runDashboard(d: DashboardDeps): Promise<number> {
  // Every way out, an error while it starts included, gives the terminal back.
  try {
    return await dashboardLoop(d)
  } finally {
    d.terminal.close()
  }
}

async function dashboardLoop(d: DashboardDeps): Promise<number> {
  const source = d.source ?? await fileSource(d.now)
  const command = d.command ?? [process.execPath, join(import.meta.dir, 'main.ts')]
  const shim = d.shim ?? currentShim
  const env = d.env ?? process.env
  const signals: SigintHost = d.signals ?? process
  const write = d.write ?? ((s: string) => { process.stdout.write(s) })
  const st = d.style ?? dashboardStyle()
  const startMain = shim()?.main
  let view = viewOf(undefined, source.read(), d.terminal.size())
  // The main menu comes first; its Detailed view is the dashboard, and Esc there returns to the menu.
  let menu = initialMenu(view.version, view.summary, d.terminal.size())
  let screen: 'menu' | 'detail' = 'menu'
  let busy = false
  let fills = 0
  const draw = (): void => { if (!busy) d.terminal.draw(screen === 'menu' ? renderMenu(st, menu) : renderDashboard(st, view)) }
  const show = (data: DashData): void => {
    view = viewOf(view, data, d.terminal.size())
    menu = menuOf(menu, view)
    draw()
  }
  const fill = (force = false): void => {
    const n = ++fills
    void Promise.resolve().then(() => source.fill(data => { if (n === fills) show(data) }, force ? { force: true } : undefined)).catch(() => {  })
  }

  const runChild = async (argv: readonly string[]): Promise<number> => {
    busy = true
    d.terminal.suspend()
    write(`\n${st.bold(`buracle ${argv.join(' ')}`)}\n\n`)
    let child: ChildHandle | undefined
    // Ctrl-C belongs to the command while it runs; the dashboard stays open.
    const onInt = (): void => { try { child?.kill('SIGINT') } catch {  } }
    signals.on('SIGINT', onInt)
    let code: number
    try {
      child = d.spawn([...command, ...argv], { ...env })
      code = await child.exited
    } catch (e) {
      write(`${e instanceof Error ? e.message : String(e)}\n`)
      code = 1
    }
    const line = resultLine(code)
    write(`\n${code === 0 ? st.ok(line) : code === 2 ? st.warn(line) : st.err(line)}\n${st.muted('press any key to return')}\n`)
    try {
      await d.terminal.anyKey()
    } finally {
      signals.off('SIGINT', onInt)
      busy = false
      d.terminal.resume()
    }
    return code
  }

  d.terminal.onResize(() => {
    const size = d.terminal.size()
    view = { ...view, ...size }
    menu = { ...menu, ...size }
    draw()
  })
  draw()
  fill()
  for (;;) {
    const key = await d.terminal.nextKey()
    let action: DashAction | MenuAction | undefined
    if (screen === 'menu') {
      const step = menuStep(menu, key)
      menu = step.view
      action = step.action
    } else {
      const step = dashboardStep(view, key)
      view = step.view
      action = step.action
    }
    if (action === undefined) { draw(); continue }
    if (action.kind === 'quit') return 0
    if (action.kind === 'detail' || action.kind === 'back') { screen = action.kind === 'detail' ? 'detail' : 'menu'; draw(); continue }
    if (action.kind === 'reload') { show(source.read()); fill(true); continue }
    const code = await runChild(action.argv)
    // An install or update can point the shim at new code; the dashboard then starts once more from it.
    const now = shim()
    if (env[REEXEC_ENV] !== '1' && now !== undefined && now.main !== startMain && now.main !== command[1]) {
      d.terminal.close()
      return await d.spawn([now.path], { ...env, [REEXEC_ENV]: '1' }).exited
    }
    const message = `buracle ${action.argv.join(' ')}: ${resultLine(code)}`
    if (screen === 'menu') menu = { ...menu, message }
    else view = { ...view, message }
    show(source.read())
    fill()
  }
}

function currentShim(): { path: string, main: string } | undefined {
  try {
    const info = parseShimText(readFileSync(paths.shimPath(), 'utf8'))
    return info === undefined ? undefined : { path: paths.shimPath(), main: info.main }
  } catch {
    return undefined
  }
}

export function dashboardStyle(): Style {
  const level = colorLevel(process.stdout)
  return makeStyle(level, { unicode: level > 0 })
}

export function dashboardFits(o: { stdinTTY: boolean, stdoutTTY: boolean, json: boolean, term: string | undefined, columns: number | undefined, rows: number | undefined }): boolean {
  return o.stdinTTY && o.stdoutTTY && !o.json && o.term !== 'dumb'
    && (o.columns ?? 0) >= MIN_SIZE.columns && (o.rows ?? 0) >= MIN_SIZE.rows
}

function spawnChild(argv: readonly string[], env: Record<string, string | undefined>): ChildHandle {
  const spawned = spawnArgv([...argv])
  const p = Bun.spawn(spawned, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: { ...env }, windowsVerbatimArguments: windowsVerbatim(spawned) })
  const SIGNALS: Readonly<Record<string, number>> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }
  return {
    exited: p.exited.then(code => (p.signalCode ? 128 + (SIGNALS[p.signalCode] ?? 15) : code)),
    kill: sig => { p.kill(sig) },
  }
}

export async function openDashboard(): Promise<number> {
  const [{ openTerminal }, { liveVerifier }] = await Promise.all([import('./ui/terminal'), import('../engine/update/refresh')])
  return runDashboard({ terminal: openTerminal({ input: process.stdin, output: process.stdout }), spawn: spawnChild, now: Date.now, source: await fileSource(Date.now, liveVerifier()) })
}
