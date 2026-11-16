import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { jsoncParse, mdBlockMarkers } from '../../engine/merge'
import { detectBinary, run } from '../../engine/proc'
import { MIN_VERSIONS } from '../../engine/update/min-versions'
import { compareVersions } from '../../engine/update/versions'
import type { AdapterContext } from '../registry'
import { qwenContentFiles, QWEN_BLOCK_ID } from './content'
import { settingsPath } from './install'
import { isBuracleCommand, isBuracleStatusLine, qwenHooks, qwenMcpServers, QWEN_HOOK_EVENTS } from './settings'

export interface DoctorItem { level: 'ok' | 'warn' | 'error', check: string, detail: string }

const PROBE_COMMAND = 'rm -rf ~'
const rec = (x: unknown): Record<string, unknown> => (x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {})

/** The PreToolUse hook, started the way Qwen Code starts it (a shell line), must deny a catastrophic command. */
async function guardProbe(command: string, cwd: string): Promise<DoctorItem> {
  const check = 'qwen.hooks.probe'
  const payload = JSON.stringify({ session_id: 'buracle-doctor-probe', cwd, hook_event_name: 'PreToolUse', permission_mode: 'default', tool_name: 'run_shell_command', tool_use_id: 'probe', tool_input: { command: PROBE_COMMAND } })
  const r = await run(['/bin/sh', '-c', command], { stdin: payload, cwd, timeoutMs: 30_000, env: { BURACLE_NO_CAPTURE: '1', BURACLE_NO_MEMORY: '1', BURACLE_NO_AUTOSTART: '1' } })
  let decision: unknown
  try { decision = rec(rec(JSON.parse(r.stdout) as unknown)['hookSpecificOutput'])['permissionDecision'] } catch { decision = undefined }
  if (decision === 'deny') return { level: 'ok', check, detail: `the PreToolUse hook denies \`${PROBE_COMMAND}\` (H01), started as Qwen Code starts it` }
  const why = r.timedOut ? 'timed out' : `exit ${r.code}${r.stderr.trim() !== '' ? `: ${r.stderr.trim().split('\n')[0]?.slice(0, 200)}` : ''}`
  return { level: 'error', check, detail: `the PreToolUse hook did not deny \`${PROBE_COMMAND}\` (${why}): Qwen Code would run tools unguarded; check ~/.buracle/logs/buracle.log` }
}

export async function qwenDoctor(ctx: AdapterContext): Promise<DoctorItem[]> {
  const out: DoctorItem[] = []
  const bin = await detectBinary('qwen')
  if (!bin.installed) return [{ level: 'warn', check: 'qwen.binary', detail: 'qwen is not on PATH; nothing to check' }]
  const min = MIN_VERSIONS.qwen
  if (bin.version !== undefined && compareVersions(bin.version, min) < 0) out.push({ level: 'error', check: 'qwen.version', detail: `Qwen Code ${bin.version} is older than ${min}, the oldest Buracle Stack supports (hook events and the ~/.agents/skills folder); update it with the installer that installed it` })
  else out.push({ level: 'ok', check: 'qwen.version', detail: `Qwen Code ${bin.version ?? '(version unknown)'} (minimum ${min})` })

  const file = settingsPath(ctx)
  let settings: Record<string, unknown> = {}
  if (!existsSync(file)) return [...out, { level: 'warn', check: 'qwen.settings', detail: `${file} does not exist: run \`buracle install qwen\`` }]
  const parsed = jsoncParse(readFileSync(file, 'utf8'))
  if (!parsed.ok) return [...out, { level: 'error', check: 'qwen.settings', detail: `${file} is not valid JSON (${parsed.error}); Buracle Stack does not touch it, so its hooks cannot be registered` }]
  settings = rec(parsed.value)

  if (settings['disableAllHooks'] === true) out.push({ level: 'error', check: 'qwen.hooks', detail: `disableAllHooks is true in ${file}: no Buracle Stack hook runs, including the guards` })
  const hooks = rec(settings['hooks'])
  const want = qwenHooks(ctx.canonical)
  const missing = QWEN_HOOK_EVENTS.filter(e => (want[e]?.length ?? 0) > 0 && !(Array.isArray(hooks[e]) && (hooks[e] as unknown[]).some(g => rec(g)['hooks'] !== undefined && (rec(g)['hooks'] as unknown[]).some(h => isBuracleCommand(rec(h)['command'])))))
  if (missing.length > 0) out.push({ level: 'error', check: 'qwen.hooks', detail: `no Buracle Stack hook for ${missing.join(', ')} in ${file}: run \`buracle install qwen\`` })
  else {
    out.push({ level: 'ok', check: 'qwen.hooks', detail: `Buracle Stack hooks for ${QWEN_HOOK_EVENTS.filter(e => (want[e]?.length ?? 0) > 0).length} events in ${file} (user-level hooks need no approval)` })
    const guard = rec(((hooks['PreToolUse'] as unknown[]) ?? []).map(rec).flatMap(g => (Array.isArray(g['hooks']) ? g['hooks'] as unknown[] : [])).map(rec).find(h => isBuracleCommand(h['command'])))
    if (typeof guard['command'] === 'string') out.push(await guardProbe(guard['command'], ctx.paths.home()))
  }

  const servers = rec(settings['mcpServers'])
  const lost = Object.keys(qwenMcpServers(ctx.canonical, ctx.buracleBin)).filter(id => servers[id] === undefined)
  out.push(lost.length > 0 ? { level: 'warn', check: 'qwen.mcp', detail: `MCP servers missing from ${file}: ${lost.join(', ')} (run \`buracle install qwen\`, or they are off in mcp.off.qwen)` } : { level: 'ok', check: 'qwen.mcp', detail: `${Object.keys(servers).length} MCP servers in ${file}` })

  const statusCmd = rec(rec(settings['ui'])['statusLine'])['command']
  if (typeof statusCmd !== 'string') out.push({ level: 'warn', check: 'qwen.statusLine', detail: `no ui.statusLine in ${file}: run \`buracle install qwen\`` })
  else if (!isBuracleStatusLine(statusCmd)) out.push({ level: 'warn', check: 'qwen.statusLine', detail: `ui.statusLine runs ${JSON.stringify(statusCmd)}, not Buracle Stack's status line (kept as the user's choice)` })
  else out.push({ level: 'ok', check: 'qwen.statusLine', detail: `ui.statusLine in ${file} runs \`buracle statusline qwen\`` })

  // Buracle Stack's tips ride in `ui.customWittyPhrases`; Qwen Code shows those phrases only in the `witty` and `all` modes (default `off`, 1.0.0-preview.1).
  if ((ctx.canonical.tips ?? []).length > 0) {
    const mode = rec(settings['ui'])['loadingPhrases']
    out.push(mode === 'witty' || mode === 'all'
      ? { level: 'ok', check: 'qwen.tips', detail: `ui.loadingPhrases is ${mode}: Buracle Stack's tips show while the model works` }
      : { level: 'warn', check: 'qwen.tips', detail: `Buracle Stack's tips show only when ui.loadingPhrases is "witty" or "all" (it is ${typeof mode === 'string' ? JSON.stringify(mode) : 'unset, so "off"'} in ${file}); Buracle Stack leaves that setting to you` })
  }

  // The always-loaded rules (a block in QWEN.md), the path rules, the review agents and the commands are files the install writes.
  const home = ctx.paths.qwenHome()
  const memory = join(home, 'QWEN.md')
  const hasBlock = existsSync(memory) && readFileSync(memory, 'utf8').includes(mdBlockMarkers(QWEN_BLOCK_ID).start)
  const absent = qwenContentFiles(ctx.canonical).map(f => f.path).filter(p => !existsSync(join(home, p)))
  out.push(hasBlock && absent.length === 0
    ? { level: 'ok', check: 'qwen.content', detail: `the rules block in ${memory}, the path rules, the review agents and the commands are in ${home}` }
    : { level: 'warn', check: 'qwen.content', detail: `${[...(hasBlock ? [] : [`the Buracle Stack block in ${memory}`]), ...absent.map(p => join(home, p))].join(', ')} missing: run \`buracle install qwen\`` })

  const skills = join(ctx.paths.agentsDir(), 'skills')
  out.push(existsSync(skills) ? { level: 'ok', check: 'qwen.skills', detail: `Qwen Code reads the skills from ${skills}` } : { level: 'warn', check: 'qwen.skills', detail: `${skills} does not exist: run \`buracle install\`` })
  return out
}
