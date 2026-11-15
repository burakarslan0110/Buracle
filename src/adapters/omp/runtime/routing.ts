import { promptRouting as familyPromptRouting, type PromptRouting } from '../../shared/pi-family/routing'

export { availableServers, createDepsReader, mergeRoutes, routerData, sessionHealth } from '../../shared/pi-family/routing'
export type { LedgerAccess, PromptRouting, RouterData } from '../../shared/pi-family/routing'

export function isDeviceWrite(toolName: string, input: Record<string, unknown>): boolean {
  const p = input['path']
  return toolName === 'write' && typeof p === 'string' && /^xd:\/\//i.test(p.trim())
}

export function promptRouting(prompt: string, data: Parameters<typeof familyPromptRouting>[1], o: Omit<Parameters<typeof familyPromptRouting>[2], 'harness'>): PromptRouting {
  return familyPromptRouting(prompt, data, { harness: 'omp', ...o })
}
