/**
 * The fast path of `buracle mcp run <id>` for a server with a shared or lazy backend. The process stays a
 * forwarder for the whole harness session, so it loads neither the command router nor the YAML catalog: the
 * backend mode comes from the JSON snapshots (a cut of harness/hook-data.json, runtime-config.json). A server
 * without a backend, or `mcp.shared: false`, takes the normal path through the router (src/cli/commands/mcp.ts).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServerSpec } from '../core/catalog'
import { harnessDir, mcpCacheDir, runtimeConfigFile } from '../engine/paths'

export interface SharedRoute { spec: McpServerSpec, mode: 'shared' | 'lazy' }

interface BackendCut { v?: unknown, src?: { path?: unknown, size?: unknown, mtimeMs?: unknown }, servers?: unknown }

const CUT_VERSION = 1

function isSpecMap(x: unknown): x is Record<string, McpServerSpec> {
  return x !== null && typeof x === 'object' && !Array.isArray(x) && Object.values(x).every(v => v !== null && typeof v === 'object' && !Array.isArray(v))
}

/**
 * The specs of the servers with a backend. Parsing all of harness/hook-data.json (70 KB) costs a forwarder about
 * 1 MB for its whole session, so the first forwarder after a build keeps a 2 KB cut of it in the MCP cache folder,
 * keyed by the snapshot's path, size and mtime. The leading `_` keeps the name apart from a server id.
 */
function backendSpecs(): Record<string, McpServerSpec> | undefined {
  const src = join(harnessDir(), 'hook-data.json')
  let st: { size: number, mtimeMs: number }
  try { st = statSync(src) } catch { return undefined }
  const cut = join(mcpCacheDir(), '_backends.json')
  try {
    const doc = JSON.parse(readFileSync(cut, 'utf8')) as BackendCut
    if (doc.v === CUT_VERSION && doc.src?.path === src && doc.src.size === st.size && doc.src.mtimeMs === st.mtimeMs && isSpecMap(doc.servers)) return doc.servers
  } catch {  }
  let servers: Record<string, McpServerSpec>
  try {
    const data = JSON.parse(readFileSync(src, 'utf8')) as { mcp?: { servers?: Record<string, McpServerSpec> } }
    servers = Object.fromEntries(Object.entries(data.mcp?.servers ?? {}).filter(([, s]) => s.backend === 'shared' || s.backend === 'lazy'))
  } catch {
    return undefined
  }
  const tmp = `${cut}.${process.pid}.tmp`
  try {
    mkdirSync(mcpCacheDir(), { recursive: true })
    writeFileSync(tmp, JSON.stringify({ v: CUT_VERSION, src: { path: src, size: st.size, mtimeMs: st.mtimeMs }, servers }), { mode: 0o600 })
    renameSync(tmp, cut)
  } catch {
    try { rmSync(tmp, { force: true }) } catch {  }
  }
  return servers
}

/** The backend mode of `id` while sharing is on (`mcp.shared`, default true), else undefined. */
export function sharedRoute(id: string): SharedRoute | undefined {
  const spec = backendSpecs()?.[id]
  if (spec === undefined || (spec.backend !== 'shared' && spec.backend !== 'lazy')) return undefined
  try {
    const snap = JSON.parse(readFileSync(runtimeConfigFile(), 'utf8')) as { config?: { mcp?: { shared?: unknown } } }
    if (snap.config?.mcp?.shared === false) return undefined
  } catch {  }
  return { spec, mode: spec.backend }
}

/**
 * The harness that started this server when the server is off there: the Claude plugin entries name their
 * harness (BURACLE_HARNESS), and `mcp.off.<harness>` of the runtime snapshot lists the server. A fallback for
 * when the harness's own off setting did not keep it from starting.
 */
export function offInStartingHarness(id: string, env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const h = env['BURACLE_HARNESS']
  if (h === undefined || h === '') return undefined
  try {
    const snap = JSON.parse(readFileSync(runtimeConfigFile(), 'utf8')) as { config?: { mcp?: { off?: Record<string, unknown> } } }
    const list = snap.config?.mcp?.off?.[h]
    return Array.isArray(list) && list.includes(id) ? h : undefined
  } catch {
    return undefined
  }
}

/** Runs the forwarder for `mcp run <id>` and returns its exit code, or undefined for the normal path. */
export async function fastMcpRun(argv: readonly string[], write?: (line: string) => void): Promise<number | undefined> {
  if (argv.length !== 3 || argv[0] !== 'mcp' || argv[1] !== 'run') return undefined
  const id = argv[2]
  if (id === undefined || id.startsWith('-')) return undefined
  const offIn = offInStartingHarness(id)
  if (offIn !== undefined) {
    process.stderr.write(`buracle mcp run: ${id} is off in ${offIn}; \`buracle mcp enable ${id} --harness ${offIn}\` turns it on\n`)
    return 0
  }
  const route = sharedRoute(id)
  if (route === undefined) return undefined
  const { expireLaunchFailures } = await import('./commands/mcp')
  await expireLaunchFailures(Date.now())
  const forwarder = await import('../engine/mcp-share/forwarder')
  const run = route.mode === 'shared' ? forwarder.runSharedForwarder : forwarder.runLazyForwarder
  return run(id, route.spec, write !== undefined ? { write } : {})
}
