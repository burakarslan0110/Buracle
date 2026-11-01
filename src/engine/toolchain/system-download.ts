import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { renameRetrySync, sha256 } from '../fsx'
import * as paths from '../paths'
import { findExecutable, spawnArgv } from '../platform'
import { opsDeps } from '../update/deps'
import { SYSTEM_TOOL_PINS, type PinnedAsset, type PinnedTool, type PinnedToolName, type PinPlatform } from './system-pins'

// Downloads node, uv, rg or jq at the version src/engine/toolchain/system-pins.ts fixes, when the tool is missing and no
// package manager can install it. The download must match the pinned sha256 before anything is unpacked; the program
// must then run its version check before it replaces anything. Nothing here runs sudo or writes outside the folder.

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>
type RunFn = (argv: string[]) => Promise<{ code: number, stdout: string, stderr: string }>

const DOWNLOAD_TIMEOUT_MS = 300_000
const MAX_BYTES = 200 * 1024 * 1024
const PLATFORM_KEYS: ReadonlySet<string> = new Set<PinPlatform>(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'])

export function isPinnedTool(name: string): name is PinnedToolName {
  return Object.prototype.hasOwnProperty.call(SYSTEM_TOOL_PINS, name)
}

/** The pin table's key for this machine, or undefined where no tool is pinned. */
export function pinPlatform(os: string = process.platform, arch: string = process.arch): PinPlatform | undefined {
  const key = `${os}-${arch}`
  return PLATFORM_KEYS.has(key) ? key as PinPlatform : undefined
}

export function pinnedAsset(name: string, os: string = process.platform, arch: string = process.arch, pins: Readonly<Record<PinnedToolName, PinnedTool>> = SYSTEM_TOOL_PINS): { version: string, asset: PinnedAsset } | undefined {
  if (!isPinnedTool(name)) return undefined
  const plat = pinPlatform(os, arch)
  const tool = pins[name]
  const asset = plat !== undefined ? tool.assets[plat] : undefined
  return asset !== undefined ? { version: tool.version, asset } : undefined
}

export interface PinnedInstallOptions {
  /** The ToolSpec's version check: argv[0] names the program in the asset's bins. */
  check: { argv: readonly string[], regex: string }
  /** The folder that holds one folder per tool (default `toolchain/system`). */
  root?: string
  os?: string
  arch?: string
  fetch?: FetchFn
  run?: RunFn
  pins?: Readonly<Record<PinnedToolName, PinnedTool>>
  timeoutMs?: number
  maxBytes?: number
}

export type PinnedInstall =
  | { ok: true, version: string, dir: string, bins: Record<string, string>, check: string }
  | { ok: false, error: string }

const defaultRun: RunFn = async argv => {
  const r = await opsDeps.run(spawnArgv(argv), { timeoutMs: 60_000 })
  return { code: r.code, stdout: r.stdout, stderr: r.stderr }
}

/** The body, or undefined once it passes `max` bytes: the rest is not read, so an answer without content-length cannot fill memory. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | undefined> {
  if (res.body === null) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.byteLength }
  return out
}

function climbsOut(entry: string): boolean {
  const e = entry.replace(/\\/g, '/')
  return e.startsWith('/') || /^[A-Za-z]:/.test(e) || e.split('/').includes('..')
}

function inside(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Every symbolic link in the unpacked tree must point inside it. */
function linkOutside(root: string): string | undefined {
  const walk = (dir: string): string | undefined => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isSymbolicLink()) {
        const target = resolve(dirname(p), readlinkSync(p))
        if (!inside(root, target)) return relative(root, p)
      } else if (e.isDirectory()) {
        const hit = walk(p)
        if (hit !== undefined) return hit
      }
    }
    return undefined
  }
  return walk(root)
}

/** The folder the tool lives in once unpacked: an archive's one top folder is stripped. */
function contentRoot(dir: string): string {
  const entries = readdirSync(dir, { withFileTypes: true })
  const only = entries[0]
  return entries.length === 1 && only !== undefined && only.isDirectory() ? join(dir, only.name) : dir
}

async function unpack(name: string, asset: PinnedAsset, bytes: Uint8Array, into: string, run: RunFn): Promise<string | undefined> {
  if (asset.format === 'bin') {
    const bin = Object.values(asset.bins)[0]
    if (bin === undefined) return `${name}: the pin names no program`
    writeFileSync(join(into, bin), bytes, { mode: 0o755 })
    return undefined
  }
  if (asset.format === 'tar.gz') {
    const archive = new Bun.Archive(bytes)
    const names = [...(await archive.files()).keys()]
    const bad = names.find(climbsOut)
    if (bad !== undefined) return `${name}: the archive has an entry outside its folder (${bad})`
    await archive.extract(into)
    return undefined
  }
  // A .zip (the Windows builds): Windows' own tar (bsdtar, in System32 since Windows 10 1803) lists and unpacks it. Git for
  // Windows puts a GNU tar on PATH that cannot read a zip, so System32 comes first.
  const system32 = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')
  const tar = process.platform === 'win32' && existsSync(system32) ? system32 : findExecutable('tar')
  if (tar === undefined) return `${name}: tar was not found to unpack ${asset.url}`
  const file = join(dirname(into), `${name}.zip`)
  writeFileSync(file, bytes)
  try {
    const listed = await run([tar, '-tf', file])
    if (listed.code !== 0) return `${name}: tar could not read the archive (${listed.stderr.trim() || `exit ${listed.code}`})`
    const bad = listed.stdout.split(/\r?\n/).filter(l => l !== '').find(climbsOut)
    if (bad !== undefined) return `${name}: the archive has an entry outside its folder (${bad})`
    const out = await run([tar, '-xf', file, '-C', into])
    if (out.code !== 0) return `${name}: tar could not unpack the archive (${out.stderr.trim() || `exit ${out.code}`})`
    return undefined
  } finally {
    rmSync(file, { force: true })
  }
}

/**
 * Downloads, verifies and unpacks one pinned tool into `<root>/<name>`, after its program passed the version check.
 * The previous copy is replaced only then; on any failure it stays and nothing new is left behind.
 */
export async function installPinnedTool(name: PinnedToolName, opts: PinnedInstallOptions): Promise<PinnedInstall> {
  const os = opts.os ?? process.platform
  const arch = opts.arch ?? process.arch
  const pinned = pinnedAsset(name, os, arch, opts.pins)
  if (pinned === undefined) return { ok: false, error: `no download for ${os}-${arch}` }
  const { asset, version } = pinned
  const root = opts.root ?? paths.systemToolsDir()
  const max = opts.maxBytes ?? MAX_BYTES
  const doFetch: FetchFn = opts.fetch ?? fetch
  const run = opts.run ?? defaultRun

  let bytes: Uint8Array
  try {
    const res = await doFetch(asset.url, { signal: AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS), headers: { 'user-agent': 'buracle-toolchain' }, redirect: 'follow' })
    if (!res.ok) return { ok: false, error: `download of ${asset.url} failed: HTTP ${res.status}` }
    const len = Number(res.headers.get('content-length') ?? '0')
    if (len > max) return { ok: false, error: `${asset.url} is ${len} bytes, more than the ${max} bytes a download may have` }
    const body = await readCapped(res, max)
    if (body === undefined) return { ok: false, error: `${asset.url} is more than the ${max} bytes a download may have` }
    bytes = body
  } catch (e) {
    return { ok: false, error: `download of ${asset.url} failed: ${(e as Error).message}` }
  }
  if (bytes.byteLength === 0) return { ok: false, error: `${asset.url} returned 0 bytes` }
  const got = sha256(bytes)
  // The cause first: a terminal cuts the Tools line to its width; the log keeps both hashes.
  if (got !== asset.sha256) return { ok: false, error: `${name} ${version}: sha256 mismatch: got ${got}, pinned ${asset.sha256}` }

  const staging = join(root, `.staging-${name}-${process.pid}`)
  const target = join(root, name)
  const cleanup = (): void => { try { rmSync(staging, { recursive: true, force: true }) } catch {  } }
  try {
    cleanup()
    mkdirSync(join(staging, 'x'), { recursive: true })
    const why = await unpack(name, asset, bytes, join(staging, 'x'), run)
    if (why !== undefined) { cleanup(); return { ok: false, error: why } }
    const content = contentRoot(join(staging, 'x'))
    const escaped = linkOutside(content)
    if (escaped !== undefined) { cleanup(); return { ok: false, error: `${name}: the archive links outside its folder (${escaped})` } }
    for (const [bin, rel] of Object.entries(asset.bins)) {
      const p = join(content, rel)
      try { lstatSync(p) } catch { cleanup(); return { ok: false, error: `${name}: the download has no ${rel} (${bin})` } }
      if (os !== 'win32' && !lstatSync(p).isSymbolicLink()) chmodSync(p, 0o755)
    }
    // The program runs from the staging folder first: a build that cannot run here (wrong libc, for one) is never kept.
    const [prog, ...args] = opts.check.argv
    const rel = prog !== undefined ? asset.bins[prog] : undefined
    if (rel === undefined) { cleanup(); return { ok: false, error: `${name}: the pin has no program for \`${opts.check.argv.join(' ')}\`` } }
    const r = await run([join(content, rel), ...args])
    let seen: string | undefined
    try { seen = new RegExp(opts.check.regex, 'm').exec(`${r.stdout}\n${r.stderr}`)?.[1] } catch { seen = undefined }
    if (r.code !== 0 || seen === undefined) {
      cleanup()
      const out = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/)[0] ?? ''
      return { ok: false, error: `${name} ${version} did not run here: \`${opts.check.argv.join(' ')}\` exited ${r.code}${out !== '' ? ` (${out})` : ''}` }
    }
    const old = `${target}.old-${process.pid}`
    if (existsSync(target)) renameRetrySync(target, old)
    try {
      renameRetrySync(content, target)
    } catch (e) {
      if (existsSync(old)) renameRetrySync(old, target)
      throw e
    }
    try { rmSync(old, { recursive: true, force: true }) } catch {  }
    cleanup()
    const bins = Object.fromEntries(Object.entries(asset.bins).map(([b, p]) => [b, join(target, p)]))
    return { ok: true, version, dir: target, bins, check: seen }
  } catch (e) {
    cleanup()
    return { ok: false, error: `${name}: cannot write ${target}: ${(e as Error).message}` }
  }
}
