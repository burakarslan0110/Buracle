import { REVIEWER_AGENT_ENV, companionAgent, companionToolDenial } from '../../../core/policy/companion-fence'
import type { OmpExtensionAPI, OmpToolCallEvent, OmpToolCallResult } from './types'

const FENCE_FAILED = 'Buracle H01: the read-only check of this second-opinion review failed, so the call was blocked.'

export function reviewerFenceFromEnv(): string | undefined {
  return companionAgent(process.env[REVIEWER_AGENT_ENV])
}

export function fenceToolCall(agent: string | undefined, event: OmpToolCallEvent): OmpToolCallResult | undefined {
  if (agent === undefined) return undefined
  try {
    const input = event.input !== null && typeof event.input === 'object' ? event.input : {}
    const why = companionToolDenial('omp', agent, String(event.toolName), input)
    return why === undefined ? undefined : { block: true, reason: `Buracle H01: ${why.replace(/^Buracle:\s*/, '')}` }
  } catch {
    return { block: true, reason: FENCE_FAILED }
  }
}

export async function fenceActiveTools(pi: Pick<OmpExtensionAPI, 'getActiveTools' | 'setActiveTools'>, agent: string | undefined): Promise<string[]> {
  if (agent === undefined || typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') return []
  const active = pi.getActiveTools()
  if (!Array.isArray(active)) return []
  const drop = active.filter(n => n !== 'write' && companionToolDenial('omp', agent, n, {}) !== undefined)
  if (drop.length === 0) return []
  await pi.setActiveTools(active.filter(n => !drop.includes(n)))
  return drop
}
