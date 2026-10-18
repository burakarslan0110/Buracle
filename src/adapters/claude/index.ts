import type { Adapter, AdapterContext } from '../registry'
import type { Plan } from '../../engine/txn'
import { detectBinary } from '../../engine/proc'

export const adapter: Adapter = {
  harness: 'claude',

  detect() {
    return detectBinary('claude')
  },

  async build(ctx: AdapterContext) {
    const { buildClaude } = await import('./build')
    return buildClaude(ctx)
  },

  async installPlan(ctx: AdapterContext): Promise<Plan> {
    const { claudeInstallPlan } = await import('./install')
    return claudeInstallPlan(ctx)
  },

  async doctor(ctx: AdapterContext) {
    const { claudeDoctor } = await import('./doctor')
    return claudeDoctor(ctx)
  },

  async hook(event: string, stdin: string, ctx: AdapterContext) {
    const { claudeHook } = await import('./hook')
    return claudeHook(event, stdin, ctx)
  },
}

export default adapter
