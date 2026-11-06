// Read by every forwarder start: keep the imports light.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mcpCacheFile } from '../paths'

/** What a forwarder answers `initialize` and `tools/list` from while it has no backend. */
export interface McpCache {
  v: 1
  id: string
  /** The package version the upstream ran: the cache is valid only for that version. */
  version: string
  initialize: Record<string, unknown>
  tools: unknown[]
}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export function readMcpCache(id: string): McpCache | undefined {
  try {
    const raw = JSON.parse(readFileSync(mcpCacheFile(id), 'utf8')) as unknown
    if (!isObj(raw) || raw['v'] !== 1 || raw['id'] !== id || typeof raw['version'] !== 'string' || !isObj(raw['initialize']) || !Array.isArray(raw['tools'])) return undefined
    return raw as unknown as McpCache
  } catch {
    return undefined
  }
}

/** The cache when it was written for `version`, else undefined. */
export function freshMcpCache(id: string, version: string): McpCache | undefined {
  const c = readMcpCache(id)
  return c !== undefined && c.version === version ? c : undefined
}

export function writeMcpCache(cache: McpCache): void {
  const file = mcpCacheFile(cache.id)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(cache)}\n`, { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    try { rmSync(tmp, { force: true }) } catch {  }
  }
}
