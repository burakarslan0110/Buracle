import { spawn as nodeSpawn, spawnSync as nodeSpawnSync, type StdioOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, statSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { Readable } from 'node:stream'

// Pi runs its extensions on Node.js (its managed install starts `node`), while the code Buracle Stack bundles into the
// extension calls the few Bun APIs below. This file stands in for them when no `Bun` exists, so the same engine code
// runs on both. It is the first import of the extension, and it does nothing under Bun.

type Stdio = 'pipe' | 'inherit' | 'ignore' | Uint8Array | null | undefined
interface SpawnOptions { cwd?: string, env?: Record<string, string | undefined>, detached?: boolean, stdin?: Stdio, stdout?: Stdio, stderr?: Stdio, stdio?: Stdio[], timeout?: number, killSignal?: NodeJS.Signals, maxBuffer?: number }

function isExecutable(file: string): boolean {
  try { return statSync(file).isFile() && (accessSync(file, constants.X_OK), true) } catch { return false }
}

function which(name: string, opts?: { PATH?: string }): string | null {
  if (name.includes('/')) return isExecutable(name) ? name : null
  for (const dir of (opts?.PATH ?? process.env['PATH'] ?? '').split(delimiter)) {
    if (dir !== '' && isExecutable(join(dir, name))) return join(dir, name)
  }
  return null
}

const mode = (s: Stdio): 'pipe' | 'inherit' | 'ignore' => (s === 'pipe' || s === 'inherit' ? s : s instanceof Uint8Array ? 'pipe' : 'ignore')

function spawn(argv: string[], o: SpawnOptions = {}): Record<string, unknown> {
  const [inn, out, err] = o.stdio ?? [o.stdin, o.stdout, o.stderr]
  const child = nodeSpawn(argv[0] as string, argv.slice(1), { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, detached: o.detached === true, stdio: [mode(inn), mode(out), mode(err)] as StdioOptions })
  const exited = new Promise<number>(res => {
    child.on('error', () => res(127))
    child.on('close', code => res(code ?? 1))
  })
  if (inn instanceof Uint8Array) child.stdin?.end(Buffer.from(inn))
  const web = (s: Readable | null) => (s === null ? undefined : Readable.toWeb(s))
  return {
    get pid() { return child.pid },
    get exitCode() { return child.exitCode },
    exited,
    stdout: web(child.stdout), stderr: web(child.stderr),
    stdin: child.stdin === null ? undefined : { write: (d: string | Uint8Array) => child.stdin?.write(d), end: () => child.stdin?.end(), flush: () => undefined },
    kill: (sig?: NodeJS.Signals | number) => child.kill(sig),
    unref: () => { child.unref() },
  }
}

function spawnSync(argv: string[], o: SpawnOptions = {}): Record<string, unknown> {
  const r = nodeSpawnSync(argv[0] as string, argv.slice(1), {
    cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: [mode(o.stdin), mode(o.stdout), mode(o.stderr)] as StdioOptions,
    ...(o.timeout !== undefined ? { timeout: o.timeout } : {}), ...(o.killSignal !== undefined ? { killSignal: o.killSignal } : {}), ...(o.maxBuffer !== undefined ? { maxBuffer: o.maxBuffer } : {}),
  })
  return { exitCode: r.status ?? 1, success: r.status === 0, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? Buffer.alloc(0), signalCode: r.signal }
}

class CryptoHasher {
  private readonly h
  constructor(algorithm: string) { this.h = createHash(algorithm) }
  update(data: string | Uint8Array): this { this.h.update(data); return this }
  digest(encoding: 'hex' | 'base64'): string { return this.h.digest(encoding) }
}

const shim = {
  which,
  spawn,
  spawnSync,
  sleepSync: (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) },
  write: async (path: string, data: string | Uint8Array): Promise<number> => { writeFileSync(path, data); return typeof data === 'string' ? Buffer.byteLength(data) : data.length },
  CryptoHasher,
  // No TOML reader on Node: the callers treat a file they cannot read as unreadable.
  TOML: { parse: (): never => { throw new Error('TOML is not available in this runtime') } },
}

const host = globalThis as { Bun?: unknown }
if (host.Bun === undefined) host.Bun = shim
