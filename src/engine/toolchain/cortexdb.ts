import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256 } from '../fsx'
import * as paths from '../paths'
import { exeName, osName } from '../platform'

export const CORTEXDB_VERSION = '2.124.0'

export const CORTEXDB_ASSETS: Readonly<Record<string, { asset: string, sha256: string }>> = {
  'darwin-arm64': { asset: 'cortexdb-mcp-darwin-arm64', sha256: '129c67475a8b064c44cef2beb6f3a95b14c9f248ce16ea575f2a8b811f344308' },
  'darwin-x64': { asset: 'cortexdb-mcp-darwin-amd64', sha256: '6f6951550ac962753c503561657c80c1542b82c670cdd6e0754988a2a9d74896' },
  'linux-x64': { asset: 'cortexdb-mcp-linux-amd64', sha256: '42f2f73550c532cf2c82820a92a0f85c7f5e2e7e2971efb8425a493b55924227' },
  'linux-arm64': { asset: 'cortexdb-mcp-linux-arm64', sha256: '7588dfec265aadebec5d3bc5ddc0e897f20ac59b5dff97f8baaa14eb2ae96fba' },
  'win32-x64': { asset: 'cortexdb-mcp-windows-amd64.exe', sha256: 'fe478fcbb68b5a48d800317641e817604a75fba18733450c099e78babb91304d' },
  'win32-arm64': { asset: 'cortexdb-mcp-windows-arm64.exe', sha256: '62898504d7fa0b59a5aed1ab25491afc7f8fc780760c9e8c5ee65c621e139b23' },
}

export const CORTEXDB_BIN_ENV = 'BURACLE_CORTEXDB_BIN'
const RELEASE_URL = 'https://github.com/liliang-cn/cortexdb/releases/download'
const DOWNLOAD_TIMEOUT_MS = 180_000
const MAX_BYTES = 120 * 1024 * 1024

export function cortexdbPlatform(arch: string = process.arch): string | undefined {
  const key = `${osName()}-${arch}`
  return CORTEXDB_ASSETS[key] !== undefined ? key : undefined
}

export function cortexdbDir(): string { return join(paths.toolchainDir(), 'cortexdb') }

export function cortexdbBinPath(version: string = CORTEXDB_VERSION): string {
  return join(cortexdbDir(), version, exeName('cortexdb-mcp'))
}

export interface CortexdbBinary { path: string, version: string, source: 'env' | 'toolchain' }

function isFile(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}

export function cortexdbBinary(env: Readonly<Record<string, string | undefined>> = process.env): CortexdbBinary | undefined {
  const forced = env[CORTEXDB_BIN_ENV]
  if (forced !== undefined && forced !== '') return isFile(forced) ? { path: forced, version: 'custom', source: 'env' } : undefined
  const p = cortexdbBinPath()
  return isFile(p) ? { path: p, version: CORTEXDB_VERSION, source: 'toolchain' } : undefined
}

export type CortexdbCheck =
  | { status: 'ok', path: string, version: string, source: 'env' | 'toolchain' }
  | { status: 'missing' | 'damaged' | 'unsupported', detail: string }

export function checkCortexdb(env: Readonly<Record<string, string | undefined>> = process.env): CortexdbCheck {
  const bin = cortexdbBinary(env)
  if (bin?.source === 'env') return { status: 'ok', ...bin }
  const plat = cortexdbPlatform()
  if (plat === undefined) return { status: 'unsupported', detail: `CortexDB ships no binary for ${osName()}-${process.arch}` }
  if (bin === undefined) return { status: 'missing', detail: `cortexdb-mcp ${CORTEXDB_VERSION} is not in the toolchain (buracle install)` }
  const want = CORTEXDB_ASSETS[plat]?.sha256
  let got: string
  try { got = sha256(readFileSync(bin.path)) } catch (e) { return { status: 'damaged', detail: `cannot read ${bin.path}: ${(e as Error).message}` } }
  if (got !== want) return { status: 'damaged', detail: `${bin.path} does not match the pinned sha256 (reinstall: buracle install)` }
  return { status: 'ok', ...bin }
}

export type CortexdbInstall = { ok: true, path: string, version: string, changed: boolean } | { ok: false, error: string }

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export async function installCortexdb(opts: { fetch?: FetchFn, timeoutMs?: number } = {}): Promise<CortexdbInstall> {
  const plat = cortexdbPlatform()
  if (plat === undefined) return { ok: false, error: `CortexDB ships no binary for ${osName()}-${process.arch}` }
  const spec = CORTEXDB_ASSETS[plat] as { asset: string, sha256: string }
  const target = cortexdbBinPath()
  try {
    if (isFile(target) && sha256(readFileSync(target)) === spec.sha256) return { ok: true, path: target, version: CORTEXDB_VERSION, changed: false }
  } catch {  }
  const url = `${RELEASE_URL}/v${CORTEXDB_VERSION}/${spec.asset}`
  const doFetch: FetchFn = opts.fetch ?? fetch
  let bytes: Uint8Array
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS), headers: { 'user-agent': 'buracle-toolchain' }, redirect: 'follow' })
    if (!res.ok) return { ok: false, error: `download of ${url} failed: HTTP ${res.status}` }
    const len = Number(res.headers.get('content-length') ?? '0')
    if (len > MAX_BYTES) return { ok: false, error: `${url} is ${len} bytes, more than a CortexDB binary` }
    bytes = new Uint8Array(await res.arrayBuffer())
  } catch (e) {
    return { ok: false, error: `download of ${url} failed: ${(e as Error).message}` }
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return { ok: false, error: `${url} returned ${bytes.byteLength} bytes` }
  const got = sha256(bytes)
  if (got !== spec.sha256) return { ok: false, error: `${spec.asset} ${CORTEXDB_VERSION}: sha256 ${got} does not match the pinned ${spec.sha256}` }
  const dir = join(cortexdbDir(), CORTEXDB_VERSION)
  const staging = `${target}.staging-${process.pid}`
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(staging, bytes, { mode: 0o755 })
    if (osName() !== 'win32') chmodSync(staging, 0o755)
    renameSync(staging, target)
  } catch (e) {
    try { rmSync(staging, { force: true }) } catch {  }
    return { ok: false, error: `cannot write ${target}: ${(e as Error).message}` }
  }
  pruneOldVersions()
  return { ok: true, path: target, version: CORTEXDB_VERSION, changed: true }
}

function pruneOldVersions(): void {
  let names: string[]
  try { names = readdirSync(cortexdbDir()).filter(n => n !== CORTEXDB_VERSION && /^\d+\.\d+\.\d+$/.test(n)) } catch { return }
  const num = (v: string) => v.split('.').map(Number)
  names.sort((a, b) => { const x = num(a); const y = num(b); return (y[0]! - x[0]!) || (y[1]! - x[1]!) || (y[2]! - x[2]!) })
  for (const n of names.slice(1)) {
    try { rmSync(join(cortexdbDir(), n), { recursive: true, force: true }) } catch {  }
  }
}

export function cortexdbStagingLeft(): boolean {
  const dir = join(cortexdbDir(), CORTEXDB_VERSION)
  if (!existsSync(dir)) return false
  try { return readdirSync(dir).some(n => n.includes('.staging-')) } catch { return false }
}
