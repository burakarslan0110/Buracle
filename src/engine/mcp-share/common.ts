// Shared by the backend and the forwarder: keep the imports light, the forwarder lives as long as its session.
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServerSpec } from '../../core/catalog'
import { mcpSocketDir, toolchainStateFile } from '../paths'

/** The packages of ~/.buracle/state/toolchain.json, read without the toolchain module (it loads node:crypto). */
export interface InstalledPackages { [key: string]: { version: string, bins: Record<string, string> } | undefined }

export function readInstalledPackages(): InstalledPackages {
  try {
    const raw = JSON.parse(readFileSync(toolchainStateFile(), 'utf8')) as { packages?: unknown }
    return raw.packages !== null && typeof raw.packages === 'object' && !Array.isArray(raw.packages) ? raw.packages as InstalledPackages : {}
  } catch {
    return {}
  }
}

/** The version of the forwarder-backend exchange; part of the backend key, so two versions never share a socket. */
export const MUX_PROTOCOL = 1
/** A shared backend stops this long after its last client left. */
export const LINGER_MS = 60_000
/** A forwarder lets go of its backend (and a lazy forwarder stops its server) after this long without a call. */
export const IDLE_MS = 10 * 60_000

function envMs(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** BURACLE_MCP_LINGER_MS (milliseconds) changes the linger time; a value that is not a positive number is ignored. */
export function lingerMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  return envMs(env, 'BURACLE_MCP_LINGER_MS', LINGER_MS)
}

/** BURACLE_MCP_IDLE_MS (milliseconds) changes the idle time; a value that is not a positive number is ignored. */
export function idleMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  return envMs(env, 'BURACLE_MCP_IDLE_MS', IDLE_MS)
}

/** The toolchain version of a package server whose program is installed, else undefined (the package runner, `latest`). */
export function installedVersion(spec: McpServerSpec, packages: InstalledPackages = readInstalledPackages()): string | undefined {
  const pkg = spec.package
  if (pkg === undefined || (pkg.registry !== 'npm' && pkg.registry !== 'pypi')) return undefined
  // The key format of src/engine/toolchain/state.ts (packageKey) and the bin rule of src/core/catalog.ts
  // (mcpPackageBin), written out here: the catalog module costs the forwarder about 1 MB.
  const installed = packages[`${pkg.registry}:${pkg.name}`]
  const bin = pkg.bin !== undefined && pkg.bin.trim() !== '' ? pkg.bin : (pkg.name.split('/').pop() ?? pkg.name)
  const entry = installed?.bins?.[bin]
  return installed !== undefined && typeof installed.version === 'string' && entry !== undefined && existsSync(entry) ? installed.version : undefined
}

/** `<id>-<package version or latest>-p<protocol>`: one backend per server, package version and protocol. */
export function backendKey(id: string, version: string | undefined): string {
  const v = (version === undefined || version === '' ? 'latest' : version).replace(/[^A-Za-z0-9._-]/g, '_')
  return `${id}-${v}-p${MUX_PROTOCOL}`
}

export interface BackendFiles { dir: string, socket: string, lock: string, state: string }

export function backendFiles(key: string): BackendFiles {
  const dir = mcpSocketDir(key)
  return { dir, socket: join(dir, `${key}.sock`), lock: join(dir, `${key}.lock`), state: join(dir, `${key}.json`) }
}

function myUid(): number | undefined {
  return process.getuid?.()
}

/**
 * Creates `dir` (mode 0700) when it is missing, then checks it: a directory, not a symbolic link, owned by
 * this user, with no group or other permission bits. Returns why it cannot be used, or undefined. It never
 * changes the mode of a directory that already exists.
 */
export function ensurePrivateDir(dir: string): string | undefined {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') return `cannot create ${dir}: ${e instanceof Error ? e.message : String(e)}`
  }
  let st
  try {
    st = lstatSync(dir)
  } catch (e) {
    return `cannot read ${dir}: ${e instanceof Error ? e.message : String(e)}`
  }
  if (st.isSymbolicLink()) return `${dir} is a symbolic link; remove it`
  if (!st.isDirectory()) return `${dir} is not a directory; remove it`
  const uid = myUid()
  if (uid !== undefined && st.uid !== uid) return `${dir} belongs to another user (uid ${st.uid}); remove it`
  if ((st.mode & 0o077) !== 0) return `${dir} is open to other users (mode ${(st.mode & 0o777).toString(8)}); remove it or run \`chmod 700\` on it`
  return undefined
}

/** Whether `path` exists, is no symbolic link and belongs to this user. */
export function ownedByMe(path: string): boolean {
  try {
    const st = lstatSync(path)
    const uid = myUid()
    return !st.isSymbolicLink() && (uid === undefined || st.uid === uid)
  } catch {
    return false
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
