import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { Adapter, AdapterContext } from '../../adapters/registry'
import type { CanonicalBundle, ToolSpec } from '../../core/catalog'
import { isPackageServer, validateMcpCatalog } from '../../core/catalog'
import type { BuracleConfig } from '../../core/config'
import type { Harness } from '../../core/events'
import { atomicWriteSync } from '../fsx'
import { packageServers, type ToolchainEvent } from '../toolchain/index'
import { toolRequest } from '../toolchain/packages'
import { packageKey, readToolchainState } from '../toolchain/state'
import { yamlParse } from '../merge'
import * as paths from '../paths'
import { opsDeps } from './deps'
import * as gitops from './gitops'
import { bunPath } from './install-core'
import { detectOrigin, harnessUpdate, isBrewName, resolveBinary, type Origin } from './origin'
import { errText, isInside } from './output'
import { TESTED_WITH } from './tested-with'
import type { HeldItem, UpdateError, UpdateItem, UpdateKind } from './updates-cache'
import { bumpRisk, compareVersions, parseVersionString, pickUpdate, type PublishedVersion, type Risk } from './versions'
import { setYamlValue } from './yaml-edit'

export { TESTED_WITH }

interface HarnessSource { npm?: string; url?: string }
export const HARNESS_SOURCES: Readonly<Record<Harness, HarnessSource>> = {
  claude: { npm: '@anthropic-ai/claude-code' },
  codex: { npm: '@openai/codex' },
  opencode: { url: 'https://opencode.ai/update/api/latest/cli/npm' },
  omp: { npm: '@oh-my-pi/pi-coding-agent' },
}

export const BREW_CHECK_ENV: Readonly<Record<string, string>> = { HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1' }

export interface UpdateEnv {
  repoRoot: string
  config: BuracleConfig
  bundle?: CanonicalBundle
  adapters: readonly Adapter[]
  nowMs: number
  ctx?: AdapterContext
  onToolchainEvent?: (e: ToolchainEvent) => void
  onStep?: (e: UpdateStep) => void
}

// One step of an apply as it happens: `start` while it runs, then one `done` for each part it
// applied, skipped or failed (the first reuses the step's id).
export type UpdateStep =
  | { phase: 'start', id: string, label: string }
  | { phase: 'done', id: string, outcome: 'ok' | 'skip' | 'err', label: string }

export interface CheckResult { items: UpdateItem[]; held: HeldItem[]; errors: UpdateError[]; notes: string[]; unchecked: Array<{ kind: UpdateKind, reason: string }> }

export type CheckStep = { kind: UpdateKind, phase: 'start' } | { kind: UpdateKind, phase: 'done', result: CheckResult }

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function maxRisk(a: Risk, b: Risk): Risk {
  const r = { low: 0, medium: 1, high: 2 } as const
  return r[a] >= r[b] ? a : b
}

const DAY_MS = 86_400_000

export function npmUrl(pkg: string): string {
  return pkg.startsWith('@') ? `https://registry.npmjs.org/@${encodeURIComponent(pkg.slice(1))}` : `https://registry.npmjs.org/${encodeURIComponent(pkg)}`
}

export function pypiUrl(name: string): string {
  return `https://pypi.org/pypi/${encodeURIComponent(name)}/json`
}

export interface RegistryVersions { latestTag?: string; versions: PublishedVersion[] }

export async function npmVersions(pkg: string): Promise<RegistryVersions | { error: string }> {
  const r = await opsDeps.fetch(npmUrl(pkg), { timeoutMs: 30_000 })
  if (!r.ok || !isRecord(r.json)) return { error: `npm ${pkg}: ${r.error ?? 'unexpected response'}` }
  const j = r.json
  const tags = isRecord(j['dist-tags']) ? j['dist-tags'] : {}
  const time = isRecord(j['time']) ? j['time'] : {}
  const vers = isRecord(j['versions']) ? j['versions'] : {}
  const versions: PublishedVersion[] = Object.keys(vers).map(v => {
    const meta = vers[v]
    const pv: PublishedVersion = { version: v }
    if (typeof time[v] === 'string') pv.publishedAt = time[v] as string
    if (isRecord(meta) && typeof meta['deprecated'] === 'string' && meta['deprecated'] !== '') pv.deprecated = true
    return pv
  })
  const out: RegistryVersions = { versions }
  if (typeof tags['latest'] === 'string') out.latestTag = tags['latest']
  return out
}

export async function pypiVersions(name: string): Promise<RegistryVersions | { error: string }> {
  const r = await opsDeps.fetch(pypiUrl(name), { timeoutMs: 30_000 })
  if (!r.ok || !isRecord(r.json)) return { error: `PyPI ${name}: ${r.error ?? 'unexpected response'}` }
  const j = r.json
  const info = isRecord(j['info']) ? j['info'] : {}
  const releases = isRecord(j['releases']) ? j['releases'] : {}
  const versions: PublishedVersion[] = []
  for (const [v, files] of Object.entries(releases)) {
    if (!Array.isArray(files) || files.length === 0) continue
    const times = files.filter(isRecord).map(f => (typeof f['upload_time_iso_8601'] === 'string' ? f['upload_time_iso_8601'] : typeof f['upload_time'] === 'string' ? `${f['upload_time']}Z` : undefined)).filter((t): t is string => t !== undefined).sort()
    const pv: PublishedVersion = { version: v }
    if (times[0] !== undefined) pv.publishedAt = times[0]
    if (files.every(f => isRecord(f) && f['yanked'] === true)) pv.yanked = true
    versions.push(pv)
  }
  const out: RegistryVersions = { versions }
  if (typeof info['version'] === 'string') out.latestTag = info['version']
  return out
}

export async function checkSelf(env: UpdateEnv, res: CheckResult): Promise<void> {
  const st = await gitops.upstreamStatus(env.repoRoot, { fetch: true })
  if (st.kind === 'no-repo') { res.unchecked.push({ kind: 'self', reason: 'the Buracle checkout is not a git repository' }); return }
  if (st.kind === 'no-upstream') { res.unchecked.push({ kind: 'self', reason: 'the current branch of the Buracle checkout has no upstream' }); return }
  if (st.kind === 'error') { res.errors.push({ kind: 'self', id: 'buracle', error: st.error }); return }
  if (st.behind === 0) return
  const diverged = st.ahead > 0
  const item: UpdateItem = { kind: 'self', id: 'buracle', current: st.head, latest: st.upstream, action: diverged ? 'manual' : 'ff-merge', risk: diverged ? 'high' : 'low', note: `${st.behind} commit(s) behind ${st.upstreamName}${diverged ? `, ${st.ahead} ahead (diverged; merge by hand)` : ''}${st.dirty ? '; uncommitted changes' : ''}` }
  res.items.push(item)
}

export function skillSourceDir(name: string): string {
  return join(paths.buracleHome(), 'skills', name)
}

export async function checkSkills(env: UpdateEnv, res: CheckResult): Promise<void> {
  for (const src of env.config.skills.sources) {
    if (src.git !== undefined) {
      const dir = skillSourceDir(src.name)
      if (!existsSync(dir)) {
        res.items.push({ kind: 'skills', id: src.name, current: null, latest: src.ref ?? null, action: 'clone', risk: 'low', note: `clone ${src.git} into ~/.buracle/skills/${src.name}`, command: ['git', 'clone', ...(src.ref !== undefined ? ['--branch', src.ref] : []), src.git, dir] })
        continue
      }
      await checkSkillDir(src.name, dir, res)
      continue
    }
    if (src.path === undefined) continue
    const expanded = paths.expandHome(src.path)
    const dir = isAbsolute(expanded) ? expanded : resolve(env.repoRoot, expanded)
    if (isInside(dir, env.repoRoot)) continue
    if (!existsSync(dir)) { res.errors.push({ kind: 'skills', id: src.name, error: `${src.path} does not exist` }); continue }
    await checkSkillDir(src.name, dir, res)
  }
  await checkAddedSkills(env, res)
}

function skillCtx(env: UpdateEnv): { cwd: string, now: number, env: Record<string, string | undefined> } {
  return { cwd: env.repoRoot, now: env.nowMs, env: { ...process.env } }
}

async function checkAddedSkills(env: UpdateEnv, res: CheckResult): Promise<void> {
  const { readInstalled, skillsUpdate } = await import('../../workflow/skill-install')
  const installed = readInstalled()
  if (installed.length === 0) return
  const r = await skillsUpdate(undefined, { dryRun: true }, skillCtx(env))
  const results = Array.isArray(r.data['skills']) ? r.data['skills'].filter(isRecord) : []
  for (const s of results) {
    const id = String(s['id'])
    const current = installed.find(x => x.id === id)?.commit?.slice(0, 12) ?? null
    const latest = typeof s['commit'] === 'string' ? s['commit'].slice(0, 12) : null
    if (s['action'] === 'would-update') res.items.push({ kind: 'skills', id, current, latest, action: 'skill-update', risk: 'low', source: 'buracle skills add' })
    else if (s['action'] === 'kept') {
      const note = s['reason'] === 'lint'
        ? `the new version has ${String(s['lint_errors'] ?? 'some')} lint error(s); \`buracle skills update ${id} --force\` installs it anyway`
        : `the installed copy has local edits; \`buracle skills update ${id} --force\` replaces them`
      res.items.push({ kind: 'skills', id, current, latest, action: 'manual', risk: 'medium', source: 'buracle skills add', note })
    }
  }
  for (const e of r.errors) res.errors.push({ kind: 'skills', id: e.split(':')[0] ?? 'skills', error: e })
}

async function checkSkillDir(name: string, dir: string, res: CheckResult): Promise<void> {
  const st = await gitops.upstreamStatus(dir, { fetch: true })
  if (st.kind === 'no-repo' || st.kind === 'no-upstream') return
  if (st.kind === 'error') { res.errors.push({ kind: 'skills', id: name, error: st.error }); return }
  if (st.behind === 0) return
  const diverged = st.ahead > 0
  res.items.push({ kind: 'skills', id: name, current: st.head, latest: st.upstream, action: diverged ? 'manual' : 'ff-merge', risk: diverged ? 'high' : 'low', note: `${st.behind} commit(s) behind ${st.upstreamName}${diverged ? `, ${st.ahead} ahead (diverged)` : ''}` })
}

export async function checkMcp(env: UpdateEnv, res: CheckResult): Promise<void> {
  if (!env.bundle) { res.errors.push({ kind: 'mcp', error: 'canonical/mcp.yaml could not be loaded' }); return }
  const minAgeDays = env.config.update.minReleaseAgeDays
  const servers = Object.entries(env.bundle.mcp.servers).sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const toolchain = readToolchainState()
  await Promise.all(servers.map(async ([id, spec]) => {
    const pkg = spec.package
    if (!pkg || pkg.registry === 'none') return
    const found = pkg.registry === 'npm' ? await npmVersions(pkg.name) : await pypiVersions(pkg.name)
    if ('error' in found) { res.errors.push({ kind: 'mcp', id, error: found.error }); return }
    const fromToolchain = isPackageServer(spec) && (spec.pin === 'latest' || pkg.version === 'latest')
    const have = fromToolchain ? toolchain.packages[packageKey(pkg.registry, pkg.name)] : undefined
    const installed = have?.version
    const current = fromToolchain ? installed : pkg.version
    const opts: { latestTag?: string, minAgeDays: number, nowMs: number } = { minAgeDays, nowMs: env.nowMs }
    if (found.latestTag !== undefined) opts.latestTag = found.latestTag
    const pick = pickUpdate(current, found.versions, opts)
    // A version an update rolled back because it failed its check is not offered again, only a newer one.
    if (pick.candidate !== undefined && pick.candidate !== have?.rolled_back) {
      const item: UpdateItem = {
        kind: 'mcp', id, current: current ?? null, latest: pick.candidate,
        action: fromToolchain ? 'toolchain-upgrade' : spec.pin === 'hard' ? 'bump-pin' : spec.pin === 'soft' ? 'review' : 'monitor',
        risk: current !== undefined ? bumpRisk(current, pick.candidate) : 'low',
      }
      const notes: string[] = [`${pkg.registry} ${pkg.name}`]
      if (fromToolchain) notes.push(current === undefined ? 'not in the Buracle toolchain yet' : 'Buracle toolchain (newest release)')
      if (spec.pin === 'soft') notes.push(`soft pin kept on purpose: ${spec.pin_reason ?? 'no reason given'}`)
      if (spec.pin === 'monitor') notes.push('monitored only; not bumped automatically')
      item.note = notes.join('; ')
      if (pick.candidatePublishedAt !== undefined) item.publishedAt = pick.candidatePublishedAt
      res.items.push(item)
    }
    if (pick.held) res.held.push({ kind: 'mcp', id, current: current ?? null, version: pick.held.version, publishedAt: pick.held.publishedAt, ageDays: pick.held.ageDays })
  }))
}

function parseJsonOutput(stdout: string): unknown {
  const t = stdout.trim()
  if (t === '') return undefined
  try { return JSON.parse(t) as unknown } catch {  }
  const last = t.split('\n').pop() ?? ''
  try { return JSON.parse(last) as unknown } catch { return undefined }
}

// The plugin and marketplace names `buracle update <name>` accepts: Buracle's catalog plus what
// Claude Code has installed (`marketplace:<name>` for a marketplace).
export async function knownPluginNames(env: Pick<UpdateEnv, 'bundle'>): Promise<Set<string>> {
  const out = new Set<string>([
    ...(env.bundle?.plugins.claude.plugins.map(p => p.id) ?? []),
    ...(env.bundle?.plugins.claude.marketplaces.map(m => `marketplace:${m.id}`) ?? []),
  ])
  const [list, mk] = await Promise.all([
    opsDeps.run(['claude', 'plugin', 'list', '--json'], { timeoutMs: 60_000 }),
    opsDeps.run(['claude', 'plugin', 'marketplace', 'list', '--json'], { timeoutMs: 60_000 }),
  ])
  const installed = list.code === 0 ? parseJsonOutput(list.stdout) : undefined
  if (Array.isArray(installed)) for (const p of installed.filter(isRecord)) if (typeof p['id'] === 'string') out.add(p['id'])
  const markets = mk.code === 0 ? parseJsonOutput(mk.stdout) : undefined
  if (Array.isArray(markets)) for (const m of markets.filter(isRecord)) if (typeof m['name'] === 'string') out.add(`marketplace:${m['name']}`)
  return out
}

interface MarketplaceInfo { name: string; source?: string; installLocation?: string; ref?: string }

function marketplaceVersions(loc: string): Map<string, string> {
  const out = new Map<string, string>()
  try {
    const j = JSON.parse(readFileSync(join(loc, '.claude-plugin', 'marketplace.json'), 'utf8')) as unknown
    const plugins = isRecord(j) && Array.isArray(j['plugins']) ? j['plugins'] : []
    for (const p of plugins) if (isRecord(p) && typeof p['name'] === 'string' && typeof p['version'] === 'string') out.set(p['name'], p['version'])
  } catch {  }
  return out
}

export async function checkPlugins(env: UpdateEnv, res: CheckResult): Promise<void> {
  const claude = env.adapters.find(a => a.harness === 'claude')
  if (!claude || env.config.harnesses.claude.enabled === false) { res.unchecked.push({ kind: 'plugins', reason: 'Claude Code is turned off in the configuration' }); return }
  let det: { installed: boolean }
  try { det = await claude.detect() } catch { det = { installed: false } }
  if (!det.installed) { res.unchecked.push({ kind: 'plugins', reason: 'Claude Code is not installed' }); return }
  const list = await opsDeps.run(['claude', 'plugin', 'list', '--json'], { timeoutMs: 60_000 })
  const mk = await opsDeps.run(['claude', 'plugin', 'marketplace', 'list', '--json'], { timeoutMs: 60_000 })
  const installed = parseJsonOutput(list.stdout)
  const markets = parseJsonOutput(mk.stdout)
  if (list.code !== 0 || !Array.isArray(installed)) { res.errors.push({ kind: 'plugins', id: 'claude', error: `claude plugin list --json failed (exit ${list.code})` }); return }
  const mks: MarketplaceInfo[] = Array.isArray(markets) ? markets.filter(isRecord).map(m => {
    const info: MarketplaceInfo = { name: String(m['name'] ?? '') }
    if (typeof m['source'] === 'string') info.source = m['source']
    if (typeof m['installLocation'] === 'string') info.installLocation = m['installLocation']
    if (typeof m['ref'] === 'string') info.ref = m['ref']
    return info
  }).filter(m => m.name !== '') : []
  for (const m of mks) {
    if (m.installLocation === undefined || (m.source !== 'github' && m.source !== 'git')) continue
    const local = await gitops.headCommit(m.installLocation)
    const remote = local !== undefined ? await gitops.remoteHead(m.installLocation, m.ref ?? 'HEAD') : undefined
    if (local !== undefined && remote !== undefined && local !== remote) {
      res.items.push({ kind: 'plugins', id: `marketplace:${m.name}`, current: local.slice(0, 12), latest: remote.slice(0, 12), action: 'marketplace-update', risk: 'low', command: ['claude', 'plugin', 'marketplace', 'update', m.name] })
    }
  }
  const catalogs = new Map<string, Map<string, string>>()
  for (const p of installed.filter(isRecord)) {
    const id = typeof p['id'] === 'string' ? p['id'] : ''
    const at = id.lastIndexOf('@')
    if (at <= 0) continue
    const pname = id.slice(0, at)
    const market = id.slice(at + 1)
    if (['inline', 'skills-dir', 'synced', 'builtin'].includes(market) || id === 'buracle@buracle') continue
    const m = mks.find(x => x.name === market)
    if (!m?.installLocation) continue
    if (!catalogs.has(market)) catalogs.set(market, marketplaceVersions(m.installLocation))
    const offered = catalogs.get(market)?.get(pname)
    const current = typeof p['version'] === 'string' ? p['version'] : undefined
    if (offered === undefined || current === undefined || !parseVersionString(offered) || !parseVersionString(current)) continue
    if (compareVersions(offered, current) <= 0) continue
    res.items.push({ kind: 'plugins', id, current, latest: offered, action: 'plugin-update', risk: bumpRisk(current, offered), command: ['claude', 'plugin', 'update', id, '--json'], note: 'version from the cached marketplace catalog' })
  }
}

async function latestHarnessVersion(src: HarnessSource): Promise<{ version?: string, publishedAt?: string, error?: string }> {
  if (src.npm !== undefined) {
    const found = await npmVersions(src.npm)
    if ('error' in found) return { error: found.error }
    const v = found.latestTag
    if (v === undefined) return { error: `npm ${src.npm}: no latest tag` }
    const at = found.versions.find(x => x.version === v)?.publishedAt
    return at !== undefined ? { version: v, publishedAt: at } : { version: v }
  }
  if (src.url !== undefined) {
    const r = await opsDeps.fetch(src.url, { timeoutMs: 20_000 })
    if (!r.ok || !isRecord(r.json) || typeof r.json['version'] !== 'string') return { error: `${src.url}: ${r.error ?? 'unexpected response'}` }
    return { version: r.json['version'] }
  }
  return { error: 'no version source' }
}

const OFFICIAL_TAPS: ReadonlySet<string> = new Set(['homebrew/core', 'homebrew/cask'])

function stripCaskSuffix(v: string): string {
  return v.split(',')[0] ?? v
}

async function brewLatest(origin: Origin): Promise<{ version?: string, note?: string, error?: string }> {
  const name = origin.name ?? ''
  const cask = origin.method === 'brew-cask'
  const r = await opsDeps.run(['brew', 'info', '--json=v2', ...(cask ? ['--cask'] : []), name], { timeoutMs: 60_000, env: { ...BREW_CHECK_ENV } })
  if (r.code === 127) return { error: 'brew not found' }
  const j = parseJsonOutput(r.stdout)
  const list = isRecord(j) ? j[cask ? 'casks' : 'formulae'] : undefined
  const entry = Array.isArray(list) ? list.find(isRecord) : undefined
  if (r.code !== 0 || entry === undefined) {
    const why = r.stderr.split('\n').map(l => l.trim()).find(l => l.startsWith('Error:'))
    return { error: `brew info --json=v2 ${cask ? '--cask ' : ''}${name} failed (exit ${r.code})${why !== undefined ? `: ${why.slice('Error:'.length).trim()}` : ''}` }
  }
  const tap = typeof entry['tap'] === 'string' ? entry['tap'] : ''
  const versions = isRecord(entry['versions']) ? entry['versions'] : {}
  const raw = cask ? entry['version'] : versions['stable']
  const local = typeof raw === 'string' ? stripCaskSuffix(raw) : undefined
  if (!OFFICIAL_TAPS.has(tap)) return local !== undefined ? { version: local, note: `Homebrew tap ${tap || 'unknown'}, as of its last brew update` } : { error: `brew info ${name}: no version` }
  const api = await opsDeps.fetch(`https://formulae.brew.sh/api/${cask ? 'cask' : 'formula'}/${encodeURIComponent(name)}.json`, { timeoutMs: 20_000 })
  const fromApi = api.ok && isRecord(api.json) ? (cask ? api.json['version'] : isRecord(api.json['versions']) ? api.json['versions']['stable'] : undefined) : undefined
  if (typeof fromApi === 'string') return { version: stripCaskSuffix(fromApi) }
  if (local === undefined) return { error: `Homebrew API: ${api.error ?? 'unexpected response'}` }
  return { version: local, note: `Homebrew API unreachable (${api.error ?? `HTTP ${api.status}`}); version from the local brew data` }
}

export async function checkHarness(env: UpdateEnv, res: CheckResult): Promise<void> {
  await Promise.all(env.adapters.map(async a => {
    const h = a.harness
    if (env.config.harnesses[h]?.enabled === false) return
    let det: { installed: boolean, version?: string, path?: string }
    try { det = await a.detect() } catch { return }
    if (!det.installed || det.version === undefined) return
    const src = HARNESS_SOURCES[h]
    const real = resolveBinary(det.path)
    const origin: Origin = real !== undefined ? detectOrigin(real) : { method: 'unknown' }
    const notes: string[] = []
    let latest: { version?: string, publishedAt?: string, error?: string, note?: string }
    if (origin.method === 'brew-formula' || origin.method === 'brew-cask') {
      latest = await brewLatest(origin)
      if (latest.error === undefined) notes.push('Homebrew gives no release date, so update.minReleaseAgeDays does not apply')
    } else latest = await latestHarnessVersion(src)
    if (latest.error !== undefined || latest.version === undefined) { res.errors.push({ kind: 'harness', id: h, error: latest.error ?? 'unknown latest version' }); return }
    if (!parseVersionString(latest.version)) { res.errors.push({ kind: 'harness', id: h, error: `unexpected latest version ${JSON.stringify(latest.version)}` }); return }
    if (compareVersions(latest.version, det.version) <= 0) return
    const plan = harnessUpdate(h, origin, latest.version, src.npm)
    if ('error' in plan) { res.errors.push({ kind: 'harness', id: h, error: plan.error }); return }
    if (latest.note !== undefined) notes.unshift(latest.note)
    let risk = bumpRisk(det.version, latest.version)
    if (compareVersions(latest.version, TESTED_WITH[h].tested) > 0) { risk = maxRisk(risk, 'medium'); notes.push(`newer than the version Buracle was tested with (${TESTED_WITH[h].tested}); run \`buracle doctor ${h}\` afterwards`) }
    if (latest.publishedAt !== undefined) {
      const age = (env.nowMs - Date.parse(latest.publishedAt)) / DAY_MS
      if (age < env.config.update.minReleaseAgeDays) { risk = maxRisk(risk, 'medium'); notes.push(`released ${Math.max(0, Math.round(age * 10) / 10)} day(s) ago`) }
    }
    const item: UpdateItem = { kind: 'harness', id: h, current: det.version, latest: latest.version, action: plan.action, risk, command: plan.command, source: plan.source }
    if (notes.length > 0) item.note = notes.join('; ')
    if (latest.publishedAt !== undefined) item.publishedAt = latest.publishedAt
    res.items.push(item)
  }))
}

export function brewUpgradeCommand(name: string): string[] | undefined {
  return isBrewName(name) ? ['brew', 'upgrade', name] : undefined
}

async function checkBrewTools(tools: readonly ToolSpec[], res: CheckResult): Promise<void> {
  const brewed = tools.filter((t): t is ToolSpec & { brew: string } => typeof t.brew === 'string')
  if (brewed.length === 0) return
  const r = await opsDeps.run(['brew', 'outdated', '--json=v2'], { timeoutMs: 120_000, env: { ...BREW_CHECK_ENV } })
  if (r.code === 127) { res.notes.push('tools: brew not found; the Homebrew tools are not checked'); return }
  const j = parseJsonOutput(r.stdout)
  if (!isRecord(j)) { res.errors.push({ kind: 'tools', error: `brew outdated --json=v2 failed (exit ${r.code})` }); return }
  const formulae = Array.isArray(j['formulae']) ? j['formulae'].filter(isRecord) : []
  for (const t of brewed) {
    const short = t.brew.split('/').pop() as string
    const f = formulae.find(x => x['name'] === t.brew || x['name'] === short || x['full_name'] === t.brew)
    if (!f) continue
    const inst = Array.isArray(f['installed_versions']) ? f['installed_versions'].map(String) : []
    const current = inst[inst.length - 1] ?? null
    const latest = typeof f['current_version'] === 'string' ? f['current_version'] : null
    if (latest === null) continue
    const command = brewUpgradeCommand(t.brew)
    if (command === undefined) { res.errors.push({ kind: 'tools', id: t.name, error: `refusing the Homebrew name ${JSON.stringify(t.brew)}` }); continue }
    const item: UpdateItem = { kind: 'tools', id: t.name, current, latest, action: 'brew-upgrade', risk: current !== null ? bumpRisk(current, latest) : 'medium', command, source: `Homebrew formula ${t.brew}` }
    if (f['pinned'] === true) item.note = 'pinned in Homebrew'
    res.items.push(item)
  }
}

async function checkToolchainTools(env: UpdateEnv, tools: readonly ToolSpec[], res: CheckResult): Promise<void> {
  if (!env.bundle) return
  const state = readToolchainState()
  const serverPackages = new Set(packageServers(env.bundle).flatMap(([, spec]) => (spec.package !== undefined && spec.package.registry !== 'none' ? [packageKey(spec.package.registry, spec.package.name)] : [])))
  const minAgeDays = env.config.update.minReleaseAgeDays
  await Promise.all(tools.map(async t => {
    const req = toolRequest(t)
    if (req === undefined) return
    const key = packageKey(req.registry, req.name)
    const have = state.packages[key]
    if (have === undefined || serverPackages.has(key) || res.items.some(i => i.kind === 'tools' && i.id === t.name)) return
    const found = req.registry === 'npm' ? await npmVersions(req.name) : await pypiVersions(req.name)
    if ('error' in found) { res.errors.push({ kind: 'tools', id: t.name, error: found.error }); return }
    const opts: { latestTag?: string, minAgeDays: number, nowMs: number } = { minAgeDays, nowMs: env.nowMs }
    if (found.latestTag !== undefined) opts.latestTag = found.latestTag
    const pick = pickUpdate(have.version, found.versions, opts)
    if (pick.candidate !== undefined && pick.candidate !== have.rolled_back) {
      const item: UpdateItem = { kind: 'tools', id: t.name, current: have.version, latest: pick.candidate, action: 'toolchain-upgrade', risk: bumpRisk(have.version, pick.candidate), source: `${req.registry} ${req.name} (Buracle toolchain)` }
      if (pick.candidatePublishedAt !== undefined) item.publishedAt = pick.candidatePublishedAt
      res.items.push(item)
    }
    if (pick.held) res.held.push({ kind: 'tools', id: t.name, current: have.version, version: pick.held.version, publishedAt: pick.held.publishedAt, ageDays: pick.held.ageDays })
  }))
}

export async function checkTools(env: UpdateEnv, res: CheckResult): Promise<void> {
  if (!env.bundle) { res.errors.push({ kind: 'tools', error: 'canonical/tools.yaml could not be loaded' }); return }
  const tools = env.bundle.tools.tools
  await checkBrewTools(tools, res)
  await checkToolchainTools(env, tools, res)
}

async function fetchText(url: string): Promise<string> {
  const r = await opsDeps.fetch(url, { timeoutMs: 60_000 })
  if (!r.ok) throw new Error(`GET ${url}: ${r.error ?? `HTTP ${r.status}`}`)
  return r.text ?? JSON.stringify(r.json)
}

async function pricing(env: UpdateEnv, write: boolean): Promise<{ changed: boolean, written: boolean, missing: string[] } | { unavailable: string } | { error: string }> {
  let mod: typeof import('../../usage/pricing')
  try { mod = await import('../../usage/pricing') } catch (e) { return { unavailable: errText(e) } }
  if (typeof mod.refreshPricing !== 'function') return { unavailable: 'refreshPricing is not exported' }
  try {
    const r = await mod.refreshPricing({ fetcher: fetchText, path: join(env.repoRoot, 'canonical', 'pricing.yaml'), write, now: () => new Date(env.nowMs) })
    return { changed: r.changed === true, written: r.written === true, missing: Array.isArray(r.missing) ? r.missing.map(String) : [] }
  } catch (e) {
    return { error: errText(e) }
  }
}

export async function checkPricing(env: UpdateEnv, res: CheckResult): Promise<void> {
  const r = await pricing(env, false)
  if ('unavailable' in r) { res.notes.push(`pricing: refresh not available (${r.unavailable})`); return }
  if ('error' in r) { res.errors.push({ kind: 'pricing', id: 'pricing.yaml', error: r.error }); return }
  if (!r.changed) return
  const item: UpdateItem = { kind: 'pricing', id: 'pricing.yaml', current: null, latest: null, action: 'refresh', risk: 'low', note: 'list prices changed upstream (LiteLLM)' }
  if (r.missing.length > 0) item.note += `; no price for: ${r.missing.join(', ')}`
  res.items.push(item)
}

const CHECKERS: Record<UpdateKind, (env: UpdateEnv, res: CheckResult) => Promise<void>> = {
  self: checkSelf,
  skills: checkSkills,
  mcp: checkMcp,
  plugins: checkPlugins,
  harness: checkHarness,
  tools: checkTools,
  pricing: checkPricing,
}

// onKind sees each kind start and finish; `result` holds what every kind checked so far found.
export async function checkUpdates(kinds: readonly UpdateKind[], env: UpdateEnv, onKind?: (e: CheckStep) => void): Promise<CheckResult> {
  const res: CheckResult = { items: [], held: [], errors: [], notes: [], unchecked: [] }
  for (const k of kinds) {
    onKind?.({ kind: k, phase: 'start' })
    try { await CHECKERS[k](env, res) } catch (e) { res.errors.push({ kind: k, error: errText(e) }) }
    onKind?.({ kind: k, phase: 'done', result: res })
  }
  const order = (k: UpdateKind) => kinds.indexOf(k)
  res.items.sort((a, b) => order(a.kind) - order(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return res
}

export interface ApplyOutcome {
  applied: Array<{ kind: UpdateKind, id: string, detail: string }>
  failed: Array<{ kind: UpdateKind, id: string, error: string }>
  skipped: Array<{ kind: UpdateKind, id: string, reason: string, benign?: boolean }>
  rebuild: boolean
  selfUpdated: boolean
  selfFrom?: string
  depsInstalled?: boolean
  bumpedServers: string[]
  // The MCP servers and tools the toolchain installed or upgraded: the ones an update has to prove still work.
  toolchainUpgraded: Array<{ kind: 'mcp' | 'tools', id: string }>
  pinsBumped: boolean
  harnessChecks: Array<{ harness: Harness, level: 'warn' | 'error', check: string, detail: string }>
}

export const DEPENDENCY_FILES: readonly string[] = ['package.json', 'bun.lock']

async function bunInstall(dir: string): Promise<{ ok: true } | { ok: false, error: string }> {
  const r = await opsDeps.run([bunPath(), 'install', '--frozen-lockfile'], { cwd: dir, timeoutMs: 600_000 })
  return r.code === 0 ? { ok: true } : { ok: false, error: `bun install --frozen-lockfile failed: ${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}` }
}

export async function revertCheckout(dir: string, commit: string, deps: boolean): Promise<{ ok: boolean, message: string }> {
  const short = commit.slice(0, 12)
  const clean = await gitops.isClean(dir)
  if (clean !== true) return { ok: false, message: `the checkout stays at the new commit because it has local changes (or git status failed); look at them, then run \`git reset --keep ${short}\` in ${dir}` }
  const r = await gitops.resetKeep(dir, commit)
  if (!r.ok) return { ok: false, message: `moving the checkout back to ${short} failed (${r.error}); run \`git reset --keep ${short}\` in ${dir}` }
  if (deps) {
    const b = await bunInstall(dir)
    if (!b.ok) return { ok: true, message: `the checkout was moved back to ${short} (git reset --keep), but ${b.error}; run it in ${dir}` }
  }
  return { ok: true, message: `the checkout was moved back to ${short} (git reset --keep)${deps ? ' and its packages reinstalled' : ''}` }
}

export function bumpPins(repoRoot: string, bumps: ReadonlyArray<{ id: string, version: string }>): { ok: true } | { ok: false, error: string } {
  const file = join(repoRoot, 'canonical', 'mcp.yaml')
  let text: string
  try { text = readFileSync(file, 'utf8') } catch (e) { return { ok: false, error: errText(e) } }
  try {
    for (const b of bumps) text = setYamlValue(text, ['servers', b.id, 'package', 'version'], b.version)
    const errs = validateMcpCatalog(yamlParse(text))
    if (errs.length > 0) return { ok: false, error: `the bumped mcp.yaml would be invalid: ${errs.join('; ')}` }
    atomicWriteSync(file, text)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errText(e) }
  }
}

function lastJsonLine(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.trim().split('\n').reverse()
  for (const l of lines) {
    try { const v = JSON.parse(l) as unknown; if (isRecord(v)) return v } catch {  }
  }
  return undefined
}

function firstLine(s: string): string {
  return s.trim().split('\n')[0] ?? ''
}

const HARNESS_LABEL: Readonly<Record<string, string>> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', omp: 'Oh My Pi' }

export function partName(kind: UpdateKind, id: string): string {
  if (kind === 'self') return 'Buracle'
  if (kind === 'harness') return HARNESS_LABEL[id] ?? id
  if (kind === 'skills') return `Skill ${id}`
  return id
}

// Runs one step of the apply and reports it to env.onStep: each part the step applied, skipped or
// failed gets its own line. `summary` reports the step as one line of counts instead (the toolchain
// shows its parts through its own events).
async function tracked(env: UpdateEnv, out: ApplyOutcome, step: { id: string, label: string, idle: string, summary?: string }, work: () => Promise<void>): Promise<void> {
  const report = env.onStep
  if (report === undefined) { await work(); return }
  const at = { applied: out.applied.length, failed: out.failed.length, skipped: out.skipped.length }
  report({ phase: 'start', id: step.id, label: step.label })
  try {
    await work()
  } catch (e) {
    report({ phase: 'done', id: step.id, outcome: 'err', label: `${step.idle}: ${errText(e)}` })
    throw e
  }
  const applied = out.applied.slice(at.applied)
  const failed = out.failed.slice(at.failed)
  const skipped = out.skipped.slice(at.skipped)
  if (step.summary !== undefined) {
    const counts = [[applied.length, 'updated'], [skipped.length, 'skipped'], [failed.length, 'failed']] as const
    const text = counts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`).join(', ')
    report({ phase: 'done', id: step.id, outcome: failed.length > 0 ? 'err' : applied.length > 0 ? 'ok' : 'skip', label: `${step.summary}: ${text === '' ? 'nothing to do' : text}` })
    return
  }
  const lines: Array<{ outcome: 'ok' | 'skip' | 'err', label: string }> = [
    ...applied.map(a => ({ outcome: 'ok' as const, label: `${partName(a.kind, a.id)}: ${a.detail}` })),
    ...skipped.map(s => ({ outcome: s.benign === true ? 'ok' as const : 'skip' as const, label: `${partName(s.kind, s.id)}: ${s.reason}` })),
    ...failed.map(f => ({ outcome: 'err' as const, label: `${partName(f.kind, f.id)}: ${f.error}` })),
  ]
  if (lines.length === 0) lines.push({ outcome: 'skip', label: step.idle })
  lines.forEach((l, i) => report({ phase: 'done', id: i === 0 ? step.id : `${step.id}#${i}`, ...l }))
}

async function applyHarness(i: UpdateItem, env: UpdateEnv, out: ApplyOutcome): Promise<void> {
  const adapter = env.adapters.find(a => a.harness === i.id)
  if (!i.command || adapter === undefined) { out.skipped.push({ kind: 'harness', id: i.id, reason: 'no update command' }); return }
  const h = adapter.harness
  const cmd = i.command.join(' ')
  const r = await opsDeps.run(i.command, { timeoutMs: 900_000, ...(i.command[0] === 'brew' ? { env: { HOMEBREW_NO_ENV_HINTS: '1' } } : {}) })
  if (r.code !== 0) { out.failed.push({ kind: 'harness', id: h, error: `${cmd} failed: ${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}` }); return }
  try { (await import('../../usage/bar-info')).forgetHarnessVersion(h) } catch {  }
  let now: string | undefined
  try { now = (await adapter.detect()).version } catch { now = undefined }
  const before = i.current
  const latest = i.latest
  if (i.action === 'self-update') {
    if (now !== undefined && before !== null && compareVersions(now, before) === 0) {
      out.skipped.push({ kind: 'harness', id: h, reason: `${cmd} found nothing newer than ${before}${latest !== null ? ` (registry latest ${latest})` : ''}`, benign: true })
      return
    }
    if (now === undefined || (before !== null && compareVersions(now, before) < 0)) { out.failed.push({ kind: 'harness', id: h, error: `still ${now ?? 'an unknown version'} after ${cmd}` }); return }
    const behind = latest !== null && compareVersions(now, latest) < 0 ? `; channel is behind the registry latest (${latest})` : ''
    out.applied.push({ kind: 'harness', id: h, detail: `${cmd} → ${now}${behind}` })
  } else {
    if (now === undefined || (latest !== null && compareVersions(now, latest) < 0)) { out.failed.push({ kind: 'harness', id: h, error: `still ${now ?? 'an unknown version'} after ${cmd}` }); return }
    out.applied.push({ kind: 'harness', id: h, detail: `${cmd} → ${now}` })
  }
  if (env.ctx === undefined) return
  try {
    const found = await adapter.doctor(env.ctx)
    for (const f of Array.isArray(found) ? found : []) {
      if (f.level === 'warn' || f.level === 'error') out.harnessChecks.push({ harness: h, level: f.level, check: String(f.check), detail: String(f.detail) })
    }
  } catch (e) {
    out.harnessChecks.push({ harness: h, level: 'error', check: 'doctor', detail: errText(e) })
  }
}

async function applyToolchain(items: readonly UpdateItem[], env: UpdateEnv, out: ApplyOutcome): Promise<void> {
  if (items.length === 0) return
  const idOf = (i: UpdateItem) => `${i.kind === 'mcp' ? 'mcp' : 'tool'}:${i.id}`
  if (process.env['BURACLE_NO_TOOLCHAIN'] === '1') {
    for (const i of items) out.skipped.push({ kind: i.kind, id: i.id, reason: 'toolchain changes are switched off (BURACLE_NO_TOOLCHAIN=1)' })
    return
  }
  if (!env.bundle) {
    for (const i of items) out.failed.push({ kind: i.kind, id: i.id, error: 'canonical/ could not be loaded' })
    return
  }
  let r: Awaited<ReturnType<typeof opsDeps.runToolchain>>
  try {
    r = await opsDeps.runToolchain(env.bundle, { install: true, upgrade: true, system: false, checkLatest: true, only: items.map(idOf), nowMs: opsDeps.now, ...(env.onToolchainEvent !== undefined ? { onEvent: env.onToolchainEvent } : {}) })
  } catch (e) {
    for (const i of items) out.failed.push({ kind: i.kind, id: i.id, error: errText(e) })
    return
  }
  if (r === undefined) {
    for (const i of items) out.failed.push({ kind: i.kind, id: i.id, error: 'another Buracle process is installing the toolchain; try again in a moment' })
    return
  }
  for (const i of items) {
    const got = r.items.find(x => x.id === idOf(i))
    if (got === undefined) { out.failed.push({ kind: i.kind, id: i.id, error: 'not part of the toolchain run' }); continue }
    if (got.status === 'upgraded' || got.status === 'installed') {
      out.applied.push({ kind: i.kind, id: i.id, detail: `toolchain ${i.current ?? 'none'} → ${got.current ?? i.latest ?? 'latest'}` })
      if (i.kind === 'mcp' || i.kind === 'tools') out.toolchainUpgraded.push({ kind: i.kind, id: i.id })
      if (i.kind === 'mcp') out.bumpedServers.push(i.id)
    } else if (got.status === 'ok') out.skipped.push({ kind: i.kind, id: i.id, reason: `already at ${got.current ?? i.current ?? 'the newest release'}`, benign: true })
    else out.failed.push({ kind: i.kind, id: i.id, error: got.detail || got.status })
  }
}

async function applyPluginUpdate(i: UpdateItem, out: ApplyOutcome): Promise<void> {
  const r = await opsDeps.run(['claude', 'plugin', 'update', i.id, '--json'], { timeoutMs: 300_000 })
  const res = lastJsonLine(r.stdout)
  if (r.code === 0 && (res === undefined || res['outcome'] !== 'failed')) out.applied.push({ kind: 'plugins', id: i.id, detail: typeof res?.['message'] === 'string' ? res['message'] : `updated to ${i.latest ?? 'latest'} (restart or /reload-plugins)` })
  else out.failed.push({ kind: 'plugins', id: i.id, error: typeof res?.['message'] === 'string' ? res['message'] : firstLine(r.stderr) || `exit ${r.code}` })
}

async function applyPlugins(items: readonly UpdateItem[], env: UpdateEnv, out: ApplyOutcome): Promise<void> {
  if (items.length === 0) return
  const markets = items.filter(p => p.action === 'marketplace-update')
  const done = new Set<string>()
  const mk = await opsDeps.run(['claude', 'plugin', 'marketplace', 'update'], { timeoutMs: 60_000 })
  for (const i of markets) {
    if (mk.code === 0) out.applied.push({ kind: 'plugins', id: i.id, detail: 'marketplace refreshed' })
    else out.failed.push({ kind: 'plugins', id: i.id, error: `claude plugin marketplace update failed: ${firstLine(mk.stderr) || `exit ${mk.code}`}` })
  }
  if (mk.code === 0) {
    const again: CheckResult = { items: [], held: [], errors: [], notes: [], unchecked: [] }
    try { await checkPlugins(env, again) } catch {  }
    for (const i of again.items.filter(p => p.action === 'plugin-update')) { done.add(i.id); await applyPluginUpdate(i, out) }
  }
  for (const i of items.filter(p => p.action === 'plugin-update' && !done.has(p.id))) await applyPluginUpdate(i, out)
}

export async function applyUpdates(items: readonly UpdateItem[], env: UpdateEnv): Promise<ApplyOutcome> {
  const out: ApplyOutcome = { applied: [], failed: [], skipped: [], rebuild: false, selfUpdated: false, bumpedServers: [], toolchainUpgraded: [], pinsBumped: false, harnessChecks: [] }
  const of = (k: UpdateKind) => items.filter(i => i.kind === k)

  for (const i of of('self')) {
    await tracked(env, out, { id: `self:${i.id}`, label: 'Buracle: updating the checkout (git fast-forward)', idle: 'Buracle' }, async () => {
      if (i.action !== 'ff-merge') { out.skipped.push({ kind: 'self', id: i.id, reason: 'diverged from upstream; merge by hand' }); return }
      const prev = await gitops.headCommit(env.repoRoot)
      const r = await gitops.fastForward(env.repoRoot)
      if (!r.ok) { out.failed.push({ kind: 'self', id: i.id, error: r.error }); return }
      const changed = prev !== undefined ? await gitops.changedPaths(env.repoRoot, prev, 'HEAD', DEPENDENCY_FILES) : undefined
      let deps = false
      if (changed === undefined || changed.length > 0) {
        const b = await bunInstall(env.repoRoot)
        if (!b.ok) {
          const back = prev !== undefined ? (await revertCheckout(env.repoRoot, prev, true)).message : 'the previous commit is unknown, so the checkout stays at the new one'
          out.failed.push({ kind: 'self', id: i.id, error: `${b.error} after the fast-forward ${r.from} → ${r.to}; ${back}` })
          return
        }
        deps = true
      }
      out.applied.push({ kind: 'self', id: i.id, detail: `${r.from} → ${r.to}${deps ? ' (bun install --frozen-lockfile)' : ''}` })
      out.rebuild = true
      out.selfUpdated = true
      if (prev !== undefined) out.selfFrom = prev
      if (deps) out.depsInstalled = true
    })
  }

  for (const i of of('skills').filter(s => s.action === 'skill-update')) {
    await tracked(env, out, { id: `skills:${i.id}`, label: `Skill ${i.id}: updating`, idle: `Skill ${i.id}` }, async () => {
      const { skillsUpdate } = await import('../../workflow/skill-install')
      const r = await skillsUpdate(i.id, {}, skillCtx(env))
      if (r.errors.length === 0 && r.code === 0) out.applied.push({ kind: 'skills', id: i.id, detail: (r.lines[0] ?? 'updated').replace(`${i.id}: `, '') })
      else out.failed.push({ kind: 'skills', id: i.id, error: r.errors[0] ?? r.lines[0] ?? `exit ${r.code}` })
    })
  }

  for (const i of of('skills').filter(s => s.action !== 'skill-update')) {
    await tracked(env, out, { id: `skills:${i.id}`, label: `Skill ${i.id}: ${i.action === 'clone' ? 'cloning' : 'updating'} the source`, idle: `Skill ${i.id}` }, async () => {
      if (i.source === 'buracle skills add') { out.skipped.push({ kind: 'skills', id: i.id, reason: i.note ?? 'update it by hand' }); return }
      const src = env.config.skills.sources.find(s => s.name === i.id)
      if (!src) { out.skipped.push({ kind: 'skills', id: i.id, reason: 'no longer configured' }); return }
      if (i.action === 'clone' && src.git !== undefined) {
        const r = await gitops.clone(src.git, skillSourceDir(src.name), src.ref)
        if (r.ok) { out.applied.push({ kind: 'skills', id: i.id, detail: 'cloned' }); out.rebuild = true }
        else out.failed.push({ kind: 'skills', id: i.id, error: r.error })
        return
      }
      if (i.action !== 'ff-merge') { out.skipped.push({ kind: 'skills', id: i.id, reason: 'diverged from upstream; merge by hand' }); return }
      const dir = src.git !== undefined ? skillSourceDir(src.name) : resolve(env.repoRoot, paths.expandHome(src.path ?? '.'))
      const r = await gitops.fastForward(dir)
      if (r.ok) { out.applied.push({ kind: 'skills', id: i.id, detail: `${r.from} → ${r.to}` }); out.rebuild = true }
      else out.failed.push({ kind: 'skills', id: i.id, error: r.error })
    })
  }

  const fromToolchain = items.filter(i => i.action === 'toolchain-upgrade' && (i.kind === 'mcp' || i.kind === 'tools'))
  if (fromToolchain.length > 0) {
    await tracked(env, out, { id: 'toolchain', label: `Toolchain: upgrading ${fromToolchain.map(i => i.id).join(', ')}`, idle: 'Toolchain', summary: 'Toolchain' }, () => applyToolchain(fromToolchain, env, out))
  }
  const pins = of('mcp').filter(i => i.action !== 'toolchain-upgrade')
  if (pins.length > 0) {
    await tracked(env, out, { id: 'mcp-pins', label: 'MCP servers: updating the pins in canonical/mcp.yaml', idle: 'MCP server pins' }, async () => {
      const bumps: Array<{ id: string, version: string }> = []
      for (const i of pins) {
        if (i.action !== 'bump-pin' || i.latest === null) { out.skipped.push({ kind: 'mcp', id: i.id, reason: i.action === 'review' ? 'soft pin: bump it by hand after review' : 'monitored only' }); continue }
        bumps.push({ id: i.id, version: i.latest })
      }
      if (bumps.length === 0) return
      const r = bumpPins(env.repoRoot, bumps)
      if (r.ok) {
        for (const b of bumps) out.applied.push({ kind: 'mcp', id: b.id, detail: `pin → ${b.version}` })
        out.bumpedServers.push(...bumps.map(b => b.id))
        out.pinsBumped = true
        out.rebuild = true
      } else for (const b of bumps) out.failed.push({ kind: 'mcp', id: b.id, error: r.error })
    })
  }

  if (of('plugins').length > 0) {
    await tracked(env, out, { id: 'plugins', label: 'Claude Code plugins: refreshing the marketplaces and updating', idle: 'Claude Code plugins: nothing to update' }, () => applyPlugins(of('plugins'), env, out))
  }

  for (const i of of('harness')) {
    const how = i.command !== undefined ? ` (${i.command.join(' ')})` : ''
    await tracked(env, out, { id: `harness:${i.id}`, label: `${partName('harness', i.id)}: updating${i.latest !== null ? ` to ${i.latest}` : ''}${how}`, idle: partName('harness', i.id) }, () => applyHarness(i, env, out))
  }

  for (const i of of('tools').filter(t => t.action !== 'toolchain-upgrade')) {
    await tracked(env, out, { id: `tools:${i.id}`, label: `${i.id}: updating${i.command !== undefined ? ` (${i.command.join(' ')})` : ''}`, idle: i.id }, async () => {
      if (!i.command) { out.skipped.push({ kind: 'tools', id: i.id, reason: 'no command' }); return }
      const r = await opsDeps.run(i.command, { timeoutMs: 900_000, env: { HOMEBREW_NO_ENV_HINTS: '1' } })
      if (r.code === 0) out.applied.push({ kind: 'tools', id: i.id, detail: `${i.current ?? '?'} → ${i.latest ?? 'latest'}` })
      else out.failed.push({ kind: 'tools', id: i.id, error: `${i.command.join(' ')} failed: ${firstLine(r.stderr) || `exit ${r.code}`}` })
    })
  }

  for (const i of of('pricing')) {
    await tracked(env, out, { id: `pricing:${i.id}`, label: 'Prices: refreshing canonical/pricing.yaml', idle: 'Prices' }, async () => {
      const r = await pricing(env, true)
      if ('written' in r && r.written) { out.applied.push({ kind: 'pricing', id: i.id, detail: 'canonical/pricing.yaml refreshed' }); out.rebuild = true }
      else if ('written' in r) out.skipped.push({ kind: 'pricing', id: i.id, reason: 'prices unchanged' })
      else out.failed.push({ kind: 'pricing', id: i.id, error: 'error' in r ? r.error : r.unavailable })
    })
  }
  return out
}

export function toolDiff(before: readonly string[] | undefined, after: readonly string[] | undefined): { added: string[], removed: string[] } {
  const b = new Set(before ?? [])
  const a = new Set(after ?? [])
  return { added: [...a].filter(x => !b.has(x)).sort(), removed: [...b].filter(x => !a.has(x)).sort() }
}

