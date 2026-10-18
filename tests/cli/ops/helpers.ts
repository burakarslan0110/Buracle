import { chmodSync, copyFileSync, cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CommandIO } from '../../../src/cli/router'
import type { Adapter, AdapterContext } from '../../../src/adapters/registry'
import type { Harness } from '../../../src/core/events'
import type { Plan } from '../../../src/engine/txn'
import { opsDeps, type CliResult, type OpsDeps } from '../../../src/engine/update/deps'
import type { FetchOptions, FetchResult, Fetcher } from '../../../src/engine/update/fetch'
import { run as procRun } from '../../../src/engine/proc'

export const REAL_REPO = join(import.meta.dir, '..', '..', '..')

export type TestIO = CommandIO & { out(): string, err(): string }

// liveErr: stderr is a terminal, so install and update draw their live steps there.
export function memoryIO(opts: { tty?: boolean, json?: boolean, verbose?: boolean, liveErr?: boolean } = {}): TestIO {
  let out = ''
  let err = ''
  return {
    stdout: { write: (s: string) => { out += s } },
    stderr: { write: (s: string) => { err += s }, ...(opts.liveErr === true ? { isTTY: true, columns: 160 } : {}) },
    stdin: { isTTY: opts.tty === true, text: async () => '' },
    flags: { json: opts.json === true, verbose: opts.verbose === true },
    out: () => out,
    err: () => err,
  }
}

export async function withDeps<T>(over: Partial<OpsDeps>, fn: () => T | Promise<T>): Promise<T> {
  const saved: OpsDeps = { ...opsDeps }
  Object.assign(opsDeps, over)
  try {
    return await fn()
  } finally {
    Object.assign(opsDeps, saved)
  }
}

export interface FakeAdapterOptions {
  installed?: boolean
  version?: string | (() => string)
  path?: string
  build?: (ctx: AdapterContext) => Array<{ path: string, content: string, mode?: number }> | Promise<Array<{ path: string, content: string, mode?: number }>>
  plan?: (ctx: AdapterContext) => Plan | Promise<Plan>
  doctor?: (ctx: AdapterContext) => Array<{ level: 'ok' | 'warn' | 'error', check: string, detail: string }> | Promise<Array<{ level: 'ok' | 'warn' | 'error', check: string, detail: string }>>
  uninstall?: (ctx: AdapterContext) => Plan | Promise<Plan>
}

export function fakeAdapter(h: Harness, o: FakeAdapterOptions = {}): Adapter & { calls: string[] } {
  const calls: string[] = []
  const a: Adapter & { calls: string[] } = {
    harness: h,
    calls,
    async detect() {
      calls.push('detect')
      if (o.installed === false) return { installed: false }
      return { installed: true, version: typeof o.version === 'function' ? o.version() : o.version ?? '1.0.0', path: o.path ?? `/fake/bin/${h}` }
    },
    async build(ctx) {
      calls.push('build')
      return o.build ? o.build(ctx) : []
    },
    async installPlan(ctx) {
      calls.push('installPlan')
      return o.plan ? o.plan(ctx) : { id: h, harness: h, ops: [] }
    },
    async doctor(ctx) {
      calls.push('doctor')
      return o.doctor ? o.doctor(ctx) : []
    },
  }
  const uninstall = o.uninstall
  if (uninstall) {
    a.uninstallPlan = async (ctx) => {
      calls.push('uninstallPlan')
      return uninstall(ctx)
    }
  }
  return a
}

export function makeRepo(root: string, extra: Record<string, string> = {}): string {
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'canonical'), { recursive: true })
  for (const f of ['buracle.yaml', 'mcp.yaml', 'plugins.yaml', 'tools.yaml']) copyFileSync(join(REAL_REPO, 'canonical', f), join(repo, 'canonical', f))
  writeFileSync(join(repo, 'package.json'), '{"name":"buracle-test","version":"0.0.0"}\n')
  for (const [rel, text] of Object.entries(extra)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    writeFileSync(join(repo, rel), text)
  }
  return repo
}

// A full copy of this checkout (sources, canonical/, the generated harness/), sharing node_modules:
// commands that build or install into a checkout never write into the real one.
export function fullCheckout(root: string): string {
  const repo = join(root, 'check out')
  mkdirSync(repo, { recursive: true })
  for (const d of ['src', 'canonical', 'harness']) cpSync(join(REAL_REPO, d), join(repo, d), { recursive: true })
  for (const f of ['package.json', 'bun.lock', 'tsconfig.json']) cpSync(join(REAL_REPO, f), join(repo, f))
  symlinkSync(join(REAL_REPO, 'node_modules'), join(repo, 'node_modules'))
  return repo
}

export function writeExe(path: string, script: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh\n${script}\n`)
  chmodSync(path, 0o755)
  return path
}

export type Route = unknown | ((url: string, opts?: FetchOptions) => FetchResult | Promise<FetchResult>)

export function fakeFetch(routes: Record<string, Route>): Fetcher & { calls: string[] } {
  const calls: string[] = []
  const f = (async (url: string, opts?: FetchOptions): Promise<FetchResult> => {
    calls.push(url)
    if (!(url in routes)) throw new Error(`unexpected fetch ${url}`)
    const r = routes[url]
    if (typeof r === 'function') return (r as (u: string, o?: FetchOptions) => FetchResult | Promise<FetchResult>)(url, opts)
    return { ok: true, status: 200, json: r }
  }) as Fetcher & { calls: string[] }
  f.calls = calls
  return f
}

export const noNetwork: Fetcher = async (url: string) => { throw new Error(`network access during the test: ${url}`) }

export function fakeCli(answer: (argv: string[]) => CliResult = () => ({ code: 0, stdout: '', stderr: '' })): { runCli: (argv: string[]) => Promise<CliResult>, calls: string[][] } {
  const calls: string[][] = []
  return { calls, runCli: async (argv: string[]) => { calls.push(argv); return answer(argv) } }
}

export function daysAgo(nowMs: number, days: number): string {
  return new Date(nowMs - days * 86_400_000).toISOString()
}

export const FAKE_MCP_MAIN = `
const version = process.argv[3] ?? '0'
const decoder = new TextDecoder()
let buf = ''
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true })
  let nl
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'alpha', version } } })
    else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'lookup' }, { name: 'resolve' }] } })
  }
}
`

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await procRun(['git', ...args], {
    cwd,
    timeoutMs: 30_000,
    env: { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test', GIT_CONFIG_NOSYSTEM: '1' },
  })
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

export async function behindRemote(root: string, dir: string, name: string): Promise<{ bare: string }> {
  const bare = join(root, `${name}.git`)
  await git(root, 'init', '--bare', '-q', '-b', 'main', bare)
  await git(dir, 'init', '-q', '-b', 'main')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', 'init')
  await git(dir, 'remote', 'add', 'origin', bare)
  await git(dir, 'push', '-q', '-u', 'origin', 'main')
  const other = join(root, `${name}-other`)
  await git(root, 'clone', '-q', bare, other)
  writeFileSync(join(other, 'NEW.md'), 'new\n')
  await git(other, 'add', '-A')
  await git(other, 'commit', '-q', '-m', 'upstream change')
  await git(other, 'push', '-q')
  return { bare }
}
