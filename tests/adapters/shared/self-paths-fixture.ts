import { join } from 'node:path'
import * as paths from '../../../src/engine/paths'

export function sandboxSelfPaths(sb: { home: string, buracleHome: string }): Record<string, string> {
  return {
    buracleHome: sb.buracleHome, localBinDir: join(sb.home, '.local', 'bin'), claudeDir: join(sb.home, '.claude'), codexHome: join(sb.home, '.codex'),
    opencodeConfigDir: join(sb.home, '.config', 'opencode'), ompAgentDir: join(sb.home, '.omp', 'agent'), ompHome: join(sb.home, '.omp'), repo: paths.repoRoot(),
  }
}
