/**
 * `buracle mcp disable|enable <id> [--harness <h>]`: changes `mcp.off.<harness>` and runs the install of the
 * affected harnesses, which writes each one's own off setting (src/adapters/<harness>/install.ts).
 */
import { join } from 'node:path'
import type { McpCatalog } from '../core/catalog'
import type { Harness } from '../core/events'
import { HARNESSES } from '../core/events'

export interface OffPlan { targets: Harness[], changed: Harness[], next: Record<Harness, string[]> }

/** Which harness lists change when `id` is turned off (or on) in `harness`, or in every harness it ships to. */
export function planOffChange(catalog: McpCatalog, off: Readonly<Record<Harness, readonly string[]>>, id: string | undefined, turnOff: boolean, harness?: string): OffPlan | { error: string } {
  if (id === undefined || id === '') return { error: 'missing <id>' }
  const spec = catalog.servers[id]
  if (spec === undefined) return { error: `unknown server '${id}' (see \`buracle mcp list\`)` }
  let targets: Harness[]
  if (harness !== undefined) {
    if (!(HARNESSES as readonly string[]).includes(harness)) return { error: `unknown harness '${harness}' (one of ${HARNESSES.join(', ')})` }
    if (!spec.harnesses.includes(harness as Harness)) return { error: `${id} does not ship to ${harness} (it ships to ${spec.harnesses.join(', ')})` }
    targets = [harness as Harness]
  } else {
    targets = HARNESSES.filter(h => spec.harnesses.includes(h))
  }
  const next = Object.fromEntries(HARNESSES.map(h => [h, [...(off[h] ?? [])]])) as Record<Harness, string[]>
  const changed: Harness[] = []
  for (const h of targets) {
    const has = next[h].includes(id)
    if (turnOff && !has) { next[h] = [...next[h], id].sort(); changed.push(h) }
    if (!turnOff && has) { next[h] = next[h].filter(x => x !== id); changed.push(h) }
  }
  return { targets, changed, next }
}

interface IO { stdout: { write(s: string): void }, stderr: { write(s: string): void } }

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export async function setMcpOff(input: { id: string | undefined, harness?: string, turnOff: boolean }, io: IO): Promise<number> {
  const word = input.turnOff ? 'disable' : 'enable'
  const { readMcpCatalog } = await import('./toolchain/launch')
  const { loadConfigSync } = await import('./config')
  let catalog: McpCatalog
  try { catalog = readMcpCatalog() } catch (e) { io.stderr.write(`buracle mcp ${word}: ${e instanceof Error ? e.message : String(e)}\n`); return 1 }
  const off = loadConfigSync().config.mcp.off
  const plan = planOffChange(catalog, off, input.id, input.turnOff, input.harness)
  if ('error' in plan) { io.stderr.write(`buracle mcp ${word}: ${plan.error}\n`); return 1 }
  const id = input.id as string
  const state = input.turnOff ? 'off' : 'on'
  if (plan.changed.length === 0) {
    io.stdout.write(`${id} is already ${state} in ${plan.targets.join(', ')}.\n`)
    return 0
  }
  const { setConfigValue } = await import('./config-edit')
  for (const h of plan.changed) {
    const r = await setConfigValue(`mcp.off.${h}`, plan.next[h])
    if (!r.ok) { io.stderr.write(`buracle mcp ${word}: ${r.error}\n`); return 1 }
  }
  // The install writes each harness's own off setting; the toolchain step is not needed for that.
  const { opsDeps } = await import('./update/deps')
  const { bunPath } = await import('./update/install-core')
  const repo = opsDeps.repoRoot()
  const r = await opsDeps.run([bunPath(), join(repo, 'src', 'cli', 'main.ts'), 'install', ...plan.changed, '--yes', '--json'], { timeoutMs: 600_000, cwd: repo, env: { ...process.env, BURACLE_NO_TOOLCHAIN: '1' } })
  let result: Record<string, unknown> | undefined
  try { const v = JSON.parse(r.stdout) as unknown; result = isObj(v) ? v : undefined } catch { result = undefined }
  const list = (k: string): unknown[] => (Array.isArray(result?.[k]) ? result[k] as unknown[] : [])
  const busy = list('busyHarnesses').filter((h): h is string => typeof h === 'string')
  const tooOld = list('tooOldHarnesses').filter(isObj)
  const conflicts = list('conflicts').filter(isObj)
  const errors = list('errors').map(e => (isObj(e) ? `${String(e['source'] ?? 'install')}: ${String(e['error'] ?? '')}` : String(e)))
  // Install also exits 2 for a requested harness it skips (not installed here, disabled in config): nothing of it was written.
  const skipped = list('harnesses').filter(isObj)
    .filter(h => (plan.changed as string[]).includes(String(h['harness'])) && h['included'] === false && !busy.includes(String(h['harness'])) && !tooOld.some(t => t['harness'] === h['harness']))
    .map(h => ({ harness: String(h['harness']), reason: typeof h['reason'] === 'string' ? h['reason'] : 'skipped' }))
  if (r.code !== 0 && (result?.['ok'] !== true || busy.length > 0 || tooOld.length > 0 || conflicts.length > 0 || errors.length > 0)) {
    for (const h of busy) io.stderr.write(`buracle mcp ${word}: ${h} is running, so its settings were not written: close it and run \`buracle install ${h}\`\n`)
    for (const t of tooOld) io.stderr.write(`buracle mcp ${word}: ${String(t['harness'])} ${String(t['version'])} is older than ${String(t['min'])}, so its settings were not written: ${String(t['update'])}\n`)
    for (const c of conflicts) io.stderr.write(`buracle mcp ${word}: conflict in ${String(c['path'])}: ${String(c['detail'])}\n`)
    for (const e of errors) io.stderr.write(`buracle mcp ${word}: ${e}\n`)
    if (busy.length === 0 && tooOld.length === 0 && conflicts.length === 0 && errors.length === 0) io.stderr.write(`buracle mcp ${word}: \`buracle install ${plan.changed.join(' ')}\` failed (exit ${r.code}): ${(r.stderr.trim().split('\n').pop() ?? '').slice(0, 300)}\n`)
    io.stderr.write(`buracle mcp ${word}: mcp.off is saved; it reaches the harnesses above at their next \`buracle install\`.\n`)
    return 2
  }
  // Off in every harness it ships to: no session needs its shared backend any more.
  const spec = catalog.servers[id]
  if (input.turnOff && spec !== undefined && spec.harnesses.every(h => plan.next[h].includes(id))) {
    const { signalBackends } = await import('./mcp-share/procs')
    signalBackends(id)
  }
  const written = plan.changed.filter(h => !skipped.some(x => x.harness === h))
  if (written.length > 0) io.stdout.write(`${id} is now ${state} in ${written.join(', ')}. It applies from the next session there.\n`)
  for (const x of skipped) io.stdout.write(`${x.harness} was skipped (${x.reason}); mcp.off.${x.harness} is saved and reaches it at its next \`buracle install ${x.harness}\`.\n`)
  return 0
}
