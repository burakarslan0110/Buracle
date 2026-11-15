import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterContext } from '../registry'
import { detectBinary } from '../../engine/proc'
import { agentDirConflict } from '../shared/agent-dir'
import { resolveArgv, type Env } from '../shared/command'
import { hostLimitRows } from '../shared/host-limits'
import { compareVersions } from '../omp/doctor'
import { EXTENSION_PATH, piMcpServers } from './build'
import { PI_MIN_VERSION } from './generated'
import { piExtensionFile, piMcpFile } from './install'

export type DoctorFinding = { level: 'ok' | 'warn' | 'error', check: string, detail: string }

function readOr(path: string): string | undefined {
  try { return readFileSync(path, 'utf8') } catch { return undefined }
}

/** Whether `mcp.json` holds each server Buracle ships, and whether the commands of the entries can start. */
export function mcpFindings(text: string | undefined, expected: readonly string[], file: string, env: Env): DoctorFinding[] {
  if (text === undefined) return [{ level: 'warn', check: 'pi.mcp', detail: `${file} is missing; run \`buracle install pi\`` }]
  let servers: Record<string, unknown>
  try {
    const doc = JSON.parse(text) as { mcpServers?: unknown }
    servers = doc.mcpServers !== null && typeof doc.mcpServers === 'object' ? doc.mcpServers as Record<string, unknown> : {}
  } catch {
    return [{ level: 'error', check: 'pi.mcp', detail: `${file} is not valid JSON` }]
  }
  const missing = expected.filter(id => servers[id] === undefined)
  const broken: string[] = []
  for (const id of expected) {
    const s = servers[id]
    if (s === null || typeof s !== 'object' || typeof (s as { command?: unknown }).command !== 'string') continue
    const e = s as { command: string, args?: unknown }
    const args = Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === 'string') : []
    if (resolveArgv([e.command, ...args], env).executable === undefined) broken.push(id)
  }
  const out: DoctorFinding[] = []
  if (missing.length > 0) out.push({ level: 'warn', check: 'pi.mcp', detail: `${file} lacks ${missing.join(', ')}; run \`buracle install pi\`` })
  if (broken.length > 0) out.push({ level: 'error', check: 'pi.mcp', detail: `the commands of ${broken.join(', ')} cannot start; install Buracle again and start Pi with the same BURACLE_HOME as this shell` })
  if (out.length === 0) out.push({ level: 'ok', check: 'pi.mcp', detail: `${expected.length} Buracle MCP servers in ${file}` })
  return out
}

export interface DoctorDeps {
  detect?: () => Promise<{ installed: boolean, version?: string, path?: string }>
}

export async function doctor(ctx: AdapterContext, deps: DoctorDeps = {}): Promise<DoctorFinding[]> {
  const conflict = await agentDirConflict(ctx.paths)
  if (conflict?.skipped === 'pi') return [{ level: 'warn', check: 'pi.agent-dir', detail: conflict.message }]
  const out: DoctorFinding[] = [...hostLimitRows('pi')]
  const found = await (deps.detect ?? (() => detectBinary('pi')))()
  if (!found.installed) return [{ level: 'warn', check: 'pi', detail: 'pi is not on PATH; Pi checks skipped' }, ...out]
  if (found.version === undefined) out.push({ level: 'warn', check: 'pi.version', detail: '`pi --version` printed no version' })
  else if (compareVersions(found.version, PI_MIN_VERSION) < 0) out.push({ level: 'error', check: 'pi.version', detail: `Pi ${found.version} is older than ${PI_MIN_VERSION}; run \`pi update self\`` })
  else out.push({ level: 'ok', check: 'pi.version', detail: `Pi ${found.version} (minimum ${PI_MIN_VERSION})` })

  const agentDir = ctx.paths.piAgentDir()
  const built = readOr(join(ctx.repoRoot, 'harness', 'pi', EXTENSION_PATH))
  const installed = readOr(piExtensionFile(agentDir))
  if (built === undefined) out.push({ level: 'error', check: 'pi.extension', detail: `harness/pi/${EXTENSION_PATH} is missing; run \`buracle build\`` })
  else if (installed === undefined) out.push({ level: 'error', check: 'pi.extension', detail: `${piExtensionFile(agentDir)} is missing; run \`buracle install pi\`` })
  else if (installed !== built) out.push({ level: 'warn', check: 'pi.extension', detail: `${piExtensionFile(agentDir)} differs from the build; run \`buracle install pi\`` })
  else out.push({ level: 'ok', check: 'pi.extension', detail: `${piExtensionFile(agentDir)} is the current build` })

  out.push(...mcpFindings(readOr(piMcpFile(agentDir)), Object.keys(piMcpServers(ctx.canonical)), piMcpFile(agentDir), process.env))

  const skills = join(ctx.paths.agentsDir(), 'skills')
  out.push(existsSync(skills)
    ? { level: 'ok', check: 'pi.skills', detail: `Pi reads the shared skills in ${skills}` }
    : { level: 'warn', check: 'pi.skills', detail: `${skills} is missing; run \`buracle install\`` })
  if (!existsSync(ctx.paths.runtimeConfigFile())) {
    out.push({ level: 'warn', check: 'runtime config', detail: `${ctx.paths.runtimeConfigFile()} is missing; the extension uses canonical defaults until \`buracle install\` writes it` })
  }
  return out
}
