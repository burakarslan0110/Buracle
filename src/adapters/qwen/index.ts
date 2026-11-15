import { detectBinary } from '../../engine/proc'
import type { Adapter, AdapterContext } from '../registry'
import { settingsFragment } from './settings'

export const adapter: Adapter = {
  harness: 'qwen',

  detect: () => detectBinary('qwen'),

  // The one generated file is the fragment the install merges into ~/.qwen/settings.json; `{buracle}` stands for the shim's path.
  async build(ctx: AdapterContext) {
    return [{ path: 'settings.fragment.json', content: settingsFragment(ctx.canonical, '{buracle}') }]
  },

  async installPlan(ctx: AdapterContext) {
    return (await import('./install')).qwenInstallPlan(ctx)
  },

  async uninstallPlan(ctx: AdapterContext) {
    return (await import('./install')).qwenUninstallPlan(ctx)
  },

  async doctor(ctx: AdapterContext) {
    return (await import('./doctor')).qwenDoctor(ctx)
  },

  async hook(event: string, stdin: string, ctx: AdapterContext) {
    return (await import('./hook')).handleQwenHook(event, stdin, ctx)
  },
}

export default adapter
