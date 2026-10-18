import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { CmSmokeResult } from '../../adapters/shared/context-mode/smoke'
import type { McpCatalog } from '../../core/catalog'
import type { BuracleConfig } from '../../core/config'
import { CM_HIDDEN_TOOLS, CM_SERVER_ID, CM_TOOLS } from '../../core/context-mode'
import type { Harness } from '../../core/events'
import { HARNESSES } from '../../core/events'
import { formatBytes } from '../../core/status/format'
import { CM_PACKAGE, cmBun, cmHome, cmPackage, cmProjectDir, cmStorageRoot, type CmPackage } from '../context-mode'
import { readJsonSafeSync, readTextSync } from '../fsx'
import { jsoncParse } from '../merge'
import * as paths from '../paths'
import { packageKey, readToolchainState, type ToolchainState } from '../toolchain/state'
import type { DoctorCheck, DoctorLevel } from './doctor'
import { readHealth, type HealthFile, type StoredMcpEntry } from './mcp'
import { errText, isInside, tilde } from './output'

export const CM_DOCTOR_SECTION = 'context-mode'

const INSTALL_HINT = '`buracle install`'

type Obj = Record<string, unknown>

function obj(x: unknown): Obj | undefined {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Obj : undefined
}

export interface CmDoctorOptions {
  config: BuracleConfig
  catalog?: McpCatalog
  nowMs: number
  cwd?: string
  env?: Readonly<Record<string, string | undefined>>
  smoke?: (pkg: CmPackage) => Promise<CmSmokeResult>
  bun?: () => string | undefined
  which?: (name: string) => string | undefined
  health?: HealthFile
  toolchain?: ToolchainState
}

async function defaultSmoke(pkg: CmPackage): Promise<CmSmokeResult> {
  const { cmSmokeTest } = await import('../../adapters/shared/context-mode/smoke')
  return cmSmokeTest({ pkg })
}

function defaultWhich(name: string): string | undefined {
  const PATH = process.env['PATH'] ?? process.env['Path']
  if (PATH === undefined || PATH === '') return undefined
  return Bun.which(name, { PATH }) ?? undefined
}

function ago(iso: string | undefined, nowMs: number): string | undefined {
  if (iso === undefined) return undefined
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return undefined
  const min = Math.max(0, Math.round((nowMs - t) / 60_000))
  if (min < 120) return `${min} min`
  const h = Math.round(min / 60)
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`
}

interface PackageFacts { checks: DoctorCheck[], pkg?: CmPackage }

function packageChecks(o: CmDoctorOptions, add: (level: DoctorLevel, check: string, detail: string) => DoctorCheck): PackageFacts {
  const enabled = o.config.contextMode.enabled
  const state = o.toolchain ?? readToolchainState()
  const pkg = cmPackage(state)
  if (pkg === undefined) {
    return { checks: [add(enabled ? 'warn' : 'info', 'toolchain', `not installed in Buracle's toolchain; run ${INSTALL_HINT}. Until then the server starts through npx, on Node.`)] }
  }
  const manifest = readJsonSafeSync<unknown>(join(pkg.root, 'package.json'))
  if (!manifest.ok) {
    return { checks: [add('error', 'toolchain', `toolchain.json lists ${CM_PACKAGE} ${pkg.version}, but ${tilde(pkg.root)} holds no package; run ${INSTALL_HINT}`)] }
  }
  const out: DoctorCheck[] = []
  const version = obj(manifest.value)?.['version']
  const bin = state.packages[packageKey('npm', CM_PACKAGE)]?.bins[CM_PACKAGE]
  if (bin === undefined || !existsSync(bin)) {
    out.push(add('error', 'toolchain', `${CM_PACKAGE} ${pkg.version} in ${tilde(pkg.root)} has no server (${bin !== undefined ? tilde(bin) : 'no bin recorded'}); run ${INSTALL_HINT}`))
  } else if (typeof version === 'string' && version !== pkg.version) {
    out.push(add('warn', 'toolchain', `toolchain.json says ${pkg.version}, but ${tilde(pkg.root)} holds ${version}; run ${INSTALL_HINT}`))
  } else {
    out.push(add('ok', 'toolchain', `${CM_PACKAGE} ${pkg.version} in ${tilde(pkg.root)}`))
  }
  return { checks: out, pkg }
}

function bunCheck(o: CmDoctorOptions, add: (level: DoctorLevel, check: string, detail: string) => DoctorCheck): DoctorCheck {
  let bun: string | undefined
  try { bun = (o.bun ?? cmBun)() } catch { bun = undefined }
  if (bun === undefined) {
    return add(o.config.contextMode.enabled ? 'error' : 'warn', 'bun', 'Bun was not found: the context-mode server and its session library run on Bun (on Node they would install a native SQLite module into the toolchain copy)')
  }
  const own = bun === process.execPath && typeof Bun !== 'undefined' ? ` (bun ${Bun.version})` : ''
  return add('ok', 'bun', `${tilde(bun)}${own}`)
}

async function smokeCheck(o: CmDoctorOptions, pkg: CmPackage | undefined, add: (level: DoctorLevel, check: string, detail: string) => DoctorCheck): Promise<DoctorCheck> {
  if (pkg === undefined) return add('info', 'session library', 'not tested: context-mode is not installed in the toolchain')
  let r: CmSmokeResult
  try {
    r = await (o.smoke ?? defaultSmoke)(pkg)
  } catch (e) {
    r = { ok: false, root: pkg.root, version: pkg.version, problems: [errText(e)], ms: 0 }
  }
  const version = r.version ?? pkg.version
  if (r.ok) return add('ok', 'session library', `the session library of ${CM_PACKAGE} ${version} passes Buracle's smoke test: import, event extraction, session database, snapshot and restore text (${r.ms} ms)`)
  const capturing = o.config.contextMode.enabled && o.config.contextMode.capture
  return add(capturing ? 'error' : 'warn', 'session library',
    `the session library of ${CM_PACKAGE} ${version} fails Buracle's smoke test: ${r.problems.join('; ')}. Session continuity fails open until a release passes it (the tools still work); \`contextMode.capture: false\` stops the attempts.`)
}

export async function cmSmokeWarning(smoke: () => Promise<CmSmokeResult> = async () => {
  const { cmSmokeTest } = await import('../../adapters/shared/context-mode/smoke')
  return cmSmokeTest()
}): Promise<string | undefined> {
  let r: CmSmokeResult
  try { r = await smoke() } catch (e) { r = { ok: false, problems: [errText(e)], ms: 0 } }
  if (r.ok) return undefined
  return `${CM_PACKAGE}${r.version !== undefined ? ` ${r.version}` : ''}: its session library fails Buracle's smoke test (${r.problems.join('; ')}); session continuity fails open until a release passes it (the tools still work). Details: \`buracle doctor context-mode\`.`
}

export function cmToolchainChanged(items: ReadonlyArray<{ id: string, status: string }>): boolean {
  return items.some(i => i.id === `mcp:${CM_SERVER_ID}` && (i.status === 'installed' || i.status === 'upgraded'))
}

function isDir(p: string): boolean {
  try { return lstatSync(p).isDirectory() } catch { return false }
}

function subdirs(p: string): string[] {
  try { return readdirSync(p).filter(n => isDir(join(p, n))).sort() } catch { return [] }
}

function treeBytes(dir: string, limit = 20_000): { bytes: number, partial: boolean } {
  let bytes = 0
  let seen = 0
  const stack = [dir]
  while (stack.length > 0) {
    const d = stack.pop() as string
    let names: string[]
    try { names = readdirSync(d) } catch { continue }
    for (const n of names) {
      if (++seen > limit) return { bytes, partial: true }
      const p = join(d, n)
      try {
        const st = lstatSync(p)
        if (st.isDirectory()) stack.push(p)
        else if (st.isFile()) bytes += st.size
      } catch {  }
    }
  }
  return { bytes, partial: false }
}

function openToOthers(p: string): boolean {
  try { return (statSync(p).mode & 0o077) !== 0 } catch { return false }
}

function storageChecks(o: CmDoctorOptions, add: (level: DoctorLevel, check: string, detail: string) => DoctorCheck): DoctorCheck[] {
  const home = cmHome()
  if (!isDir(home)) return [add('ok', 'storage', `nothing stored yet (${tilde(home)})`)]
  const out: DoctorCheck[] = []
  const counts: string[] = []
  const exposed: string[] = []
  const homeOpen = process.platform !== 'win32' && openToOthers(home)
  for (const h of HARNESSES) {
    const dir = join(home, h)
    const roots = subdirs(dir)
    if (roots.length > 0) counts.push(`${h} ${roots.length}`)
    if (homeOpen && openToOthers(dir)) for (const r of roots) if (openToOthers(join(dir, r))) exposed.push(join(dir, r))
  }
  const size = treeBytes(home)
  const env = o.env ?? process.env
  const cwd = o.cwd ?? process.cwd()
  const here: string[] = []
  for (const h of HARNESSES) {
    let root: string
    try { root = cmStorageRoot(h, cmProjectDir(h, { claudeProjectDir: env['CLAUDE_PROJECT_DIR'], cwd })) } catch { continue }
    if (isDir(root)) here.push(`${h} ${tilde(root)}`)
  }
  const what = counts.length > 0 ? `project folders: ${counts.join(', ')}` : 'no project folder yet'
  out.push(add('ok', 'storage', `${tilde(home)}: ${what}; ${size.partial ? 'over ' : ''}${formatBytes(size.bytes)}${here.length > 0 ? `; this folder: ${here.join(', ')}` : ''}`))
  if (exposed.length > 0) {
    const shown = exposed.slice(0, 3).map(tilde).join(', ')
    out.push(add('warn', 'storage access', `other users can read the session data (prompts, commands and their output) in ${shown}${exposed.length > 3 ? ` and ${exposed.length - 3} more` : ''}; run \`chmod -R go-rwx ${tilde(home)}\``))
  }
  return out
}

function switchesCheck(o: CmDoctorOptions, add: (level: DoctorLevel, check: string, detail: string) => DoctorCheck): DoctorCheck {
  const { enabled, capture } = o.config.contextMode
  const env = o.env ?? process.env
  const noCapture = env['BURACLE_NO_CAPTURE'] === '1' ? '; BURACLE_NO_CAPTURE=1 is set here, so processes started from this environment record nothing' : ''
  if (!enabled) {
    return add('info', 'switches', `contextMode.enabled: false. Routing, the prompt router, the reminders, the session bridge and the status segment stand down at once (Buracle's guards still check context-mode calls); a running context-mode server keeps its tools until its next start (a new session or an MCP reconnect), then starts without them${noCapture}`)
  }
  return add('ok', 'switches', capture
    ? `contextMode.enabled: true, contextMode.capture: true (sessions are recorded, and a summary is restored after compaction and on resume)${noCapture}`
    : `contextMode.enabled: true, contextMode.capture: false (the tools work; no session events are recorded or restored)${noCapture}`)
}

export const CM_EXPECTED_TOOLS: readonly string[] = [...CM_TOOLS, ...CM_HIDDEN_TOOLS].sort()

function handshakeCheck(o: CmDoctorOptions, pkg: CmPackage | undefined, add: (level: DoctorLevel, check: string, detail: string) => DoctorCheck): DoctorCheck | undefined {
  if (o.catalog !== undefined && o.catalog.servers[CM_SERVER_ID] === undefined) return add('info', 'handshake', 'canonical/mcp.yaml has no context-mode server')
  const enabled = o.config.contextMode.enabled
  let health: HealthFile | undefined
  try { health = o.health ?? readHealth() } catch { health = undefined }
  const e: StoredMcpEntry | undefined = health?.mcp[CM_SERVER_ID]
  if (e === undefined || e.status === 'unknown') return add('info', 'handshake', 'no handshake recorded yet; `buracle doctor mcp` runs one')
  const when = ago(e.checked_at, o.nowMs)
  const at = when !== undefined ? `, ${when} ago` : ''
  if (e.status === 'down') {
    const why = e.error !== undefined && e.error !== '' ? e.error : 'no answer'
    const retry = e.source === 'launch' && e.until !== undefined ? ` (\`buracle mcp run\` tries again after ${e.until})` : ''
    return add(enabled ? 'error' : 'warn', 'handshake', `down${at}: ${why}${retry}; \`buracle doctor mcp\` runs the handshake again`)
  }
  if (e.version === 'disabled' && (e.tools ?? 0) === 0) {
    return enabled
      ? add('info', 'handshake', `the last handshake${at} met the switched-off server (contextMode.enabled was false then); it serves its tools from its next start, and \`buracle doctor mcp\` records them`)
      : add('ok', 'handshake', `switched off${at}: the server answers without tools (contextMode.enabled: false)`)
  }
  const version = e.version !== undefined ? `, v${e.version}` : ''
  const seen = pkg !== undefined && e.version !== undefined && e.version !== pkg.version
    ? `; the handshake saw v${e.version} but the toolchain holds ${pkg.version}: \`buracle doctor mcp\` runs it again`
    : ''
  const names = e.toolNames
  if (names === undefined) return add('info', 'handshake', `${e.tools ?? 0} tool(s)${version}${at}; the tool names were not recorded: \`buracle doctor mcp\` records them${seen}`)
  const got = new Set(names)
  const extra = [...got].filter(n => !CM_EXPECTED_TOOLS.includes(n)).sort()
  const missing = CM_EXPECTED_TOOLS.filter(n => !got.has(n))
  if (extra.length === 0 && missing.length === 0) {
    return add('ok', 'handshake', `${names.length} tools (${CM_TOOLS.length} in use, ${CM_HIDDEN_TOOLS.length} hidden)${version}${at}${seen}`)
  }
  const parts = [
    ...(extra.length > 0 ? [`new: ${extra.join(', ')} (the guards deny them until Buracle knows them)`] : []),
    ...(missing.length > 0 ? [`missing: ${missing.join(', ')}`] : []),
  ]
  return add('warn', 'handshake', `the server's tools differ from the ones this Buracle version knows${version}${at}: ${parts.join('; ')}${seen}`)
}

export interface CmForeignInstall { harness?: Harness; check: string; detail: string; runsHooks?: boolean }

function namesContextMode(text: string): boolean {
  return /(?:^|[\s"'`/\\@:=])context-mode(?:$|[\s"'`/\\@:#,=])/.test(text)
}

function readJsonc(p: string): unknown {
  const r = readTextSync(p)
  if (!r.ok) return undefined
  const v = jsoncParse(r.value)
  return v.ok ? v.value : undefined
}

function pluginIds(x: unknown): string[] {
  const o = obj(x)
  if (o === undefined) return []
  return Object.keys(o).filter(k => k.startsWith(`${CM_PACKAGE}@`)).sort()
}

function foreignCmServers(servers: unknown): string[] {
  const out: string[] = []
  for (const [id, spec] of Object.entries(obj(servers) ?? {})) {
    const s = obj(spec)
    const argv = [typeof s?.['command'] === 'string' ? s['command'] : '', ...(Array.isArray(s?.['args']) ? s['args'].filter((a): a is string => typeof a === 'string') : [])]
    const buracle = argv.some((a, i) => a === 'mcp' && argv[i + 1] === 'run' && argv[i + 2] === CM_SERVER_ID)
    if ((id === CM_SERVER_ID || argv.some(namesContextMode)) && !buracle) out.push(id)
  }
  return out
}

function claudeForeign(cwd: string): CmForeignInstall[] {
  const dir = paths.claudeDir()
  const out: CmForeignInstall[] = []
  const installedFile = join(dir, 'plugins', 'installed_plugins.json')
  const installed = obj(readJsonc(installedFile))
  const ids = [...new Set([...pluginIds(installed?.['plugins']), ...pluginIds(installed)])]
  const settingsFile = join(dir, 'settings.json')
  const settings = obj(readJsonc(settingsFile))
  const enabled = Object.entries(obj(settings?.['enabledPlugins']) ?? {}).filter(([k, v]) => k.startsWith(`${CM_PACKAGE}@`) && v !== false).map(([k]) => k)
  const plugins = [...new Set([...ids, ...enabled])].sort()
  if (plugins.length > 0) {
    const places = [...(ids.length > 0 ? [tilde(installedFile)] : []), ...(enabled.length > 0 ? [`enabledPlugins in ${tilde(settingsFile)}`] : [])]
    out.push({ harness: 'claude', check: 'claude plugin', runsHooks: true, detail: `${places.join(' and ')} name${places.length === 1 ? 's' : ''} ${plugins.join(', ')}: its start.mjs rewrites ~/.claude/settings.json on every start and its hooks run beside Buracle's; \`claude plugin uninstall ${plugins[0]}\` removes it (Buracle runs context-mode itself)` })
  }
  const markets = [
    ...(obj(readJsonc(join(dir, 'plugins', 'known_marketplaces.json')))?.[CM_PACKAGE] !== undefined ? [tilde(join(dir, 'plugins', 'known_marketplaces.json'))] : []),
    ...(obj(settings?.['extraKnownMarketplaces'])?.[CM_PACKAGE] !== undefined ? [`extraKnownMarketplaces in ${tilde(settingsFile)}`] : []),
  ]
  if (markets.length > 0) out.push({ harness: 'claude', check: 'claude marketplace', detail: `the context-mode marketplace is registered (${markets.join(', ')}); \`claude plugin marketplace remove ${CM_PACKAGE}\` removes it` })
  const healFile = join(dir, 'hooks', 'context-mode-cache-heal.mjs')
  const sessionStart = obj(settings?.['hooks'])?.['SessionStart']
  const healHook = Array.isArray(sessionStart) && JSON.stringify(sessionStart).includes('context-mode-cache-heal')
  if (existsSync(healFile) || healHook) {
    const what = [...(existsSync(healFile) ? [tilde(healFile)] : []), ...(healHook ? [`its SessionStart entry in ${tilde(settingsFile)}`] : [])].join(' and ')
    out.push({ harness: 'claude', check: 'claude cache-heal hook', detail: `context-mode's start.mjs left its cache-heal hook (${what}), which runs on every Claude Code session start; delete the file and the entry` })
  }
  const server = (where: string, id: string, removal: string): CmForeignInstall => ({
    harness: 'claude', check: 'claude mcp server',
    detail: `${where} starts context-mode outside Buracle's launcher (no storage root, no platform, no stub), and its tools reach Claude Code under another name (\`mcp__${id}__<tool>\`) beside Buracle's; ${removal}`,
  })
  const appFile = paths.claudeJson()
  const app = obj(readJsonc(appFile))
  for (const id of foreignCmServers(app?.['mcpServers'])) {
    out.push(server(`\`mcpServers.${id}\` in ${tilde(appFile)} (user scope)`, id, `\`claude mcp remove ${id} -s user\` removes it`))
  }
  for (const [project, entry] of Object.entries(obj(app?.['projects']) ?? {})) {
    for (const id of foreignCmServers(obj(entry)?.['mcpServers'])) {
      out.push(server(`\`projects[${JSON.stringify(project)}].mcpServers.${id}\` in ${tilde(appFile)} (local scope)`, id, `\`claude mcp remove ${id} -s local\`, run in ${tilde(project)}, removes it`))
    }
  }
  const projectFile = join(cwd, '.mcp.json')
  for (const id of foreignCmServers(obj(readJsonc(projectFile))?.['mcpServers'])) {
    out.push(server(`\`mcpServers.${id}\` in ${tilde(projectFile)} (project scope)`, id, `\`claude mcp remove ${id} -s project\`, run in that folder, removes it`))
  }
  return out
}

const CM_HOOK_COMMAND = /\bcontext-mode(?:\.cmd)?["']?\s+hook\b|hooks[\\/]codex[\\/][\w-]+\.mjs/

function commandsOf(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) for (const v of x) commandsOf(v, out)
  else {
    const o = obj(x)
    if (o !== undefined) for (const [k, v] of Object.entries(o)) {
      if (k === 'command' && typeof v === 'string') out.push(v)
      else commandsOf(v, out)
    }
  }
  return out
}

function codexForeign(): CmForeignInstall[] {
  const home = paths.codexHome()
  const out: CmForeignInstall[] = []
  const configFile = join(home, 'config.toml')
  const toml = readTextSync(configFile)
  if (toml.ok) {
    const plugin = /^[ \t]*\[[ \t]*plugins[ \t]*\.[ \t]*(["'])(context-mode@[^"']*)\1[ \t]*\]/m.exec(toml.value)?.[2]
    if (plugin !== undefined) out.push({ harness: 'codex', check: 'codex plugin', runsHooks: true, detail: `${tilde(configFile)} enables the plugin ${plugin}: its hooks need trust Buracle cannot record and its server runs outside Buracle's launcher; \`codex plugin remove ${plugin}\` removes it` })
    if (/^[ \t]*\[[ \t]*marketplaces[ \t]*\.[ \t]*(?:"context-mode"|'context-mode'|context-mode)[ \t]*\]/m.test(toml.value)) {
      out.push({ harness: 'codex', check: 'codex marketplace', detail: `${tilde(configFile)} registers the context-mode marketplace; \`codex plugin marketplace remove ${CM_PACKAGE}\` removes it` })
    }
  }
  const hooksFile = join(home, 'hooks.json')
  const stray = commandsOf(readJsonc(hooksFile)).filter(c => CM_HOOK_COMMAND.test(c))
  if (stray.length > 0) out.push({ harness: 'codex', check: 'codex hooks', runsHooks: true, detail: `${tilde(hooksFile)} holds ${stray.length} context-mode hook command(s) (${stray[0]}); Buracle records the session itself, and \`context-mode upgrade\` rewrites them: remove their groups` })
  return out
}

function opencodeForeign(): CmForeignInstall[] {
  const dir = paths.opencodeConfigDir()
  const out: CmForeignInstall[] = []
  for (const name of ['opencode.jsonc', 'opencode.json', 'cli.json']) {
    const file = join(dir, name)
    const doc = obj(readJsonc(file))
    if (doc === undefined) continue
    for (const key of ['plugin', 'plugins']) {
      const list = doc[key]
      if (!Array.isArray(list)) continue
      const hits = list.map(v => (typeof v === 'string' ? v : JSON.stringify(v) ?? '')).filter(namesContextMode)
      if (hits.length > 0) out.push({ harness: 'opencode', check: 'opencode plugin', detail: `\`${key}\` in ${tilde(file)} names ${hits.join(', ')}: context-mode's OpenCode plugin is a v1 plugin, which OpenCode 2 never runs (and beside a v1 \`mcp.context-mode\` block its server lists no tools); remove the entry` })
    }
  }
  return out
}

function ompForeign(): CmForeignInstall[] {
  const plugins = join(paths.ompHome(), 'plugins')
  const out: CmForeignInstall[] = []
  const manifestFile = join(plugins, 'package.json')
  const manifest = obj(readJsonc(manifestFile))
  const deps = ['dependencies', 'devDependencies', 'optionalDependencies'].some(k => obj(manifest?.[k])?.[CM_PACKAGE] !== undefined)
  const lockFile = join(plugins, 'omp-plugins.lock.json')
  const locked = obj(readJsonc(lockFile))?.['plugins']
  const inLock = Array.isArray(locked)
    ? locked.some(p => p === CM_PACKAGE || obj(p)?.['name'] === CM_PACKAGE)
    : obj(locked)?.[CM_PACKAGE] !== undefined
  if (deps || inLock) {
    out.push({ harness: 'omp', check: 'omp plugin', detail: `${tilde(deps ? manifestFile : lockFile)} lists context-mode's own omp plugin: it registers session_before_compact (which turns off omp's speculative compaction) and writes ~/.omp/agent/mcp.json; \`omp plugin uninstall ${CM_PACKAGE}\` removes it` })
  }
  const mcpFile = join(paths.ompAgentDir(), 'mcp.json')
  for (const id of foreignCmServers(obj(readJsonc(mcpFile))?.['mcpServers'])) {
    out.push({ harness: 'omp', check: 'omp mcp.json', detail: `\`mcpServers.${id}\` in ${tilde(mcpFile)} starts context-mode outside Buracle's launcher (no storage root, no platform, no stub); it shadows Buracle's server of the same name: remove the entry` })
  }
  return out
}

function globalForeign(o: Pick<CmDoctorOptions, 'which'>): CmForeignInstall[] {
  let found: string | undefined
  try { found = (o.which ?? defaultWhich)(CM_PACKAGE) } catch { found = undefined }
  if (found === undefined) return []
  let real = found
  try { real = realpathSync(found) } catch {  }
  if (isInside(real, paths.toolchainDir())) return []
  return [{ check: 'global cli', detail: `\`${CM_PACKAGE}\` on PATH (${tilde(found)}): Buracle never runs it, and its \`upgrade\` and \`hook\` commands write harness settings outside Buracle; remove it (for an npm install: \`npm uninstall -g ${CM_PACKAGE}\`)` }]
}

export function cmForeignInstalls(o: Pick<CmDoctorOptions, 'which' | 'cwd'> = {}): CmForeignInstall[] {
  const out: CmForeignInstall[] = []
  for (const f of [() => claudeForeign(o.cwd ?? process.cwd()), codexForeign, opencodeForeign, ompForeign, () => globalForeign(o)]) {
    try { out.push(...f()) } catch {  }
  }
  return out
}

export function cmPlatformFiles(env: Readonly<Record<string, string | undefined>> = process.env, platform: string = process.platform): string[] {
  const set = (k: string): string | undefined => (env[k] !== undefined && env[k] !== '' ? env[k] : undefined)
  if (platform === 'win32') return [join(set('APPDATA') ?? join(paths.home(), 'AppData', 'Roaming'), 'context-mode', 'platform.json')]
  const xdg = set('XDG_CONFIG_HOME')
  return [...(xdg !== undefined ? [join(xdg, 'context-mode', 'platform.json')] : []), join(paths.home(), '.context-mode', 'platform.json')]
}

export async function contextModeChecks(o: CmDoctorOptions): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []
  const add = (level: DoctorLevel, check: string, detail: string): DoctorCheck => ({ section: CM_DOCTOR_SECTION, level, check, detail })
  const guard = <T>(what: string, fn: () => T): T | DoctorCheck => {
    try { return fn() } catch (e) { return add('warn', what, `the check failed: ${errText(e)}`) }
  }
  const sw = guard('switches', () => switchesCheck(o, add))
  checks.push(sw)
  const facts = guard('toolchain', () => packageChecks(o, add))
  const pkg = 'checks' in facts ? facts.pkg : undefined
  if ('checks' in facts) checks.push(...facts.checks)
  else checks.push(facts)
  checks.push(guard('bun', () => bunCheck(o, add)))
  checks.push(await smokeCheck(o, pkg, add))
  const handshake = guard('handshake', () => handshakeCheck(o, pkg, add))
  if (handshake !== undefined) checks.push(handshake)
  const storage = guard('storage', () => storageChecks(o, add))
  checks.push(...(Array.isArray(storage) ? storage : [storage]))
  const foreign = cmForeignInstalls(o)
  if (foreign.length === 0) {
    checks.push(add('ok', 'foreign installs', 'none: no context-mode plugin, server or hooks of its own in Claude Code, Codex, OpenCode or omp, and no global context-mode CLI'))
  }
  for (const f of foreign) {
    const managed = f.harness === undefined || o.config.harnesses[f.harness]?.enabled !== false
    checks.push(add(managed ? 'warn' : 'info', f.check, f.detail))
  }
  checks.push(telemetryCheck(o, foreign, add))
  return checks
}

function telemetryCheck(o: CmDoctorOptions, foreign: readonly CmForeignInstall[], add: (level: DoctorLevel, check: string, detail: string) => DoctorCheck): DoctorCheck {
  const files = cmPlatformFiles(o.env ?? process.env)
  const present = files.filter(f => existsSync(f))
  if (present.length === 0) return add('ok', 'telemetry', `no ${files.map(tilde).join(' or ')} (context-mode's hook scripts would forward nothing to its hosted platform)`)
  const many = present.length > 1
  const what = `${present.map(tilde).join(' and ')} ${many ? 'exist: while they do' : 'exists: while it does'}, context-mode's hook scripts (run by its Claude Code and Codex plugins) forward session events to its hosted platform. Buracle runs none of them`
  const file = many ? 'the files' : 'the file'
  const runners = [...new Set(foreign.filter(f => f.runsHooks === true).map(f => f.check))]
  if (runners.length === 0) return add('warn', 'telemetry', `${what}, and none of them was found installed; delete ${file} unless a context-mode setup outside Buracle uses ${many ? 'them' : 'it'}`)
  const one = runners.length === 1
  return add('error', 'telemetry', `${what}, but the context-mode install${one ? '' : 's'} above (${runners.join(', ')}) ${one ? 'does' : 'do'}: remove ${one ? 'it' : 'them'} or delete ${file}`)
}
