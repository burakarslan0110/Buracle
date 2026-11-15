import type { Adapter, AdapterContext } from '../registry'
import type { Plan } from '../../engine/txn'
import { detectBinary } from '../../engine/proc'
import { buildPi } from './build'
import { doctor } from './doctor'
import { installPlan, uninstallPlan } from './install'

export const adapter: Adapter = {
  harness: 'pi',

  detect() {
    return detectBinary('pi')
  },

  build(ctx: AdapterContext) {
    return buildPi(ctx)
  },

  installPlan(ctx: AdapterContext): Promise<Plan> {
    return installPlan(ctx)
  },

  uninstallPlan(ctx: AdapterContext): Promise<Plan> {
    return uninstallPlan(ctx)
  },

  doctor(ctx: AdapterContext) {
    return doctor(ctx)
  },
}

export { uninstallPlan }
export default adapter
