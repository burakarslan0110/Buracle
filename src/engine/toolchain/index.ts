import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { breakStaleLock, lockSnapshot, lockToken, releaseLockFile } from '../lockfile'
import { fallbackNpmCache } from './launch'
import type { CanonicalBundle, McpServerSpec, ToolSpec } from '../../core/catalog'
import { isPackageServer, mcpPackageBin } from '../../core/catalog'
import { compareVersions } from '../update/versions'
import { errText } from '../update/output'
import * as paths from '../paths'
import { configuredMinAgeDays, installPackage, installPypi, latestVersion, npmBins, npmInstalledVersion, npmPrefix, npmPreviousPrefix, pypiStillThere, toolRequest, type PackageRequest } from './packages'
import { packageKey, readToolchainState, updateToolchainState, type InstalledPackage, type ToolchainState } from './state'
import { checkTool, installAdvice, installSources, installTool, toolApplies } from './system'

export type ItemGroup = 'runtime' | 'cli' | 'lsp' | 'mcp'
export type ItemStatus = 'ok' | 'installed' | 'upgraded' | 'missing' | 'outdated' | 'failed' | 'skipped'

export interface ToolchainItem {
  id: string
  group: ItemGroup
  label: string
  required: boolean
  status: ItemStatus
  current?: string
  latest?: string
  source?: string
  detail: string
}

export interface ToolchainEvent { item: ToolchainItem; phase: 'start' | 'done' }

export interface ToolchainOptions {
  install: boolean
  upgrade: boolean
  system: boolean
  checkLatest: boolean
  only?: readonly string[]
  concurrency?: number
  minAgeDays?: number
  onEvent?: (e: ToolchainEvent) => void
  nowMs: () => number
}

export interface ToolchainResult { items: ToolchainItem[]; state: ToolchainState; changed: boolean }

const GROUP_ORDER: Readonly<Record<ItemGroup, number>> = { runtime: 0, cli: 1, mcp: 2, lsp: 3 }

function groupOf(t: ToolSpec): ItemGroup {
  return t.kind === 'runtime' ? 'runtime' : t.kind === 'lsp' ? 'lsp' : 'cli'
}

function wanted(opts: ToolchainOptions, id: string, group: ItemGroup): boolean {
  return opts.only === undefined || opts.only.length === 0 || opts.only.includes(id) || opts.only.includes(group)
}

export function toolPackage(t: ToolSpec, state: ToolchainState): InstalledPackage | undefined {
  const ref = t.npm !== undefined ? packageKey('npm', t.npm.replace(/(.)@[^@/]+$/, '$1')) : t.pypi !== undefined ? packageKey('pypi', t.pypi.replace(/[[=].*$/, '')) : undefined
  if (ref === undefined) return undefined
  const pkg = state.packages[ref]
  const bin = (t.bins ?? [t.name])[0] ?? t.name
  return pkg !== undefined && pkg.bins[bin] !== undefined ? pkg : undefined
}

export function packageServers(bundle: Pick<CanonicalBundle, 'mcp'>): Array<[string, McpServerSpec]> {
  return Object.keys(bundle.mcp.servers).sort().flatMap((id): Array<[string, McpServerSpec]> => {
    const spec = bundle.mcp.servers[id]
    return spec !== undefined && isPackageServer(spec) && spec.harnesses.length > 0 ? [[id, spec]] : []
  })
}

export function serverRequest(spec: McpServerSpec): PackageRequest {
  const pkg = spec.package as NonNullable<McpServerSpec['package']>
  const req: PackageRequest = { registry: pkg.registry as 'npm' | 'pypi', name: pkg.name, version: pkg.version, bins: [mcpPackageBin(pkg)] }
  if (pkg.extras !== undefined) req.extras = [...pkg.extras]
  if (pkg.scripts === false) req.scripts = false
  return req
}

const LOCK_STALE_MS = 30 * 60_000

export function toolchainLockFile(): string {
  return `${paths.toolchainStateFile()}.lock`
}

let heldLockText: string | undefined

export function takeToolchainLock(nowMs: number): boolean {
  const file = toolchainLockFile()
  mkdirSync(dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, 'wx')
      const text = JSON.stringify({ pid: process.pid, at: nowMs, token: lockToken() })
      writeSync(fd, text)
      closeSync(fd)
      heldLockText = text
      return true
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') return false
      const seen = lockSnapshot(file)
      if (seen === undefined) continue
      let stale = false
      try {
        const held = JSON.parse(seen.text) as { pid?: number, at?: number }
        const alive = typeof held.pid === 'number' && pidAlive(held.pid)
        stale = !alive || typeof held.at !== 'number' || nowMs - held.at > LOCK_STALE_MS
      } catch {
        stale = nowMs - seen.mtimeMs > LOCK_STALE_MS
      }
      if (!stale || breakStaleLock(file, seen) !== 'broken') return false
    }
  }
  return false
}

export function releaseToolchainLock(): void {
  if (heldLockText === undefined) return
  releaseLockFile(toolchainLockFile(), heldLockText)
  heldLockText = undefined
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as { code?: string }).code === 'EPERM' }
}

async function pool<T>(items: readonly T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i] as T)
    }
  })
  await Promise.all(workers)
}

export async function runToolchain(bundle: Pick<CanonicalBundle, 'mcp' | 'tools'>, opts: ToolchainOptions): Promise<ToolchainResult> {
  const items: ToolchainItem[] = []
  let changed = false
  let state = readToolchainState()
  const emit = (item: ToolchainItem, phase: ToolchainEvent['phase']) => { try { opts.onEvent?.({ item: { ...item }, phase }) } catch {  } }
  const record = (change: (s: ToolchainState) => void) => {
    state = updateToolchainState(change, new Date(opts.nowMs()).toISOString())
    changed = true
  }

  const minAgeDays = opts.minAgeDays ?? configuredMinAgeDays()
  const tools = bundle.tools.tools.filter(t => toolApplies(t)).sort((a, b) => GROUP_ORDER[groupOf(a)] - GROUP_ORDER[groupOf(b)])
  const runtimeAndCli = tools.filter(t => groupOf(t) !== 'lsp')
  const lsps = tools.filter(t => groupOf(t) === 'lsp')

  const doTool = async (t: ToolSpec): Promise<void> => {
    const group = groupOf(t)
    const id = `tool:${t.name}`
    if (!wanted(opts, id, group)) return
    const item: ToolchainItem = { id, group, label: t.name, required: t.required, status: 'ok', detail: '' }
    emit(item, 'start')
    const check = await checkTool(t)
    if (check.status === 'ok') {
      item.detail = check.version ?? check.detail
      if (check.version !== undefined) item.current = check.version
    } else {
      const provided = toolPackage(t, state)
      if (provided !== undefined) {
        item.current = provided.version
        item.source = `${provided.registry} ${provided.name} (Buracle toolchain)`
        item.detail = `${provided.version} from the Buracle toolchain`
        const want = t.bins ?? [t.name]
        if (!want.every(b => provided.links?.includes(b))) {
          record(s => {
            const p = s.packages[packageKey(provided.registry, provided.name)]
            if (p !== undefined) p.links = [...new Set([...(p.links ?? []), ...want])].sort()
          })
        }
      } else if (!opts.install || (!opts.system && installSources(t).every(s => s.kind !== 'npm' && s.kind !== 'pypi'))) {
        item.status = 'missing'
        item.detail = `${check.detail}; ${installAdvice(t)}`
      } else {
        const sources = installSources(t).filter(s => opts.system || s.kind === 'npm' || s.kind === 'pypi')
        if (sources.length === 0) {
          item.status = 'missing'
          item.detail = `${check.detail}; ${installAdvice(t)}`
        } else {
          item.source = sources[0]?.label
          const r = await installTool({ ...t, ...(opts.system ? {} : { brew: undefined, winget: undefined, scoop: undefined, go: undefined, dotnet: undefined }) } as ToolSpec, opts.nowMs(), { minAgeDays })
          if (r.ok) {
            const after = await checkTool(t)
            item.status = 'installed'
            if (r.source !== undefined) item.source = r.source.label
            const v = after.version ?? r.pkg?.version
            if (v !== undefined) item.current = v
            item.detail = v !== undefined ? `${v} installed (${item.source})` : `installed (${item.source})`
            record(s => {
              if (r.pkg !== undefined) s.packages[packageKey(r.pkg.registry, r.pkg.name)] = { ...r.pkg, links: [...(t.bins ?? [t.name])] }
              if (r.record !== undefined) s.system[t.name] = r.record
            })
          } else {
            item.status = 'failed'
            item.detail = r.error ?? 'install failed'
          }
        }
      }
    }
    emit(item, 'done')
    items.push(item)
  }

  for (const t of runtimeAndCli.filter(t => groupOf(t) === 'runtime')) await doTool(t)

  const ensurePackage = async (item: ToolchainItem, req: PackageRequest, bin: string): Promise<void> => {
    const key = packageKey(req.registry, req.name)
    const have = state.packages[key]
    const installedOk = have !== undefined && have.bins[bin] !== undefined && fileExists(have.bins[bin] as string)
    if (installedOk) item.current = have.version
    let target = req.version
    let heldNote = ''
    if ((opts.checkLatest || opts.install) && (target === 'latest' || target === '')) {
      const latest = await latestVersion(req.registry, req.name, opts.nowMs(), minAgeDays)
      if ('error' in latest) {
        if (!installedOk) { item.status = opts.install ? 'failed' : 'missing'; item.detail = latest.error }
        else item.detail = `${have.version} (latest unknown: ${latest.error})`
        return
      }
      target = installedOk ? latest.candidate ?? have.version : latest.version
      if (installedOk && target === have.rolled_back) target = have.version
      item.latest = target
      if (latest.held !== undefined) heldNote = `; ${latest.held.version} held back (released ${latest.held.ageDays} day(s) ago, minimum age ${minAgeDays})`
    }
    const needs = !installedOk ? 'install' : target !== 'latest' && compareVersions(have.version, target) < 0 ? 'upgrade' : undefined
    if (needs === undefined) {
      const rolledBack = have?.rolled_back !== undefined ? `; ${have.rolled_back} was rolled back` : ''
      item.detail = `${have?.version}${item.latest !== undefined ? ' (newest allowed)' : ''}${rolledBack}${heldNote}`
      return
    }
    if (!opts.install || (needs === 'upgrade' && !opts.upgrade)) {
      item.status = needs === 'install' ? 'missing' : 'outdated'
      item.detail = needs === 'install' ? 'not installed in the Buracle toolchain' : `${have?.version} installed, ${target} available${heldNote}`
      return
    }
    const r = await installPackage({ ...req, version: target }, opts.nowMs(), { minAgeDays, ...(installedOk ? { before: have.version } : {}) })
    if (!r.ok) {
      const kept = installedOk && (req.registry === 'npm' || pypiStillThere(req))
      item.status = kept ? 'outdated' : 'failed'
      item.detail = kept ? `${have?.version} kept; upgrade failed: ${r.error}` : installedOk ? `upgrade failed and ${have?.version} may be damaged: ${r.error}` : r.error
      return
    }
    item.status = needs === 'install' ? 'installed' : 'upgraded'
    item.current = r.pkg.version
    item.detail = needs === 'install' ? `${r.pkg.version} installed${heldNote}` : `${have?.version} → ${r.pkg.version}${heldNote}`
    record(s => {
      const prev = s.packages[key]
      s.packages[key] = prev?.links !== undefined ? { ...r.pkg, links: prev.links } : r.pkg
    })
  }

  const servers = packageServers(bundle).filter(([id]) => wanted(opts, `mcp:${id}`, 'mcp'))
  await pool(servers, opts.concurrency ?? 3, async ([id, spec]) => {
    const req = serverRequest(spec)
    const item: ToolchainItem = { id: `mcp:${id}`, group: 'mcp', label: id, required: spec.critical, status: 'ok', source: `${req.registry} ${req.name}${req.extras !== undefined ? `[${req.extras.join(',')}]` : ''}`, detail: '' }
    emit(item, 'start')
    await ensurePackage(item, req, mcpPackageBin(spec.package as NonNullable<McpServerSpec['package']>))
    emit(item, 'done')
    items.push(item)
  })

  const ownCopy = async (t: ToolSpec): Promise<void> => {
    const group = groupOf(t)
    const id = `tool:${t.name}`
    if (!wanted(opts, id, group)) return
    const req = toolRequest(t)
    if (req === undefined) return
    const item: ToolchainItem = { id, group, label: t.name, required: t.required, status: 'ok', source: `${req.registry} ${req.name} (Buracle toolchain)`, detail: '' }
    emit(item, 'start')
    await ensurePackage(item, req, t.lsp?.bin ?? (t.bins ?? [t.name])[0] ?? t.name)
    emit(item, 'done')
    items.push(item)
  }

  if (wanted(opts, 'tool:cortexdb', 'cli')) {
    const { CORTEXDB_VERSION, checkCortexdb, installCortexdb } = await import('./cortexdb')
    const item: ToolchainItem = { id: 'tool:cortexdb', group: 'cli', label: 'cortexdb', required: true, status: 'ok', source: `github liliang-cn/cortexdb v${CORTEXDB_VERSION} (Buracle toolchain)`, detail: '' }
    emit(item, 'start')
    const check = checkCortexdb()
    if (check.status === 'ok') {
      item.current = check.version
      item.detail = check.source === 'env' ? `${check.path} (BURACLE_CORTEXDB_BIN)` : `${check.version}, sha256 verified`
    } else if (check.status === 'unsupported') {
      item.status = 'failed'
      item.detail = check.detail
    } else if (!opts.install) {
      item.status = 'missing'
      item.detail = check.detail
    } else {
      const r = await installCortexdb()
      if (r.ok) {
        item.status = 'installed'
        item.current = r.version
        item.detail = `${r.version} installed, sha256 verified`
        record(s => { s.system['cortexdb'] = { via: 'github', version: r.version, path: r.path, installed_at: new Date(opts.nowMs()).toISOString() } })
      } else {
        item.status = 'failed'
        item.detail = r.error
      }
    }
    emit(item, 'done')
    items.push(item)
  }

  if (wanted(opts, 'tool:embed-model', 'cli')) {
    const { EMBED_MODEL, checkEmbedModel, installEmbedModel } = await import('./embed-model')
    const item: ToolchainItem = { id: 'tool:embed-model', group: 'cli', label: 'embeddings', required: false, status: 'ok', source: `huggingface ${EMBED_MODEL.repo}@${EMBED_MODEL.commit.slice(0, 7)} (Buracle toolchain)`, detail: '' }
    emit(item, 'start')
    const check = checkEmbedModel()
    if (check.status === 'ok') {
      item.current = `${check.header.dim}d`
      item.detail = `${EMBED_MODEL.id}: ${check.header.rows} word pieces, ${check.header.dim} dimensions`
    } else if (!opts.install) {
      item.status = 'missing'
      item.detail = check.detail
    } else {
      const r = await installEmbedModel()
      if (r.ok) {
        item.status = 'installed'
        item.current = `${r.dim}d`
        item.detail = `${EMBED_MODEL.id} installed: ${r.rows} word pieces, ${r.dim} dimensions, sha256 verified`
        record(s => { s.system['embed-model'] = { via: 'github', version: EMBED_MODEL.commit.slice(0, 7), path: r.path, installed_at: new Date(opts.nowMs()).toISOString() } })
      } else {
        item.status = 'failed'
        item.detail = r.error
      }
    }
    emit(item, 'done')
    items.push(item)
  }

  // A tool the toolchain installed itself (PATH had none then) moves to newer releases like its own packages.
  const ownedByToolchain = (t: ToolSpec): boolean => t.prefer === 'toolchain' || (opts.install && toolPackage(t, state) !== undefined)
  for (const t of runtimeAndCli.filter(t => groupOf(t) === 'cli')) await (ownedByToolchain(t) ? ownCopy(t) : doTool(t))
  for (const t of lsps) await (ownedByToolchain(t) ? ownCopy(t) : doTool(t))

  if (opts.install && servers.length > 0 && servers.length === packageServers(bundle).length) {
    const npmServers = servers.filter(([, spec]) => spec.package?.registry === 'npm').map(([id]) => `mcp:${id}`)
    if (npmServers.every(id => { const i = items.find(x => x.id === id); return i !== undefined && (i.status === 'ok' || i.status === 'installed' || i.status === 'upgraded') })) {
      try { rmSync(join(fallbackNpmCache(), '_cacache'), { recursive: true, force: true }) } catch {  }
    }
  }

  return { items: items.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)), state, changed }
}

function fileExists(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}

export function blockingProblems(items: readonly ToolchainItem[]): ToolchainItem[] {
  return items.filter(i => i.required && (i.status === 'missing' || i.status === 'failed'))
}

export async function withToolchainLock<T>(nowMs: number, fn: () => Promise<T>): Promise<T | undefined> {
  if (!takeToolchainLock(nowMs)) return undefined
  try {
    return await fn()
  } catch (e) {
    throw new Error(`toolchain: ${errText(e)}`)
  } finally {
    releaseToolchainLock()
  }
}

export interface PackageRollback {
  key: string
  name: string
  from: string
  to?: string
  ok: boolean
  error?: string
}

export function rollbackCandidates(state: ToolchainState, keys?: readonly string[]): InstalledPackage[] {
  return Object.keys(state.packages).sort()
    .filter(k => keys === undefined || keys.includes(k))
    .map(k => state.packages[k] as InstalledPackage)
    .filter(p => p.previous !== undefined)
}

export async function rollbackPackages(packages: readonly InstalledPackage[], nowMs: number): Promise<PackageRollback[]> {
  const out: PackageRollback[] = []
  const nowIso = new Date(nowMs).toISOString()
  for (const p of packages) {
    const key = packageKey(p.registry, p.name)
    const res: PackageRollback = { key, name: p.name, from: p.version, ok: false }
    out.push(res)
    const want = p.previous?.version
    if (want === undefined) { res.error = 'no previous version is recorded'; continue }
    try {
      let next: InstalledPackage
      if (p.registry === 'npm') {
        const live = npmPrefix(p.name)
        const prev = npmPreviousPrefix(p.name)
        const restored = npmInstalledVersion(prev, p.name)
        if (restored === undefined) { res.error = `the previous copy (${want}) is no longer in ${prev}`; continue }
        const aside = `${live}.rollback`
        rmSync(aside, { recursive: true, force: true })
        if (existsSync(live)) renameSync(live, aside)
        try {
          renameSync(prev, live)
        } catch (e) {
          if (existsSync(aside)) renameSync(aside, live)
          throw e
        }
        if (existsSync(aside)) renameSync(aside, prev)
        const all = npmBins(live, p.name)
        const bins: Record<string, string> = {}
        for (const b of Object.keys(p.bins)) if (all[b] !== undefined) bins[b] = all[b] as string
        next = { ...p, version: restored, bins, installed_at: nowIso, previous: { version: p.version }, rolled_back: p.version }
      } else {
        const req: PackageRequest = { registry: 'pypi', name: p.name, version: want, bins: Object.keys(p.bins) }
        if (p.extras !== undefined) req.extras = [...p.extras]
        const r = await installPypi(req, want, nowIso, { before: p.version })
        if (!r.ok) { res.error = r.error; continue }
        next = { ...r.pkg, rolled_back: p.version }
        if (p.links !== undefined) next.links = p.links
      }
      updateToolchainState(s => { s.packages[key] = next }, nowIso)
      res.to = next.version
      res.ok = true
    } catch (e) {
      res.error = errText(e)
    }
  }
  return out
}
