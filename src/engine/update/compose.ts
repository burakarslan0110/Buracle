import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Adapter } from '../../adapters/registry'
import type { CanonicalBundle } from '../../core/catalog'
import type { Harness } from '../../core/events'
import { HARNESSES } from '../../core/events'
import * as paths from '../paths'
import { readLedger, type Op, type Plan } from '../txn'
import { harnessLinks, toolchainLinks } from '../toolchain/links'
import { readToolchainState } from '../toolchain/state'
import { inCheckout, type LiveContext } from './context'
import {
  AGENTS_SKILLS_CONSUMERS, agentsSkillsPlan, bunPath, corePlan, dropMixedRemovals, harnessSkillsDir, keyPath, pathRulesDir, planKeys, pruneOps,
  readInstallRecord, type PathRuleFile,
} from './install-core'
import { errText, isInside } from './output'

export interface HarnessStatus {
  harness: Harness
  enabled: boolean
  inScope: boolean
  installed: boolean
  version?: string
  /** The harness program, as its adapter found it (may be a folder PATH does not reach, such as ~/.bun/bin). */
  path?: string
  included: boolean
  reason?: string
}

export interface ComposedPlan {
  key: string
  plan: Plan
  keys: string[]
  prunes: number
}

export interface ComposeResult {
  plans: ComposedPlan[]
  harnesses: HarnessStatus[]
  errors: Array<{ source: string, error: string }>
  warnings: string[]
  busy: Array<{ harness: Harness, message: string }>
  /** Harnesses older than the oldest version Buracle supports: left as they are (the adapter's HARNESS_TOO_OLD). */
  tooOld: TooOldHarness[]
}

export interface TooOldHarness { harness: Harness, version: string, min: string, update: string, message: string }

export interface ComposeOptions {
  repoRoot: string
  live: LiveContext
  adapters: readonly Adapter[]
  only?: readonly Harness[]
  coreOnly?: boolean
}

function isPlanLike(x: unknown): x is Plan {
  return x !== null && typeof x === 'object' && Array.isArray((x as Plan).ops)
}

export function isHarnessBusy(e: unknown): boolean {
  const x = e as { code?: unknown, name?: unknown } | null
  return x !== null && typeof x === 'object' && (x.code === 'HARNESS_BUSY' || x.name === 'HarnessBusyError')
}

function harnessTooOld(e: unknown): Pick<TooOldHarness, 'version' | 'min' | 'update'> | undefined {
  const x = e as { code?: unknown, version?: unknown, min?: unknown, update?: unknown } | null
  if (x === null || typeof x !== 'object' || x.code !== 'HARNESS_TOO_OLD') return undefined
  if (typeof x.version !== 'string' || typeof x.min !== 'string' || typeof x.update !== 'string') return undefined
  return { version: x.version, min: x.min, update: x.update }
}

export async function renderPathRules(canonical: Pick<CanonicalBundle, 'rules' | 'skills' | 'agents'>): Promise<PathRuleFile[]> {
  const { pathRuleFiles } = await import('../../adapters/shared/rules')
  return pathRuleFiles(canonical).map(r => ({ id: r.id, content: r.content }))
}

export async function detectHarnesses(adapters: readonly Adapter[], live: LiveContext, only?: readonly Harness[]): Promise<HarnessStatus[]> {
  const byHarness = new Map(adapters.map(a => [a.harness, a]))
  return Promise.all(HARNESSES.filter(h => byHarness.has(h)).map(async (h): Promise<HarnessStatus> => {
    const enabled = live.config.harnesses[h]?.enabled !== false
    const inScope = only === undefined || only.includes(h)
    const st: HarnessStatus = { harness: h, enabled, inScope, installed: false, included: false }
    if (!inScope) { st.reason = 'not selected'; return st }
    try {
      const d = await (byHarness.get(h) as Adapter).detect()
      st.installed = d.installed === true
      if (typeof d.version === 'string') st.version = d.version
      if (typeof d.path === 'string') st.path = d.path
    } catch (e) {
      st.reason = `detect failed: ${errText(e)}`
      return st
    }
    if (!enabled) st.reason = 'disabled in config'
    else if (!st.installed) st.reason = 'not installed'
    else st.included = true
    return st
  }))
}

export async function composeInstall(opts: ComposeOptions): Promise<ComposeResult> {
  const res: ComposeResult = { plans: [], harnesses: [], errors: [], warnings: [], busy: [], tooOld: [] }
  const { record, warning } = readInstallRecord()
  if (warning) res.warnings.push(warning)
  const ledger = await readLedger()
  const raw: Array<{ key: string, plan: Plan, carried?: string[] }> = []

  let pathRules: PathRuleFile[] | undefined
  try {
    pathRules = await renderPathRules(opts.live.ctx.canonical)
  } catch (e) {
    res.warnings.push(`path rules (${pathRulesDir()}) were not refreshed: ${errText(e)}`)
  }
  const rulesDir = resolve(pathRulesDir())
  const carried = pathRules !== undefined ? [] : (record.plans['core']?.keys ?? []).filter(k => isInside(resolve(keyPath(k)), rulesDir))
  const core: Parameters<typeof corePlan>[0] = { repoRoot: opts.repoRoot, bun: bunPath(), configExists: existsSync(paths.userConfigFile()) }
  if (pathRules !== undefined) core.pathRules = pathRules
  const links = toolchainLinks(readToolchainState())
  if (links.length > 0) core.links = links
  raw.push({ key: 'core', plan: corePlan(core), carried })

  if (!opts.coreOnly) {
    res.harnesses = await detectHarnesses(opts.adapters, opts.live, opts.only)
    // A harness program that no shell of the user reaches by name (omp under ~/.bun/bin) gets a link in ~/.local/bin.
    // A harness this run did not look at (not selected, or its detection failed) keeps the link an earlier run made:
    // `buracle install codex` must not take omp's link away.
    const harnessBins = harnessLinks(res.harnesses, process.env['PATH'])
    const unseen = res.harnesses.filter(h => !h.inScope || (h.reason ?? '').startsWith('detect failed')).map(h => resolve(join(paths.localBinDir(), h.harness)))
    const linkCarried = (record.plans['core']?.keys ?? []).filter(k => unseen.includes(resolve(keyPath(k))))
    if (harnessBins.length > 0 || linkCarried.length > 0) {
      core.links = [...(core.links ?? []), ...harnessBins]
      raw[0] = { key: 'core', plan: corePlan(core), carried: [...carried, ...linkCarried] }
    }
    const included = res.harnesses.filter(h => h.included).map(h => h.harness)
    // A harness this run did not look at (not selected, or its detection failed) keeps its skill
    // links; every other recorded link that no plan produces is pruned, the old ~/.agents/skills ones too.
    const untouched = res.harnesses.filter(h => !h.inScope || (h.reason ?? '').startsWith('detect failed')).map(h => harnessSkillsDir(h.harness)).filter((d): d is string => d !== undefined).map(d => resolve(d))
    const skillCarried = (record.plans['agents-skills']?.keys ?? []).filter(k => untouched.some(d => isInside(resolve(keyPath(k)), d)))
    if (included.some(h => AGENTS_SKILLS_CONSUMERS.includes(h)) || record.plans['agents-skills'] !== undefined) {
      raw.push({ key: 'agents-skills', plan: agentsSkillsPlan(opts.repoRoot, included), carried: skillCarried })
    }
    for (const h of included) {
      const adapter = opts.adapters.find(a => a.harness === h) as Adapter
      try {
        const plan: unknown = await inCheckout(opts.repoRoot, () => adapter.installPlan(opts.live.ctx))
        if (!isPlanLike(plan)) throw new Error('installPlan() did not return a plan')
        const composed: Plan = { id: typeof plan.id === 'string' && plan.id !== '' ? plan.id : h, harness: h, ops: [...plan.ops] }
        if (Array.isArray(plan.cleanupKeys) && plan.cleanupKeys.length > 0) composed.cleanupKeys = [...plan.cleanupKeys]
        raw.push({ key: h, plan: composed })
      } catch (e) {
        const old = harnessTooOld(e)
        if (isHarnessBusy(e)) {
          res.busy.push({ harness: h, message: errText(e) })
          const st = res.harnesses.find(x => x.harness === h)
          if (st) { st.included = false; st.reason = 'running; not changed' }
        } else if (old !== undefined) {
          res.tooOld.push({ harness: h, ...old, message: errText(e) })
          const st = res.harnesses.find(x => x.harness === h)
          if (st) { st.included = false; st.reason = `older than ${old.min}; not changed` }
        } else res.errors.push({ source: h, error: errText(e) })
      }
    }
  }

  const prunes = new Set<Op>()
  const produced = new Set(raw.flatMap(r => [...planKeys(r.plan), ...(r.carried ?? [])]))
  const withPrunes = raw.map(({ key, plan, carried: kept }) => {
    const keys = [...new Set([...planKeys(plan), ...(kept ?? [])])].sort()
    const extra = pruneOps(key, plan, record, ledger, produced)
    for (const op of extra) prunes.add(op)
    return { key, keys, plan: { ...plan, ops: [...extra, ...plan.ops] } }
  })
  const { plans, dropped } = dropMixedRemovals(withPrunes.map(p => p.plan), prunes)
  if (dropped.length > 0) res.warnings.push(`kept ${dropped.length} stale item(s) for now: they share a file with a current write (${dropped.map(o => (o.kind === 'remove' ? o.path : '')).join(', ')})`)
  res.plans = withPrunes.map((p, i) => {
    const plan = plans[i] as Plan
    return { key: p.key, plan, keys: p.keys, prunes: plan.ops.filter(op => prunes.has(op)).length }
  })
  return res
}
