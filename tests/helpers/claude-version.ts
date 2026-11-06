import { MIN_CLAUDE } from '../../src/adapters/claude/constants'
import { parseVersion } from '../../src/engine/proc'
import { compareVersions } from '../../src/engine/update/versions'

export interface ClaudeVersionGate {
  runs: boolean
  version: string
  note?: string
}

// The real-binary checks run on every Claude Code at or above the supported minimum.
export function claudeVersionGate(versionText: string, min: string = MIN_CLAUDE): ClaudeVersionGate {
  const version = parseVersion(versionText) ?? ''
  if (version === '') return { runs: false, version, note: 'claude --version printed no version' }
  if (compareVersions(version, min) < 0) return { runs: false, version, note: `claude ${version} is older than the supported minimum ${min}` }
  return { runs: true, version }
}

export function claudeVersionText(bin: string): string {
  try {
    return Bun.spawnSync([bin, '--version'], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000, env: { ...process.env } }).stdout.toString().trim()
  } catch {
    return ''
  }
}
