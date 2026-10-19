import type { BuracleConfig } from '../../../core/config'
import { log } from '../../../engine/log'
import { memoryExcludePatterns, projectExclusion } from '../../../memory/project'

export async function cmExclusion(projectDir: string, config?: Pick<BuracleConfig, 'memory'>): Promise<string | undefined> {
  try {
    const patterns = [...new Set([...(config?.memory.exclude ?? []), ...memoryExcludePatterns()])]
    return await projectExclusion(projectDir, patterns)
  } catch (e) {
    log('debug', 'context-mode: cannot check memory.exclude for the project folder', { error: e })
    return undefined
  }
}
