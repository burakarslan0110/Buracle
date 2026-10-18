import { CM_HIDDEN_TOOLS, cmToolName } from '../../../core/context-mode'
import type { OmpExtensionAPI } from './types'

export const OMP_HIDDEN_TOOLS: ReadonlySet<string> = new Set(CM_HIDDEN_TOOLS.map(t => cmToolName('omp', t)))

export async function hideTools(pi: Pick<OmpExtensionAPI, 'getActiveTools' | 'setActiveTools'>, hidden: ReadonlySet<string> = OMP_HIDDEN_TOOLS): Promise<string[]> {
  if (typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') return []
  const active = pi.getActiveTools()
  if (!Array.isArray(active)) return []
  const drop = active.filter(n => hidden.has(n))
  if (drop.length === 0) return []
  await pi.setActiveTools(active.filter(n => !hidden.has(n)))
  return drop
}
