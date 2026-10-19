import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Adapter } from '../../adapters/registry'
import type { CanonicalBundle } from '../../core/catalog'
import type { Harness } from '../../core/events'
import { HARNESSES } from '../../core/events'
import * as paths from '../paths'
import { readLedger, type Op, type Plan } from '../txn'
import { toolchainLinks } from '../toolchain/links'
import { readToolchainState } from '../toolchain/state'
import { inCheckout, type LiveContext } from './context'
import {
  AGENTS_SKILLS_CONSUMERS, agentsSkillsPlan, bunPath, corePlan, dropMixedRemovals, keyPath, pathRulesDir, planKeys, pruneOps,
  readInstallRecord, type PathRuleFile,
} from './install-core'
import { errText, isInside } from './output'

export interface HarnessStatus {
  harness: Harness
  enabled: boolean
  inScope: boolean
  installed: boolean
  version?: string
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
}

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
  const res: ComposeResult = { plans: [], harnesses: [], errors: [], warnings: [], busy: [] }
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
    const included = res.harnesses.filter(h => h.included).map(h => h.harness)
    if (included.some(h => AGENTS_SKILLS_CONSUMERS.includes(h))) raw.push({ key: 'agents-skills', plan: agentsSkillsPlan(opts.repoRoot) })
    for (const h of included) {
      const adapter = opts.adapters.find(a => a.harness === h) as Adapter
      try {
        const plan: unknown = await inCheckout(opts.repoRoot, () => adapter.installPlan(opts.live.ctx))
        if (!isPlanLike(plan)) throw new Error('installPlan() did not return a plan')
        const composed: Plan = { id: typeof plan.id === 'string' && plan.id !== '' ? plan.id : h, harness: h, ops: [...plan.ops] }
        if (Array.isArray(plan.cleanupKeys) && plan.cleanupKeys.length > 0) composed.cleanupKeys = [...plan.cleanupKeys]
        raw.push({ key: h, plan: composed })
      } catch (e) {
        if (isHarnessBusy(e)) {
          res.busy.push({ harness: h, message: errText(e) })
          const st = res.harnesses.find(x => x.harness === h)
          if (st) { st.included = false; st.reason = 'running; not changed' }
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
