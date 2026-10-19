import type { Adapter, AdapterContext } from '../registry'
import type { Plan } from '../../engine/txn'
import { detectBinary } from '../../engine/proc'
import { log } from '../../engine/log'

export const adapter: Adapter = {
  harness: 'codex',

  detect() {
    return detectBinary('codex')
  },

  async build(ctx: AdapterContext) {
    const { codexBuildFiles } = await import('./generate')
    const { files, warnings } = codexBuildFiles(ctx.canonical)
    if (warnings.length > 0) log('warn', 'codex build warnings', { warnings })
    return files
  },

  async installPlan(ctx: AdapterContext): Promise<Plan> {
    const { codexInstallPlan } = await import('./install')
    return codexInstallPlan(ctx)
  },

  async uninstallPlan(ctx: AdapterContext): Promise<Plan> {
    const { codexUninstallPlan } = await import('./install')
    return codexUninstallPlan(ctx)
  },

  async doctor(ctx: AdapterContext) {
    const { codexDoctor } = await import('./doctor')
    return codexDoctor(ctx)
  },

  async hook(event: string, stdin: string, ctx: AdapterContext) {
    const { handleCodexHook } = await import('./hook')
    return handleCodexHook(event, stdin, ctx)
  },
}

export default adapter
