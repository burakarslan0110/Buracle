import type { CanonicalBundle } from '../../core/catalog'
import * as paths from '../paths'
import type { PackageRollback } from '../toolchain/index'
import { toolRequest } from '../toolchain/packages'
import { packageKey, readToolchainState } from '../toolchain/state'
import { opsDeps } from './deps'
import { checkTools } from './doctor'
import { probeServers, writeHealth } from './mcp'
import { errText } from './output'
import type { ApplyOutcome } from './updates'

// An upgrade that fails the check which proves it works is undone, so an update never leaves a
// broken MCP server or tool behind when the toolchain still keeps the version it replaced.
export type UpgradedKind = 'mcp' | 'tools'
export interface UpgradedPart { kind: UpgradedKind; id: string }
export interface BrokenUpgrade extends UpgradedPart { key: string; error: string }

export interface RollbackDeps {
  // The version the toolchain kept for a package, if it kept one.
  previous(key: string): string | undefined
  // undefined: another Buracle process holds the toolchain lock.
  rollback(keys: string[]): Promise<PackageRollback[] | undefined>
  // The check that found the part broken, run again.
  recheck(part: UpgradedPart): Promise<{ ok: boolean, error?: string }>
}

// rolled-back: the previous version works and stays. kept: neither version works, so the update is not
// the cause and the newer version stays. stuck: still broken and nothing more could be done.
export type RollbackStatus = 'rolled-back' | 'kept' | 'stuck'
export interface RollbackVerdict extends UpgradedPart { status: RollbackStatus; detail: string }

const verdict = (b: BrokenUpgrade, status: RollbackStatus, detail: string): RollbackVerdict => ({ kind: b.kind, id: b.id, status, detail })

async function rollbackOne(deps: RollbackDeps, key: string): Promise<PackageRollback | 'busy'> {
  try {
    const r = await deps.rollback([key])
    if (r === undefined) return 'busy'
    return r[0] ?? { key, name: key, from: '?', ok: false, error: 'no result' }
  } catch (e) {
    return { key, name: key, from: '?', ok: false, error: errText(e) }
  }
}

async function recheck(deps: RollbackDeps, part: UpgradedPart): Promise<{ ok: boolean, error?: string }> {
  try { return await deps.recheck(part) } catch (e) { return { ok: false, error: errText(e) } }
}

async function rollbackPackage(key: string, items: readonly BrokenUpgrade[], deps: RollbackDeps): Promise<RollbackVerdict[]> {
  const stuck = (why: string) => items.map(i => verdict(i, 'stuck', `${i.error}; ${why}`))
  if (deps.previous(key) === undefined) return stuck('no earlier version is kept, so it stays on the new one')
  const back = await rollbackOne(deps, key)
  if (back === 'busy') return stuck('another Buracle process holds the toolchain; run `buracle rollback toolchain` when it is done')
  if (!back.ok) return stuck(`rolling back failed: ${back.error ?? 'no detail'}`)
  const was = back.from
  const now = back.to ?? 'the previous version'
  const after = await Promise.all(items.map(i => recheck(deps, i)))
  if (after.some(r => r.ok)) {
    return items.map((i, n) => {
      const r = after[n]
      return r?.ok === true
        ? verdict(i, 'rolled-back', `${was} fails its check (${i.error}); rolled back to ${now}, which works`)
        : verdict(i, 'stuck', `${i.error}; ${now} still fails its check (${r?.error ?? 'no detail'})`)
    })
  }
  // Neither version works, so the new one did not break it: put it back.
  const forward = await rollbackOne(deps, key)
  if (forward === 'busy' || !forward.ok) return stuck(`${now} fails too and putting ${was} back failed (${forward === 'busy' ? 'another Buracle process holds the toolchain' : forward.error ?? 'no detail'}), so it stays on ${now}`)
  return items.map(i => verdict(i, 'kept', `${i.error}; ${now} fails its check too, so the update is not the cause and it stays on ${was}`))
}

// One package is rolled back once, however many of its parts (an MCP server and a CLI, say) are broken.
export async function rollbackBroken(broken: readonly BrokenUpgrade[], deps: RollbackDeps): Promise<RollbackVerdict[]> {
  const groups = new Map<string, BrokenUpgrade[]>()
  for (const b of broken) groups.set(b.key, [...(groups.get(b.key) ?? []), b])
  const byPart = new Map<BrokenUpgrade, RollbackVerdict>()
  for (const [key, items] of groups) {
    const verdicts = await rollbackPackage(key, items, deps)
    items.forEach((item, n) => { const v = verdicts[n]; if (v !== undefined) byPart.set(item, v) })
  }
  return broken.flatMap(b => { const v = byPart.get(b); return v === undefined ? [] : [v] })
}

type Catalog = Pick<CanonicalBundle, 'mcp' | 'tools'>

export function packageKeyOf(bundle: Catalog, part: UpgradedPart): string | undefined {
  if (part.kind === 'mcp') {
    const pkg = bundle.mcp.servers[part.id]?.package
    return pkg === undefined || pkg.registry === 'none' ? undefined : packageKey(pkg.registry, pkg.name)
  }
  const tool = bundle.tools.tools.find(t => t.name === part.id)
  const req = tool === undefined ? undefined : toolRequest(tool)
  return req === undefined ? undefined : packageKey(req.registry, req.name)
}

// The upgraded parts that fail their check: an MCP server that did not answer the handshake the update just ran,
// a tool whose version check does not run.
export async function findBroken(upgraded: readonly UpgradedPart[], bundle: Catalog, handshakes: ReadonlyArray<{ id: string, status: string, error?: string }>): Promise<BrokenUpgrade[]> {
  const broken: BrokenUpgrade[] = []
  const add = (part: UpgradedPart, error: string): void => {
    const key = packageKeyOf(bundle, part)
    if (key !== undefined) broken.push({ ...part, key, error })
  }
  for (const p of upgraded.filter(u => u.kind === 'mcp')) {
    const h = handshakes.find(x => x.id === p.id)
    if (h !== undefined && h.status !== 'ok') add(p, h.error ?? 'no answer to the handshake')
  }
  const tools = upgraded.filter(u => u.kind === 'tools').flatMap(p => { const t = bundle.tools.tools.find(x => x.name === p.id); return t === undefined ? [] : [t] })
  const results = tools.length > 0 ? await checkTools(tools) : []
  for (const r of results) if (r.status !== 'ok') add({ kind: 'tools', id: r.name }, r.detail)
  return broken
}

export function realRollbackDeps(bundle: Catalog): RollbackDeps {
  const nowIso = () => new Date(opsDeps.now()).toISOString()
  return {
    previous: key => readToolchainState().packages[key]?.previous?.version,
    rollback: keys => opsDeps.rollbackToolchain(keys),
    async recheck(part) {
      if (part.kind === 'mcp') {
        const entries = await probeServers(bundle.mcp, { ids: [part.id], timeoutMs: 60_000, fetcher: opsDeps.fetch, buracle: paths.shimPath() }, nowIso)
        try { writeHealth({ mcp: entries }, nowIso()) } catch {  }
        const e = entries[part.id]
        return e === undefined ? { ok: false, error: 'not probed' } : e.status === 'ok' ? { ok: true } : { ok: false, error: e.error ?? 'no answer' }
      }
      const tool = bundle.tools.tools.find(t => t.name === part.id)
      const [r] = tool === undefined ? [] : await checkTools([tool])
      return r?.status === 'ok' ? { ok: true } : { ok: false, error: r?.detail ?? 'not in tools.yaml' }
    },
  }
}

// A rolled-back or stuck part did not update: it moves from applied to failed. A kept one did update, but its check still fails.
export function applyVerdicts(outcome: ApplyOutcome, verdicts: readonly RollbackVerdict[]): void {
  for (const v of verdicts) {
    if (v.status === 'kept') { outcome.skipped.push({ kind: v.kind, id: v.id, reason: v.detail }); continue }
    const at = outcome.applied.findIndex(a => a.kind === v.kind && a.id === v.id)
    if (at >= 0) outcome.applied.splice(at, 1)
    outcome.failed.push({ kind: v.kind, id: v.id, error: v.detail })
  }
}
