import { accessSync, constants, existsSync, lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { Adapter } from '../../adapters/registry'
import type { CanonicalBundle, McpCatalog, ToolSpec } from '../../core/catalog'
import type { Harness } from '../../core/events'
import { runtimeConfigSnapshot } from '../config'
import { listTxns, readLedgerSync as loadLedgerForDoctor } from '../txn'
import { readTextSync, sha256 } from '../fsx'
import { DAY_MS, scanHookFailures } from '../hook-health'
import * as paths from '../paths'
import { exeName, isWindows, spawnArgv } from '../platform'
import type { LiveContext } from './context'
import { opsDeps } from './deps'
import { buracleHomeProblem, pathLink } from './install-core'
import { probeServers, writeHealth, type McpHealthEntry, type ToolHealthEntry } from './mcp'
import { errText, tilde, tildeText } from './output'
import { checkoutGitState, packagesProblem, parseShimText, runtimeDirOf, runtimeHealth, type ShimInfo } from './runtime'
import { readUpdatesCache } from './updates-cache'
import { windowsLauncher } from '../toolchain/links'
import { binArgv } from '../toolchain/packages'
import { readToolchainState, type ToolchainState } from '../toolchain/state'
import { toolPackage } from '../toolchain/index'
import { installAdvice } from '../toolchain/system'

export type DoctorLevel = 'ok' | 'info' | 'warn' | 'error'
export interface DoctorCheck { section: string; level: DoctorLevel; check: string; detail: string }

const RANK: Record<DoctorLevel, number> = { ok: 0, info: 0, warn: 1, error: 2 }

export function doctorExit(checks: readonly DoctorCheck[]): number {
  const worst = Math.max(0, ...checks.map(c => RANK[c.level] ?? 0))
  return worst === 2 ? 1 : worst === 1 ? 2 : 0
}

export function parseShim(text: string): { bun: string, main: string } | undefined {
  const info = parseShimText(text)
  return info === undefined ? undefined : { bun: info.bun, main: info.main }
}

export function shimCheck(info: ShimInfo | undefined, repoRoot: string): { level: DoctorLevel, detail: string } {
  const shim = tilde(paths.shimPath())
  if (info === undefined) return { level: 'warn', detail: `${shim} is not a Buracle shim; run \`buracle install\`` }
  if (!isExecutable(info.bun)) return { level: 'error', detail: `the shim's bun (${tilde(info.bun)}) is missing; run \`buracle install\`` }
  const checkoutMain = join(repoRoot, 'src', 'cli', 'main.ts')
  if (info.mode === 'frozen') {
    const dir = runtimeDirOf(info)
    if (dir === undefined) return { level: 'warn', detail: `${shim} runs ${tilde(info.main)}, which is not a runtime under ${tilde(paths.runtimeRoot())}; run \`buracle install\`` }
    if (info.checkout !== undefined && resolve(info.checkout) !== resolve(repoRoot)) return { level: 'warn', detail: `${shim} runs a runtime copied from another checkout (${tilde(info.checkout)}); run \`buracle install\` from this one` }
    return { level: 'ok', detail: `${shim} runs the frozen runtime ${tilde(dir)} with ${tilde(info.bun)} (mode: frozen)` }
  }
  if (resolve(info.main) !== resolve(checkoutMain)) return { level: 'warn', detail: `${shim} runs another checkout (${tilde(info.main)}); run \`buracle install\` from this one` }
  const why = info.mode === 'legacy' ? 'a shim from before frozen runtimes' : 'it was installed with BURACLE_RUNTIME=checkout'
  return { level: 'warn', detail: `${shim} runs this checkout directly (mode: checkout; ${why}): every edit there reaches the hooks at once, and a broken file blocks the guarded tool calls; run \`buracle install\` to freeze a checked runtime` }
}

function isExecutable(p: string): boolean {
  try { accessSync(p, constants.X_OK); return statSync(p).isFile() } catch { return false }
}

export function configChecks(live: LiveContext, bundle: { bundle: CanonicalBundle } | { error: string, problems: string[] }, repoRoot: string): DoctorCheck[] {
  const s = 'config'
  const out: DoctorCheck[] = []
  const add = (level: DoctorLevel, check: string, detail: string) => out.push({ section: s, level, check, detail: tildeText(detail) })
  const userFile = paths.userConfigFile()
  if (live.loaded.errors.length === 0 && live.loaded.warnings.length === 0) add('ok', 'config', live.loaded.files.userExists ? `${tilde(userFile)} is valid` : `no ${tilde(userFile)}; using the defaults`)
  for (const e of live.loaded.errors) add('error', 'config', `${e} (the default is used instead)`)
  for (const w of live.loaded.warnings) add('warn', 'config', w)
  if ('bundle' in bundle) {
    add('ok', 'canonical', `${bundle.bundle.skills.length} skill(s), ${bundle.bundle.rules.length} rule(s), ${bundle.bundle.agents.length} agent(s), ${Object.keys(bundle.bundle.mcp.servers).length} MCP server(s)`)
    for (const m of bundle.bundle.missing) add('warn', 'canonical', `canonical/${m} is missing; empty defaults are used`)
    for (const w of bundle.bundle.warnings) add('warn', 'canonical', w)
  } else {
    for (const p of bundle.problems) add('error', 'canonical', p)
  }
  const rc = readTextSync(paths.runtimeConfigFile())
  const want = JSON.stringify(runtimeConfigSnapshot(live.config), null, 2) + '\n'
  if (!rc.ok) add('warn', 'runtime-config', `${tilde(paths.runtimeConfigFile())} is missing; run \`buracle install\``)
  else if (rc.value !== want) add('warn', 'runtime-config', 'stale snapshot of the configuration; run `buracle install` (or `buracle build`) to refresh it')
  else add('ok', 'runtime-config', 'snapshot matches the configuration')
  const shim = readTextSync(join(paths.binDir(), 'buracle'))
  if (!shim.ok) add('warn', 'shim', `${tilde(paths.shimPath())} is missing; run \`buracle install\``)
  else {
    const c = shimCheck(parseShimText(shim.value), repoRoot)
    add(c.level, 'shim', c.detail)
  }
  if (isWindows()) {
    // Windows has a launcher file on PATH instead of a symlink.
    const launcher = `${pathLink()}.cmd`
    const text = readTextSync(launcher)
    if (!text.ok) add('warn', 'path-link', `${tilde(launcher)} is missing; run \`buracle install\``)
    else if (text.value !== windowsLauncher(paths.shimPath())) add('warn', 'path-link', `${tilde(launcher)} does not start ${tilde(paths.shimPath())}; run \`buracle install\``)
    else add('ok', 'path-link', `${tilde(launcher)} → shim`)
  } else {
    let link: string | undefined
    try { if (lstatSync(pathLink()).isSymbolicLink()) link = readlinkSync(pathLink()) } catch {  }
    if (link === undefined) add('warn', 'path-link', `${tilde(pathLink())} is missing or not a symlink`)
    else if (resolve(paths.localBinDir(), link) !== paths.shimPath()) add('warn', 'path-link', `${tilde(pathLink())} points to ${link}, not the shim`)
    else add('ok', 'path-link', `${tilde(pathLink())} → shim`)
  }
  const onPath = (process.env['PATH'] ?? '').split(delimiter).some(d => d !== '' && resolve(d) === paths.localBinDir())
  if (!onPath) add('warn', 'PATH', `${tilde(paths.localBinDir())} is not on PATH; add it or call ${tilde(paths.shimPath())} directly`)
  const brain = paths.brainDir()
  add('ok', 'brain', existsSync(brain) ? `${tilde(brain)} exists` : `${tilde(brain)} is created by the first memory write`)
  const homeProblem = buracleHomeProblem()
  if (homeProblem !== undefined) add('error', 'buracle-home', homeProblem)
  let ledger: Record<string, { path: string, owner: string }> = {}
  try { ledger = loadLedgerForDoctor() } catch {  }
  out.push(...shimReferenceChecks(ledger, repoRoot))
  return out
}

const SHIM_REF = /(\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}|\$[A-Za-z_][A-Za-z0-9_]*|~|\/)([^\s"'\\`]*?)\/bin\/buracle(?![A-Za-z0-9_.-])/g

export function expandShellWord(word: string, env: Readonly<Record<string, string | undefined>> = process.env): { value: string, missing: string[] } {
  const missing: string[] = []
  const get = (name: string): string | undefined => {
    const v = env[name] ?? (name === 'HOME' ? env['USERPROFILE'] : undefined)
    return v === undefined || v === '' ? undefined : v
  }
  let out = word.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced: string | undefined, dflt: string | undefined, bare: string | undefined) => {
    const name = (braced ?? bare) as string
    const v = get(name)
    if (v !== undefined) return v
    if (dflt !== undefined) {
      const d = expandShellWord(dflt, env)
      missing.push(...d.missing)
      return d.value
    }
    missing.push(name)
    return ''
  })
  if (out === '~' || out.startsWith('~/')) out = join(get('HOME') ?? paths.home(), out.slice(1))
  return { value: out, missing }
}

export function shimReferences(text: string, env: Readonly<Record<string, string | undefined>> = process.env): Array<{ raw: string, path: string, missing: string[] }> {
  const out: Array<{ raw: string, path: string, missing: string[] }> = []
  const seen = new Set<string>()
  for (const m of text.matchAll(SHIM_REF)) {
    const raw = m[0]
    if (seen.has(raw)) continue
    seen.add(raw)
    const e = expandShellWord(raw, env)
    out.push({ raw, path: e.value, missing: e.missing })
  }
  return out
}

function commandFile(p: string): boolean {
  return /\.(json|jsonc|toml|ya?ml|md|sh)$/i.test(p) || !/\.[A-Za-z0-9]+$/.test(p)
}

export function shimReferenceChecks(ledger: Readonly<Record<string, { path: string, owner: string }>>, repoRoot: string, env: Readonly<Record<string, string | undefined>> = process.env): DoctorCheck[] {
  const files = new Set<string>()
  const owners = new Set<string>()
  for (const e of Object.values(ledger)) {
    owners.add(e.owner)
    if (commandFile(e.path) && !resolve(e.path).startsWith(resolve(paths.binDir()) + '/')) files.add(e.path)
  }
  for (const h of ['claude', 'omp']) if (owners.has(h)) files.add(join(repoRoot, 'harness', h, '.mcp.json'))
  if (owners.has('claude')) {
    files.add(join(repoRoot, 'harness', 'claude', 'hooks', 'hooks.json'))
    files.add(join(repoRoot, 'harness', 'claude', 'bin', 'buracle'))
  }
  const claudePlugin = join(repoRoot, 'harness', 'claude')
  const envFor = (f: string): Readonly<Record<string, string | undefined>> =>
    resolve(f).startsWith(resolve(claudePlugin) + '/') ? { ...env, CLAUDE_PLUGIN_ROOT: claudePlugin } : env
  const out: DoctorCheck[] = []
  let ok = 0
  for (const f of [...files].sort()) {
    let text: string
    try {
      const st = statSync(f)
      if (!st.isFile() || st.size > 2_000_000) continue
      const r = readTextSync(f)
      if (!r.ok) continue
      text = r.value
    } catch { continue }
    if (/\.sh$/i.test(f) || !/\.[A-Za-z0-9]+$/.test(f)) text = text.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    for (const ref of shimReferences(text, envFor(f))) {
      const level: DoctorLevel = /\.md$/i.test(f) ? 'warn' : 'error'
      if (ref.missing.length > 0) {
        out.push({ section: 'config', level, check: 'shim-refs', detail: `${tilde(f)} runs ${ref.raw}, which uses ${ref.missing.map(v => `$${v}`).join(', ')} (not set here)` })
      } else if (!isExecutable(ref.path)) {
        const hint = paths.buracleHome() !== join(paths.home(), '.buracle') ? ` (BURACLE_HOME is ${tilde(paths.buracleHome())}; run \`buracle install\` again so the command runs ${tilde(paths.shimPath())})` : '; run `buracle install`'
        out.push({ section: 'config', level, check: 'shim-refs', detail: `${tilde(f)} runs ${ref.raw} → ${tilde(ref.path)}, which does not exist${hint}` })
      } else ok++
    }
  }
  if (out.length === 0 && ok > 0) out.push({ section: 'config', level: 'ok', check: 'shim-refs', detail: `${ok} command(s) that run the shim resolve to an existing executable` })
  return out
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as { code?: string }).code === 'EPERM' }
}

export function staleLockChecks(nowMs: number): DoctorCheck[] {
  const s = 'runtime'
  const out: DoctorCheck[] = []
  const locks: Array<[string, string]> = [['txn.lock', paths.txnLockFile()], ['toolchain lock', `${paths.toolchainStateFile()}.lock`]]
  for (const [name, file] of locks) {
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { continue }
    let pid: unknown
    let at: number | undefined
    try {
      const j = JSON.parse(text) as { pid?: unknown, startedAt?: unknown, at?: unknown }
      pid = j.pid
      at = typeof j.startedAt === 'number' ? j.startedAt : typeof j.at === 'number' ? j.at : undefined
    } catch { pid = Number.parseInt(text.trim(), 10) }
    if (at === undefined) { try { at = statSync(file).mtimeMs } catch { at = undefined } }
    const age = at !== undefined ? Math.round((nowMs - at) / 60_000) : undefined
    if (!pidAlive(pid)) out.push({ section: s, level: 'warn', check: 'locks', detail: `${tilde(file)} (${name}) is stale: its process ${String(pid)} is gone; delete the file if no buracle command is running` })
    else if (age !== undefined && age > 60) out.push({ section: s, level: 'warn', check: 'locks', detail: `${tilde(file)} (${name}) has been held for ${age} min by process ${String(pid)}` })
  }
  return out
}

export async function journalChecks(): Promise<DoctorCheck[]> {
  const s = 'runtime'
  let journals
  try { journals = await listTxns() } catch (e) { return [{ section: s, level: 'warn', check: 'journals', detail: `the transaction journals cannot be read: ${errText(e)}` }] }
  const out: DoctorCheck[] = []
  for (const j of journals.filter(x => x.status === 'rollback-failed')) {
    out.push({ section: s, level: 'error', check: 'journals', detail: `transaction ${j.txn} could not be rolled back completely${j.error !== undefined ? ` (${tildeText(j.error.split('\n')[0] ?? '')})` : ''}; fix the cause, then run \`buracle rollback ${j.txn}\`` })
  }
  let lockHeld = false
  try {
    const t = readFileSync(paths.txnLockFile(), 'utf8')
    let pid: unknown
    try { pid = (JSON.parse(t) as { pid?: unknown }).pid } catch { pid = Number.parseInt(t.trim(), 10) }
    lockHeld = pidAlive(pid)
  } catch { lockHeld = false }
  for (const j of journals.filter(x => x.status === 'applying')) {
    if (!lockHeld) out.push({ section: s, level: 'warn', check: 'journals', detail: `transaction ${j.txn} was interrupted while applying; the next \`buracle install\` (or \`buracle rollback ${j.txn}\`) rolls it back` })
  }
  if (out.length === 0) out.push({ section: s, level: 'ok', check: 'journals', detail: `${journals.length} transaction(s), none unsettled` })
  return out
}

export async function generatedChecks(repoRoot: string, bundle: { bundle: CanonicalBundle } | { error: string, problems: string[] }): Promise<DoctorCheck[]> {
  const s = 'runtime'
  const manifest = readTextSync(join(repoRoot, 'harness', '.manifest.json'))
  if (!manifest.ok) return [{ section: s, level: 'warn', check: 'generated', detail: `${tilde(join(repoRoot, 'harness', '.manifest.json'))} is missing; run \`buracle build\`` }]
  let files: Record<string, { sha256?: unknown }> = {}
  try { files = (JSON.parse(manifest.value) as { files?: Record<string, { sha256?: unknown }> }).files ?? {} } catch { return [{ section: s, level: 'warn', check: 'generated', detail: 'harness/.manifest.json does not parse; run `buracle build`' }] }
  const changed: string[] = []
  for (const [rel, e] of Object.entries(files)) {
    try { if (sha256(readFileSync(join(repoRoot, rel))) !== e.sha256) changed.push(rel) } catch { changed.push(rel) }
  }
  const out: DoctorCheck[] = []
  if (changed.length > 0) out.push({ section: s, level: 'warn', check: 'generated', detail: `${changed.length} generated file(s) differ from harness/.manifest.json (${changed.slice(0, 4).join(', ')}${changed.length > 4 ? ', ...' : ''}); run \`buracle build\` (\`buracle build --check\` lists them)` })
  if ('bundle' in bundle) {
    try {
      const { canonicalContentHash } = await import('../../adapters/claude/plugin')
      const meta = readTextSync(join(repoRoot, 'harness', 'claude', 'hooks', 'generated', 'meta.ts'))
      const built = meta.ok ? /"contentHash":\s*"([0-9a-f]{64})"/.exec(meta.value)?.[1] : undefined
      if (built !== undefined && built !== canonicalContentHash(bundle.bundle)) out.push({ section: s, level: 'warn', check: 'generated', detail: 'canonical/ changed after the last `buracle build`: harness/ is out of date; run `buracle install`' })
    } catch {  }
  }
  if (out.length === 0) out.push({ section: s, level: 'ok', check: 'generated', detail: `${Object.keys(files).length} generated file(s) match the manifest and canonical/` })
  return out
}

export async function runtimeChecks(repoRoot: string, bundle: { bundle: CanonicalBundle } | { error: string, problems: string[] }, nowMs: number): Promise<DoctorCheck[]> {
  const s = 'runtime'
  const out: DoctorCheck[] = []
  const add = (level: DoctorLevel, check: string, detail: string) => out.push({ section: s, level, check, detail: tildeText(detail) })
  const h = runtimeHealth(repoRoot)
  if (h.shim === undefined) add('info', 'runtime', 'no Buracle shim to read, so no runtime to compare (the shim row says what to do)')
  else if (h.shim.mode !== 'frozen') add('info', 'runtime', `the shim runs ${tilde(h.shim.main)} directly (mode: checkout); there is no frozen runtime`)
  else {
    for (const p of h.problems) add('error', 'runtime', p)
    if (h.problems.length === 0 && h.drift !== undefined) add(h.drift === 'current' ? 'ok' : 'warn', 'runtime', h.detail ?? h.drift)
    if (h.dir !== undefined && existsSync(h.dir)) {
      const pk = packagesProblem(h.dir)
      if (pk !== undefined) add('error', 'runtime packages', `the live runtime's ${pk.replace(/; run .*$/, '')}; run \`buracle install\``)
    }
  }
  const pk = packagesProblem(repoRoot)
  if (pk !== undefined) add('warn', 'node_modules', pk)
  else add('ok', 'node_modules', 'the checkout\'s runtime packages match package.json and bun.lock')
  const g = checkoutGitState(repoRoot)
  if (g.dirty === true) add('info', 'checkout', `${tilde(repoRoot)} has uncommitted changes${h.shim?.mode === 'frozen' ? ' (they reach the hooks only after `buracle install`)' : ''}`)
  const f = scanHookFailures(nowMs, DAY_MS)
  if (f.failures === 0) add('ok', 'hooks', 'no Buracle hook failed in the last 24 h')
  else {
    const last = f.last
    const where = last !== undefined ? `; last ${last.ts}${last.harness !== undefined ? ` ${last.harness}` : ''}${last.event !== undefined ? ` ${last.event}` : ''}${last.error !== undefined ? `: ${last.error}` : ''}` : ''
    add('warn', 'hooks', `${f.failures} Buracle hook failure(s) in the last 24 h, ${f.failClosed} of them denied the tool call (fail closed)${where}; see ${tilde(paths.logFile())}`)
  }
  out.push(...await journalChecks())
  out.push(...staleLockChecks(nowMs))
  out.push(...await generatedChecks(repoRoot, bundle))
  return out
}

export interface ToolResult { name: string; status: 'ok' | 'missing' | 'error'; version?: string; detail: string }

function versionOf(t: ToolSpec, out: { stdout: string, stderr: string }): string | undefined {
  try { return new RegExp(t.version_regex, 'm').exec(`${out.stdout}\n${out.stderr}`)?.[1] } catch { return undefined }
}

// A tool's first start on Windows (Python compiling its modules, an antivirus scan of a new binary) takes longer
// than 5 s, so its version check gets 20 s there.
const TOOL_CHECK_MS = process.platform === 'win32' ? 20_000 : 5000

export async function checkTools(tools: readonly ToolSpec[], timeoutMs = TOOL_CHECK_MS, state: ToolchainState = readToolchainState()): Promise<ToolResult[]> {
  return Promise.all(tools.map(async (t): Promise<ToolResult> => {
    const r = await opsDeps.run(t.check, { timeoutMs })
    if (r.code === 127) {
      const pkg = toolPackage(t, state)
      const local = pkg === undefined ? paths.toolchainBinDirs().map(d => join(d, exeName(t.check[0] ?? t.name))).find(p => existsSync(p)) : undefined
      if (local !== undefined) {
        const rr = await opsDeps.run(spawnArgv([local, ...t.check.slice(1)]), { timeoutMs })
        const v = versionOf(t, rr)
        if (rr.code !== 0 && v === undefined) return { name: t.name, status: 'error', detail: `the Buracle toolchain copy (${tilde(local)}) does not run: exit ${rr.code}${rr.timedOut ? ' (timed out)' : ''}; run \`buracle install\`` }
        return v !== undefined ? { name: t.name, status: 'ok', version: v, detail: `${v} (Buracle toolchain, ${tilde(local)})` } : { name: t.name, status: 'ok', detail: `present (version not recognized; Buracle toolchain, ${tilde(local)})` }
      }
      if (pkg === undefined) return { name: t.name, status: 'missing', detail: 'not found on PATH or in the Buracle toolchain' }
      const entry = pkg.bins[(t.bins ?? [t.name])[0] ?? t.name]
      const argv = entry !== undefined ? binArgv(entry) : undefined
      const rr = argv !== undefined ? await opsDeps.run([...argv, ...t.check.slice(1)], { timeoutMs }) : undefined
      const v = rr !== undefined ? versionOf(t, rr) ?? pkg.version : pkg.version
      if (rr !== undefined && rr.code !== 0 && versionOf(t, rr) === undefined) return { name: t.name, status: 'error', detail: `the Buracle toolchain copy (${pkg.registry} ${pkg.name} ${pkg.version}) does not run: exit ${rr.code}; run \`buracle install\`` }
      return { name: t.name, status: 'ok', version: v, detail: `${v} (Buracle toolchain)` }
    }
    const version = versionOf(t, r)
    if (r.code !== 0 && version === undefined) return { name: t.name, status: 'error', detail: `\`${t.check.join(' ')}\` exited ${r.code}${r.timedOut ? ' (timed out)' : ''}` }
    return version !== undefined ? { name: t.name, status: 'ok', version, detail: version } : { name: t.name, status: 'ok', detail: 'present (version not recognized)' }
  }))
}

function advice(t: ToolSpec): string {
  if (t.npm !== undefined || t.pypi !== undefined) return '`buracle install` (into ~/.buracle/toolchain)'
  return installAdvice(t)
}

export function toolChecks(tools: readonly ToolSpec[], results: readonly ToolResult[]): DoctorCheck[] {
  return results.map((r, i) => {
    const t = tools[i] as ToolSpec
    if (r.status === 'ok') return { section: 'tools', level: 'ok', check: r.name, detail: r.detail }
    const level: DoctorLevel = t.required ? 'error' : 'warn'
    return { section: 'tools', level, check: r.name, detail: `${r.detail}${t.required ? ' (required)' : ' (optional)'}; suggestion: ${advice(t)}${t.purpose ? ` (${t.purpose})` : ''}` }
  })
}

export function toolchainChecks(state: ToolchainState): DoctorCheck[] {
  return Object.keys(state.packages).sort().flatMap(k => {
    const p = state.packages[k]
    if (p === undefined) return []
    const notes = [
      ...(p.previous !== undefined ? [`${p.previous.version} kept for \`buracle rollback toolchain\``] : []),
      ...(p.rolled_back !== undefined ? [`${p.rolled_back} was rolled back`] : []),
    ]
    return [{ section: 'tools', level: 'ok' as const, check: k, detail: `${p.version} in Buracle's toolchain${notes.length > 0 ? `; ${notes.join('; ')}` : ''}` }]
  })
}

export function toolHealth(results: readonly ToolResult[], nowIso: string): Record<string, ToolHealthEntry> {
  const out: Record<string, ToolHealthEntry> = {}
  for (const r of results) out[r.name] = r.version !== undefined ? { status: r.status, version: r.version, checked_at: nowIso } : { status: r.status, checked_at: nowIso }
  return out
}

export async function harnessChecks(adapters: readonly Adapter[], live: LiveContext, only?: Harness): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = []
  for (const a of adapters) {
    if (only !== undefined && a.harness !== only) continue
    const s = a.harness
    if (live.config.harnesses[a.harness]?.enabled === false) { out.push({ section: s, level: 'info', check: 'enabled', detail: `disabled in config (harnesses.${s}.enabled=false)` }); continue }
    let det: { installed: boolean, version?: string, path?: string }
    try { det = await a.detect() } catch (e) { out.push({ section: s, level: 'error', check: 'detect', detail: errText(e) }); continue }
    if (!det.installed) {
      out.push({ section: s, level: only === s ? 'warn' : 'info', check: 'installed', detail: 'not installed; skipped' })
      continue
    }
    out.push({ section: s, level: 'ok', check: 'installed', detail: `${det.version ?? 'unknown version'}${det.path ? ` (${tilde(det.path)})` : ''}` })
    try {
      const found = await a.doctor(live.ctx)
      if (!Array.isArray(found)) throw new Error('doctor() did not return a list')
      for (const f of found) {
        const level: DoctorLevel = f.level === 'ok' || f.level === 'warn' || f.level === 'error' ? f.level : 'warn'
        out.push({ section: s, level, check: String(f.check), detail: tildeText(String(f.detail)) })
      }
    } catch (e) {
      out.push({ section: s, level: 'error', check: 'doctor', detail: errText(e) })
    }
  }
  return out
}

export function skillChecks(skillIds: readonly string[], repoRoot: string, harnesses: { claude: boolean, shared: boolean }): DoctorCheck[] {
  const s = 'skills'
  const out: DoctorCheck[] = []
  if (harnesses.claude) {
    const missing = skillIds.filter(id => !existsSync(join(repoRoot, 'harness', 'claude', 'skills', id, 'SKILL.md')))
    out.push(missing.length === 0
      ? { section: s, level: 'ok', check: 'claude plugin', detail: `${skillIds.length} skill(s) in the plugin (/<id> or /buracle:<id>)` }
      : { section: s, level: 'error', check: 'claude plugin', detail: `missing from harness/claude/skills: ${missing.join(', ')}; run \`buracle build\`` })
  }
  if (harnesses.shared) {
    const dir = join(paths.agentsDir(), 'skills')
    const absent: string[] = []
    const foreign: string[] = []
    for (const id of skillIds) {
      const link = join(dir, id)
      if (!existsSync(join(link, 'SKILL.md'))) { absent.push(id); continue }
      try {
        if (lstatSync(link).isSymbolicLink() && !resolve(dir, readlinkSync(link)).startsWith(resolve(repoRoot, 'harness', 'agents-skills'))) foreign.push(id)
      } catch {  }
    }
    if (absent.length > 0) out.push({ section: s, level: 'error', check: 'shared (~/.agents/skills)', detail: `not readable by Codex, OpenCode and Oh My Pi: ${absent.join(', ')}; run \`buracle install\`` })
    else out.push({ section: s, level: 'ok', check: 'shared (~/.agents/skills)', detail: `${skillIds.length} skill(s) for Codex, OpenCode and Oh My Pi` })
    if (foreign.length > 0) out.push({ section: s, level: 'warn', check: 'shared links', detail: `point outside this checkout (kept as yours): ${foreign.join(', ')}` })
  }
  return out
}

export async function mcpChecks(catalog: McpCatalog, timeoutMs: number, nowIso: () => string): Promise<{ checks: DoctorCheck[], entries: Record<string, McpHealthEntry> }> {
  const entries = await probeServers(catalog, { timeoutMs, fetcher: opsDeps.fetch, buracle: paths.shimPath() }, nowIso)
  const checks: DoctorCheck[] = []
  for (const id of Object.keys(entries).sort()) {
    const e = entries[id] as McpHealthEntry
    const spec = catalog.servers[id]
    if (e.status === 'ok') {
      checks.push({ section: 'mcp', level: 'ok', check: id, detail: `${e.tools ?? 0} tool(s)${e.version !== undefined ? `, v${e.version}` : ''}, ${e.ms} ms` })
    } else {
      checks.push({ section: 'mcp', level: spec?.critical ? 'error' : 'warn', check: id, detail: `down: ${tildeText(e.error ?? 'no answer')}` })
    }
  }
  return { checks, entries }
}

export async function runMcpDoctor(catalog: McpCatalog, timeoutMs: number): Promise<DoctorCheck[]> {
  const now = () => new Date(opsDeps.now()).toISOString()
  const { checks, entries } = await mcpChecks(catalog, timeoutMs, now)
  try { writeHealth({ mcp: entries }, now()) } catch (e) { checks.push({ section: 'mcp', level: 'warn', check: 'health.json', detail: errText(e) }) }
  return checks
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function asLevel(x: unknown): DoctorLevel {
  return x === 'ok' || x === 'info' || x === 'warn' || x === 'error' ? x : x === 'warning' ? 'warn' : 'info'
}

export async function memoryChecks(): Promise<DoctorCheck[]> {
  const s = 'memory'
  const r = await opsDeps.runCli(['mem', 'doctor', '--json', '--no-mcp'])
  const all = `${r.stdout}\n${r.stderr}`
  if (r.code !== 0 && /not implemented|unknown (sub)?command|unknown command/i.test(all)) {
    return [{ section: s, level: 'info', check: 'mem doctor', detail: 'not available yet; skipped' }]
  }
  let parsed: unknown
  try { parsed = JSON.parse(r.stdout) } catch { parsed = undefined }
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed['checks']) ? parsed['checks'] : undefined
  if (list) {
    return list.filter(isRecord).map(c => {
      const check = String(c['check'] ?? c['name'] ?? 'memory')
      const level = asLevel(c['level'] ?? c['status'])
      const detail = check === 'mcp' && level === 'info' ? 'the buracle-memory handshake runs in the mcp section (`buracle doctor mcp`)' : tildeText(String(c['detail'] ?? c['message'] ?? ''))
      return { section: s, level, check, detail }
    })
  }
  if (isRecord(parsed) && typeof parsed['health'] === 'string') {
    const reasons = Array.isArray(parsed['reasons']) ? parsed['reasons'].map(String).join('; ') : ''
    return [{ section: s, level: asLevel(parsed['health']), check: 'health', detail: reasons || String(parsed['health']) }]
  }
  const firstLine = (r.stderr.trim() || r.stdout.trim()).split('\n')[0] ?? ''
  if (r.code === 0) return [{ section: s, level: 'ok', check: 'mem doctor', detail: firstLine || 'passed' }]
  return [{ section: s, level: r.code === 2 ? 'warn' : 'error', check: 'mem doctor', detail: tildeText(firstLine || `exit ${r.code}`) }]
}

export const UPDATE_CACHE_MAX_AGE_DAYS = 7

export function updateChecks(nowMs: number): DoctorCheck[] {
  const c = readUpdatesCache()
  if (!c) return [{ section: 'updates', level: 'info', check: 'cache', detail: 'never checked; run `buracle update --check`' }]
  const t = Date.parse(c.checked_at)
  const ageDays = Number.isNaN(t) ? Infinity : (nowMs - t) / 86_400_000
  const age = Number.isFinite(ageDays) ? (ageDays < 1 ? `${Math.max(0, Math.round(ageDays * 24))} h` : `${Math.round(ageDays)} d`) : 'unknown age'
  const out: DoctorCheck[] = []
  if (ageDays > UPDATE_CACHE_MAX_AGE_DAYS) out.push({ section: 'updates', level: 'warn', check: 'cache', detail: `last checked ${age} ago; run \`buracle update --check\`` })
  else out.push({ section: 'updates', level: 'ok', check: 'cache', detail: `last checked ${age} ago` })
  if (c.items.length > 0) out.push({ section: 'updates', level: 'info', check: 'available', detail: `${c.items.length} update(s): ${c.items.slice(0, 6).map(i => `${i.kind}:${i.id}`).join(', ')}${c.items.length > 6 ? ', …' : ''} (\`buracle update --yes\`)` })
  return out
}
