import { detectBinary } from '../../engine/proc'
import type { Adapter, AdapterContext } from '../registry'
import { hooksFragment, mcpFragment, settingsFragment } from './config'

export const adapter: Adapter = {
  harness: 'agy',

  detect: () => detectBinary('agy'),

  // The two generated files are the fragments the install merges into hooks.json and mcp_config.json; `{buracle}` stands for the shim's path.
  async build(ctx: AdapterContext) {
    return [
      { path: 'hooks.fragment.json', content: hooksFragment(ctx.canonical) },
      { path: 'mcp_config.fragment.json', content: mcpFragment(ctx.canonical, '{buracle}') },
      { path: 'settings.fragment.json', content: settingsFragment() },
    ]
  },

  async installPlan(ctx: AdapterContext) {
    return (await import('./install')).agyInstallPlan(ctx)
  },

  async uninstallPlan(ctx: AdapterContext) {
    return (await import('./install')).agyUninstallPlan(ctx)
  },

  async doctor(ctx: AdapterContext) {
    return (await import('./doctor')).agyDoctor(ctx)
  },

  async hook(event: string, stdin: string, ctx: AdapterContext) {
    return (await import('./hook')).handleAgyHook(event, stdin, ctx)
  },
}

export default adapter
