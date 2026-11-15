import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function ompConfigPath(agentDir: string): string {
  const yml = join(agentDir, 'config.yml')
  const yaml = join(agentDir, 'config.yaml')
  return !existsSync(yml) && existsSync(yaml) ? yaml : yml
}
