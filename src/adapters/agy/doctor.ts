import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { jsoncParse } from '../../engine/merge'
import { detectBinary, run } from '../../engine/proc'
import { MIN_VERSIONS } from '../../engine/update/min-versions'
import { compareVersions } from '../../engine/update/versions'
import type { AdapterContext } from '../registry'
import { agyHooks, agyMcpServers, AGY_HOOK_EVENTS, HOOK_NAME, isBuracleCommand, isBuracleStatusLine } from './config'
import { hooksPath, mcpConfigPath, settingsPath } from './install'

export interface DoctorItem { level: 'ok' | 'warn' | 'error', check: string, detail: string }

const PROBE_COMMAND = 'rm -rf ~'
const rec = (x: unknown): Record<string, unknown> => (x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {})

/** The PreToolUse hook, started the way AGY starts it (`sh -c`), must deny a catastrophic command. */
async function guardProbe(command: string, cwd: string): Promise<DoctorItem> {
  const check = 'agy.hooks.probe'
  const payload = JSON.stringify({ conversationId: 'buracle-doctor-probe', cwd, workspacePaths: [cwd], hookEventName: 'PreToolUse', toolCall: { id: 'probe', name: 'run_command', args: { CommandLine: PROBE_COMMAND } }, stepIdx: 0 })
  const r = await run(['/bin/sh', '-c', command], { stdin: payload, cwd, timeoutMs: 30_000, env: { BURACLE_NO_CAPTURE: '1', BURACLE_NO_MEMORY: '1', BURACLE_NO_AUTOSTART: '1' } })
  let decision: unknown
  try { decision = rec(JSON.parse(r.stdout) as unknown)['decision'] } catch { decision = undefined }
  if (decision === 'deny') return { level: 'ok', check, detail: `the PreToolUse hook denies \`${PROBE_COMMAND}\` (H01), started as AGY starts it` }
  const why = r.timedOut ? 'timed out' : `exit ${r.code}${r.stderr.trim() !== '' ? `: ${r.stderr.trim().split('\n')[0]?.slice(0, 200)}` : ''}`
  return { level: 'error', check, detail: `the PreToolUse hook did not deny \`${PROBE_COMMAND}\` (${why}): AGY would run tools unguarded; check ~/.buracle/logs/buracle.log` }
}

function readJson(file: string): { ok: true, value: Record<string, unknown> } | { ok: false, error: string } {
  const parsed = jsoncParse(readFileSync(file, 'utf8'))
  return parsed.ok ? { ok: true, value: rec(parsed.value) } : { ok: false, error: parsed.error }
}

export async function agyDoctor(ctx: AdapterContext): Promise<DoctorItem[]> {
  const out: DoctorItem[] = []
  const bin = await detectBinary('agy')
  if (!bin.installed) return [{ level: 'warn', check: 'agy.binary', detail: 'agy is not on PATH; nothing to check' }]
  const min = MIN_VERSIONS.agy
  if (bin.version !== undefined && compareVersions(bin.version, min) < 0) out.push({ level: 'error', check: 'agy.version', detail: `AGY CLI ${bin.version} is older than ${min}, the oldest Buracle supports; update it with \`agy update\`` })
  else out.push({ level: 'ok', check: 'agy.version', detail: `AGY CLI ${bin.version ?? '(version unknown)'} (minimum ${min})` })

  const file = hooksPath(ctx)
  if (!existsSync(file)) return [...out, { level: 'warn', check: 'agy.hooks', detail: `${file} does not exist: run \`buracle install agy\`` }]
  const hooksJson = readJson(file)
  if (!hooksJson.ok) return [...out, { level: 'error', check: 'agy.hooks', detail: `${file} is not valid JSON (${hooksJson.error}); Buracle does not touch it, so its hooks cannot be registered` }]
  const mine = rec(hooksJson.value[HOOK_NAME])
  const want = agyHooks(ctx.canonical)
  const handlers = (event: string): unknown[] => (Array.isArray(mine[event]) ? mine[event] as unknown[] : []).flatMap(g => (rec(g)['hooks'] !== undefined ? rec(g)['hooks'] as unknown[] : [g]))
  const missing = AGY_HOOK_EVENTS.filter(e => (want[e]?.length ?? 0) > 0 && !handlers(e).some(h => isBuracleCommand(rec(h)['command'])))
  if (mine['enabled'] === false) out.push({ level: 'error', check: 'agy.hooks', detail: `the "${HOOK_NAME}" hook is disabled ("enabled": false) in ${file}: no Buracle hook runs, including the guards` })
  else if (missing.length > 0) out.push({ level: 'error', check: 'agy.hooks', detail: `no Buracle hook for ${missing.join(', ')} in ${file}: run \`buracle install agy\`` })
  else {
    out.push({ level: 'ok', check: 'agy.hooks', detail: `Buracle hooks for ${AGY_HOOK_EVENTS.filter(e => (want[e]?.length ?? 0) > 0).length} events in ${file}` })
    const guard = rec(handlers('PreToolUse').map(rec).find(h => isBuracleCommand(h['command'])))
    if (typeof guard['command'] === 'string') out.push(await guardProbe(guard['command'], ctx.paths.home()))
  }

  const mcpFile = mcpConfigPath(ctx)
  const mcp = existsSync(mcpFile) ? readJson(mcpFile) : undefined
  const servers = mcp?.ok === true ? rec(mcp.value['mcpServers']) : {}
  const lost = Object.keys(agyMcpServers(ctx.canonical, ctx.buracleBin)).filter(id => servers[id] === undefined)
  if (mcp?.ok === false) out.push({ level: 'error', check: 'agy.mcp', detail: `${mcpFile} is not valid JSON (${mcp.error}); Buracle does not touch it` })
  else out.push(lost.length > 0 ? { level: 'warn', check: 'agy.mcp', detail: `MCP servers missing from ${mcpFile}: ${lost.join(', ')} (run \`buracle install agy\`)` } : { level: 'ok', check: 'agy.mcp', detail: `${Object.keys(servers).length} MCP servers in ${mcpFile}` })

  const settingsFile = settingsPath(ctx)
  const settings = existsSync(settingsFile) ? readJson(settingsFile) : undefined
  const statusCmd = settings?.ok === true ? rec(settings.value['statusLine'])['command'] : undefined
  if (settings?.ok === false) out.push({ level: 'error', check: 'agy.statusLine', detail: `${settingsFile} is not valid JSON (${settings.error}); Buracle does not touch it` })
  else if (typeof statusCmd !== 'string') out.push({ level: 'warn', check: 'agy.statusLine', detail: `no statusLine in ${settingsFile}: run \`buracle install agy\`` })
  else if (!isBuracleStatusLine(statusCmd)) out.push({ level: 'warn', check: 'agy.statusLine', detail: `statusLine runs ${JSON.stringify(statusCmd)}, not Buracle's status line (kept as the user's choice)` })
  else out.push({ level: 'ok', check: 'agy.statusLine', detail: `statusLine in ${settingsFile} runs \`buracle statusline agy\`` })

  // AGY does not read ~/.agents/skills: the install links each skill into its own folder.
  const skills = join(ctx.paths.harnessConfigDir('agy'), 'skills')
  const linked = existsSync(skills) ? readdirSync(skills).filter(n => lstatSync(join(skills, n)).isSymbolicLink() && existsSync(join(skills, n, 'SKILL.md'))).length : 0
  out.push(linked > 0 ? { level: 'ok', check: 'agy.skills', detail: `${linked} skills linked in ${skills}` } : { level: 'warn', check: 'agy.skills', detail: `no skill links in ${skills}: run \`buracle install\`` })
  return out
}
