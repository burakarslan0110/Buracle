import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renameRetrySync, sha256 } from '../fsx'
import * as paths from '../paths'
import { exeName, osName } from '../platform'

// CortexDB is installed from its newest GitHub release. Each release publishes `<asset>.sha256` next to the binary:
// the download must match it, and the hash is kept beside the binary for later checks.
export const CORTEXDB_ASSETS: Readonly<Record<string, string>> = {
  'darwin-arm64': 'cortexdb-mcp-darwin-arm64',
  'darwin-x64': 'cortexdb-mcp-darwin-amd64',
  'linux-x64': 'cortexdb-mcp-linux-amd64',
  'linux-arm64': 'cortexdb-mcp-linux-arm64',
  'win32-x64': 'cortexdb-mcp-windows-amd64.exe',
  'win32-arm64': 'cortexdb-mcp-windows-arm64.exe',
}

export const CORTEXDB_BIN_ENV = 'BURACLE_CORTEXDB_BIN'
const RELEASES_URL = 'https://github.com/liliang-cn/cortexdb/releases'
const DOWNLOAD_TIMEOUT_MS = 180_000
const MAX_BYTES = 120 * 1024 * 1024
const VERSION_RE = /^\d+\.\d+\.\d+$/
const SHA_FILE = 'cortexdb-mcp.sha256'

export function cortexdbPlatform(arch: string = process.arch): string | undefined {
  const key = `${osName()}-${arch}`
  return CORTEXDB_ASSETS[key] !== undefined ? key : undefined
}

export function cortexdbDir(): string { return join(paths.toolchainDir(), 'cortexdb') }

export function cortexdbBinPath(version: string): string {
  return join(cortexdbDir(), version, exeName('cortexdb-mcp'))
}

function shaPath(version: string): string { return join(cortexdbDir(), version, SHA_FILE) }

function isFile(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}

function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return (x[0]! - y[0]!) || (x[1]! - y[1]!) || (x[2]! - y[2]!)
}

// The installed versions, newest first: a folder counts once its binary and its recorded hash are both in place.
export function installedCortexdbVersions(): string[] {
  let names: string[]
  try { names = readdirSync(cortexdbDir()).filter(n => VERSION_RE.test(n)) } catch { return [] }
  return names.filter(v => isFile(cortexdbBinPath(v)) && isFile(shaPath(v))).sort((a, b) => compareVersions(b, a))
}

export interface CortexdbBinary { path: string, version: string, source: 'env' | 'toolchain' }

export function cortexdbBinary(env: Readonly<Record<string, string | undefined>> = process.env): CortexdbBinary | undefined {
  const forced = env[CORTEXDB_BIN_ENV]
  if (forced !== undefined && forced !== '') return isFile(forced) ? { path: forced, version: 'custom', source: 'env' } : undefined
  const version = installedCortexdbVersions()[0]
  return version !== undefined ? { path: cortexdbBinPath(version), version, source: 'toolchain' } : undefined
}

export function cortexdbLaunch(bin: CortexdbBinary): string[] {
  return bin.source === 'env' && /\.(?:ts|js|mjs)$/i.test(bin.path) ? [process.execPath, bin.path] : [bin.path]
}

export type CortexdbCheck =
  | { status: 'ok', path: string, version: string, source: 'env' | 'toolchain' }
  | { status: 'missing' | 'damaged' | 'unsupported', detail: string }

export function checkCortexdb(env: Readonly<Record<string, string | undefined>> = process.env): CortexdbCheck {
  const bin = cortexdbBinary(env)
  if (bin?.source === 'env') return { status: 'ok', ...bin }
  if (cortexdbPlatform() === undefined) return { status: 'unsupported', detail: `CortexDB ships no binary for ${osName()}-${process.arch}` }
  if (bin === undefined) return { status: 'missing', detail: 'cortexdb-mcp is not in the toolchain (buracle install)' }
  let got: string
  let want: string
  try {
    got = sha256(readFileSync(bin.path))
    want = readFileSync(shaPath(bin.version), 'utf8').trim()
  } catch (e) {
    return { status: 'damaged', detail: `cannot read ${bin.path}: ${(e as Error).message}` }
  }
  if (got !== want) return { status: 'damaged', detail: `${bin.path} does not match the sha256 its release published (reinstall: buracle install)` }
  return { status: 'ok', ...bin }
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export type CortexdbRelease = { version: string, sha256: string } | { error: string }

// The newest release, read from where GitHub's `releases/latest/download/<asset>.sha256` redirects to (no API, no rate
// limit), and the hash that release published for this platform's binary.
export async function latestCortexdb(opts: { fetch?: FetchFn, timeoutMs?: number } = {}): Promise<CortexdbRelease> {
  const plat = cortexdbPlatform()
  if (plat === undefined) return { error: `CortexDB ships no binary for ${osName()}-${process.arch}` }
  const asset = CORTEXDB_ASSETS[plat] as string
  const doFetch: FetchFn = opts.fetch ?? fetch
  const init = (redirect: 'manual' | 'follow'): RequestInit => ({ signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000), headers: { 'user-agent': 'buracle-toolchain' }, redirect })
  const latestUrl = `${RELEASES_URL}/latest/download/${asset}.sha256`
  try {
    const hop = await doFetch(latestUrl, init('manual'))
    const location = hop.headers.get('location') ?? ''
    const version = /\/download\/v(\d+\.\d+\.\d+)\//.exec(location)?.[1]
    if (version === undefined) return { error: `${latestUrl} did not lead to a release (HTTP ${hop.status})` }
    const res = await doFetch(`${RELEASES_URL}/download/v${version}/${asset}.sha256`, init('follow'))
    if (!res.ok) return { error: `the sha256 of CortexDB ${version} could not be read: HTTP ${res.status}` }
    const hash = /\b[0-9a-f]{64}\b/i.exec(await res.text())?.[0]?.toLowerCase()
    if (hash === undefined) return { error: `CortexDB ${version} published no sha256 for ${asset}` }
    return { version, sha256: hash }
  } catch (e) {
    return { error: `the newest CortexDB release could not be read: ${(e as Error).message}` }
  }
}

export type CortexdbInstall =
  | { ok: true, path: string, version: string, changed: boolean, note?: string, newer?: string }
  | { ok: false, error: string }

export interface CortexdbInstallOptions {
  fetch?: FetchFn
  timeoutMs?: number
  // Runs the downloaded binary before it is used; a failure keeps the installed version.
  check?: (bin: string) => Promise<{ ok: true } | { ok: false, error: string }>
  // Runs once before the installed version is replaced (the memory backs the brains up there).
  beforeSwitch?: (from: string, to: string) => Promise<void>
}

export async function installCortexdb(opts: CortexdbInstallOptions = {}): Promise<CortexdbInstall> {
  const plat = cortexdbPlatform()
  if (plat === undefined) return { ok: false, error: `CortexDB ships no binary for ${osName()}-${process.arch}` }
  const asset = CORTEXDB_ASSETS[plat] as string
  const current = checkCortexdb({})
  const have = current.status === 'ok' ? current : undefined
  const keep = (note: string, newer?: string): CortexdbInstall => (have !== undefined ? { ok: true, path: have.path, version: have.version, changed: false, note, ...(newer !== undefined ? { newer } : {}) } : { ok: false, error: note })
  const latest = await latestCortexdb(opts)
  if ('error' in latest) return keep(latest.error)
  if (have?.version === latest.version) return { ok: true, path: have.path, version: have.version, changed: false }
  const url = `${RELEASES_URL}/download/v${latest.version}/${asset}`
  const doFetch: FetchFn = opts.fetch ?? fetch
  let bytes: Uint8Array
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS), headers: { 'user-agent': 'buracle-toolchain' }, redirect: 'follow' })
    if (!res.ok) return keep(`download of ${url} failed: HTTP ${res.status}`, latest.version)
    const len = Number(res.headers.get('content-length') ?? '0')
    if (len > MAX_BYTES) return keep(`${url} is ${len} bytes, more than a CortexDB binary`, latest.version)
    bytes = new Uint8Array(await res.arrayBuffer())
  } catch (e) {
    return keep(`download of ${url} failed: ${(e as Error).message}`, latest.version)
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return keep(`${url} returned ${bytes.byteLength} bytes`, latest.version)
  const got = sha256(bytes)
  if (got !== latest.sha256) return keep(`${asset} ${latest.version}: sha256 ${got} does not match the ${latest.sha256} its release published`, latest.version)
  const target = cortexdbBinPath(latest.version)
  const staging = `${target}.staging-${process.pid}`
  try {
    mkdirSync(join(cortexdbDir(), latest.version), { recursive: true })
    writeFileSync(staging, bytes, { mode: 0o755 })
    if (osName() !== 'win32') chmodSync(staging, 0o755)
  } catch (e) {
    try { rmSync(staging, { force: true }) } catch {  }
    return keep(`cannot write ${target}: ${(e as Error).message}`, latest.version)
  }
  const checked = opts.check !== undefined ? await opts.check(staging) : { ok: true as const }
  if (!checked.ok) {
    try { rmSync(join(cortexdbDir(), latest.version), { recursive: true, force: true }) } catch {  }
    return keep(`CortexDB ${latest.version} failed Buracle's check (${checked.error})${have !== undefined ? `; ${have.version} stays` : ''}`, latest.version)
  }
  if (have !== undefined && opts.beforeSwitch !== undefined) await opts.beforeSwitch(have.version, latest.version)
  try {
    writeFileSync(shaPath(latest.version), `${latest.sha256}\n`)
    renameRetrySync(staging, target)
  } catch (e) {
    try { rmSync(staging, { force: true }) } catch {  }
    try { rmSync(shaPath(latest.version), { force: true }) } catch {  }
    return keep(`cannot write ${target}: ${(e as Error).message}`, latest.version)
  }
  pruneOldVersions()
  return { ok: true, path: target, version: latest.version, changed: true }
}

// Keeps the newest installed version and the one before it (a session started earlier may still run it); a
// version folder without a complete install goes.
function pruneOldVersions(): void {
  const kept = new Set(installedCortexdbVersions().slice(0, 2))
  let names: string[]
  try { names = readdirSync(cortexdbDir()).filter(n => VERSION_RE.test(n)) } catch { return }
  for (const n of names) {
    if (kept.has(n)) continue
    try { rmSync(join(cortexdbDir(), n), { recursive: true, force: true }) } catch {  }
  }
}

export function cortexdbStagingLeft(): boolean {
  if (!existsSync(cortexdbDir())) return false
  let names: string[]
  try { names = readdirSync(cortexdbDir()).filter(n => VERSION_RE.test(n)) } catch { return false }
  return names.some(v => { try { return readdirSync(join(cortexdbDir(), v)).some(n => n.includes('.staging-')) } catch { return false } })
}
