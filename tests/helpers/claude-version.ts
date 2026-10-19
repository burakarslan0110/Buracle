import { MIN_CLAUDE, TESTED_WITH } from '../../src/adapters/claude/constants'
import { parseVersion } from '../../src/engine/proc'
import { compareVersions, parseVersionString } from '../../src/engine/update/versions'

export interface ClaudeVersionGate {
  runs: boolean
  version: string
  note?: string
}

export function claudeVersionGate(versionText: string, tested: string = TESTED_WITH, min: string = MIN_CLAUDE): ClaudeVersionGate {
  const version = parseVersion(versionText) ?? ''
  if (version === '') return { runs: false, version, note: 'claude --version printed no version' }
  const major = (v: string) => parseVersionString(v)?.nums[0]
  if (compareVersions(version, min) < 0) return { runs: false, version, note: `claude ${version} is older than the supported minimum ${min}` }
  if (major(version) !== major(tested)) return { runs: false, version, note: `claude ${version} is outside the tested major (${tested})` }
  if (compareVersions(version, tested) > 0) return { runs: true, version, note: `claude ${version} is newer than the tested ${tested}; a failure here may be mods API drift (update TESTED_WITH once it passes)` }
  return { runs: true, version }
}

export function claudeVersionText(bin: string): string {
  try {
    return Bun.spawnSync([bin, '--version'], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000, env: { ...process.env } }).stdout.toString().trim()
  } catch {
    return ''
  }
}
