import type { Adapter, AdapterContext } from '../registry'
import type { Plan } from '../../engine/txn'
import { detectBinary } from '../../engine/proc'
import { buildFiles } from './build'
import { doctor } from './doctor'
import { installPlan } from './install'

export const adapter: Adapter = {
  harness: 'opencode',

  detect() {
    return detectBinary('opencode')
  },

  async build(ctx: AdapterContext) {
    return buildFiles(ctx)
  },

  async installPlan(ctx: AdapterContext): Promise<Plan> {
    return installPlan(ctx)
  },

  async doctor(ctx: AdapterContext) {
    return doctor(ctx)
  },
}

export default adapter
