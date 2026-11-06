// The API keys `buracle mcp key` stores for MCP servers (`api_key` in canonical/mcp.yaml). The forwarder reads
// them at each connect, so keep the imports light: no node:crypto, no YAML.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { McpServerSpec } from '../../core/catalog'
import * as paths from '../paths'
import { ensurePrivateDir } from './common'

export type ApiKeySource = 'env' | 'stored'
/** `name` is the variable the server reads its key from. */
export interface ApiKey { name: string, value: string, source: ApiKeySource }

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

/** The stored keys by server id; a missing or broken file holds none. */
export function readStoredKeys(): Record<string, string> {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(paths.mcpKeysFile(), 'utf8')) } catch { return {} }
  const keys = isObj(raw) && isObj(raw['keys']) ? raw['keys'] : {}
  return Object.fromEntries(Object.entries(keys).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''))
}

/**
 * The API key a session of server `id` runs it with: the variable in the session's environment first (the
 * usual rule for a tool's settings), else the stored key. Undefined for a server without `api_key`.
 */
export function apiKeyFor(id: string, spec: McpServerSpec, env: Readonly<Record<string, string | undefined>>): ApiKey | undefined {
  const name = spec.api_key?.env
  if (name === undefined) return undefined
  const fromEnv = env[name]
  if (fromEnv !== undefined && fromEnv.trim() !== '') return { name, value: fromEnv, source: 'env' }
  const stored = readStoredKeys()[id]
  return stored !== undefined ? { name, value: stored, source: 'stored' } : undefined
}

/**
 * Stores the key of `id`, or removes it when `value` is undefined, in a file only this user can read (mode
 * 0600 in a 0700 folder). Returns whether the stored keys changed; throws when the folder is not private.
 */
export function writeStoredKey(id: string, value: string | undefined): boolean {
  const keys = readStoredKeys()
  if (keys[id] === value) return false
  if (value === undefined) delete keys[id]
  else keys[id] = value
  const dir = paths.secretsDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const problem = ensurePrivateDir(dir)
  if (problem !== undefined) throw new Error(problem)
  const file = paths.mcpKeysFile()
  const tmp = `${file}.${process.pid}.tmp`
  const doc = { v: 1, keys: Object.fromEntries(Object.keys(keys).sort().map(k => [k, keys[k] as string])) }
  try {
    rmSync(tmp, { force: true })
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
  return true
}

/** `…` and the last four characters: enough to tell two keys apart, never the key. */
export function maskKey(value: string): string {
  return value.length >= 12 ? `…${value.slice(-4)}` : '…'
}
