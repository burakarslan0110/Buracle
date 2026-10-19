import type { BuracleConfig } from '../../../core/config'
import type { CatalogMcp, CatalogSkill } from '../../../core/catalog'
import type { HookId } from '../../../core/events'
import type { Notice } from '../../../core/notices'
import type { PathRuleIndex } from '../../../core/policy/path-rules'
import type { RoutingPolicy } from '../../../core/policy/routing'
import type { StatusLayout } from '../../../core/status/model'

export interface BakedHook { id: HookId; blocking: 'none' | 'deny' | 'stop'; failure: 'open' | 'closed' }

export interface BakedData {
  v: 1
  contentHash: string
  testedWith: string
  defaults: BuracleConfig
  routing: RoutingPolicy
  mcp: CatalogMcp[]
  mcpIds: string[]
  skills: CatalogSkill[]
  plugins: string[]
  hooks: BakedHook[]
  pathRules?: PathRuleIndex[]
  layout?: StatusLayout
  version?: string
  notices?: Notice[]
}

export const DEFAULT_HOOK_FAILURE: Readonly<Partial<Record<HookId, 'open' | 'closed'>>> = {
  H01: 'closed',
  H02: 'closed',
  H03: 'open',
  H08: 'open',
  H09: 'open',
  H11: 'open',
}

export function hookFailure(baked: Pick<BakedData, 'hooks'>, id: HookId): 'open' | 'closed' {
  const hit = baked.hooks.find(h => h.id === id)
  return hit?.failure ?? DEFAULT_HOOK_FAILURE[id] ?? 'open'
}
