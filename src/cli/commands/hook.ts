import type { CommandIO } from '../router'
import type { Harness } from '../../core/events'
import { HARNESSES, isHarness } from '../../core/events'
import type { CanonicalBundle } from '../../core/catalog'
import type { Adapter, AdapterContext } from '../../adapters/registry'
import { loadConfigSync } from '../../engine/config'
import { log } from '../../engine/log'
import * as paths from '../../engine/paths'
import { hookBundle } from '../hook-data'
import { failClosedOutcome, shortError } from '../../engine/hook-fail'

export const name = 'hook'
export const summary = 'Command-hook entry point for harnesses: payload on stdin, response on stdout'
export const usage = `Usage: buracle hook <harness> <event>

Reads the harness hook payload (JSON) from stdin, runs the adapter's handler for
<event> and writes its response to stdout with the handler's exit code.
Internal errors are logged to ~/.buracle/logs/buracle.log. They fail open (exit 0,
empty output), except for the guard events, Claude Code's and Codex's PreToolUse:
there an adapter that cannot load or a handler that fails before its decision
denies the call, with a reason that names the error and the fix (\`buracle doctor\`).
Hooks run the frozen runtime the shim names (\`buracle install\` refreshes it), not the
checkout.

  <harness>  ${HARNESSES.join(' | ')}
  <event>    the harness event name, e.g. PreToolUse, PostToolUse, Stop

Environment:
  BURACLE_HOOK_TIMEOUT_MS  give up when the handler takes longer than this (a guard
                           event then denies the call, every other event fails open)`

export type HookOutcome = { stdout: string, exitCode: number }

export interface HookDeps {
  loadAdapter(h: Harness): Adapter | Promise<Adapter>
  loadContext(): AdapterContext
  timeoutMs?: number
}

const ADAPTER_LOADERS: Readonly<Record<Harness, () => Promise<{ adapter: Adapter }>>> = {
  claude: () => import('../../adapters/claude/index'),
  codex: () => import('../../adapters/codex/index'),
  opencode: () => import('../../adapters/opencode/index'),
  omp: () => import('../../adapters/omp/index'),
}

export async function loadAdapter(h: Harness): Promise<Adapter> {
  return (await ADAPTER_LOADERS[h]()).adapter
}

export function createContext(): AdapterContext {
  const repoRoot = paths.repoRoot()
  const loaded = loadConfigSync({ repoRoot })
  if (loaded.errors.length > 0) log('warn', 'hook: configuration problems (the defaults are used for these values)', { errors: loaded.errors })
  let canonical: CanonicalBundle | undefined
  return {
    repoRoot,
    config: loaded.config,
    paths,
    buracleBin: paths.shimPath(),
    get canonical(): CanonicalBundle {
      canonical ??= hookBundle(repoRoot)
      return canonical
    },
  }
}

function hookResultOf(e: unknown): HookOutcome | undefined {
  if (e === null || typeof e !== 'object' || !('hookResult' in e)) return undefined
  const r = (e as { hookResult: unknown }).hookResult
  if (r === null || typeof r !== 'object') return undefined
  const { stdout, exitCode } = r as { stdout?: unknown, exitCode?: unknown }
  if (typeof stdout !== 'string' || typeof exitCode !== 'number' || !Number.isInteger(exitCode)) return undefined
  return { stdout, exitCode }
}

function isOutcome(x: unknown): x is HookOutcome {
  return x !== null && typeof x === 'object'
    && typeof (x as HookOutcome).stdout === 'string'
    && typeof (x as HookOutcome).exitCode === 'number' && Number.isInteger((x as HookOutcome).exitCode)
}

function withTimeout<T>(p: Promise<T>, ms: number | undefined): Promise<T> {
  if (ms === undefined || !(ms > 0)) return p
  let timer: ReturnType<typeof setTimeout> | undefined
  const t = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`hook handler timed out after ${ms} ms`)), ms) })
  return Promise.race([p, t]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
}

const STDOUT_CONSOLE = ['log', 'info', 'debug', 'dir', 'dirxml', 'table'] as const

export function divertStdout(): () => void {
  const c = console as unknown as Record<string, unknown>
  const saved = STDOUT_CONSOLE.map(k => [k, c[k]] as const)
  const out = process.stdout as unknown as { write: unknown }
  const savedWrite = out.write
  const divert = (...args: unknown[]) => {
    const text = args.map(a => (typeof a === 'string' ? a : a instanceof Uint8Array ? new TextDecoder().decode(a) : Bun.inspect(a))).join(' ')
    log('warn', 'hook output to stdout was diverted to the log', { text: text.slice(0, 4000) })
  }
  for (const k of STDOUT_CONSOLE) c[k] = divert
  out.write = (chunk: unknown, ...rest: unknown[]) => {
    divert(chunk)
    const cb = rest.find((r): r is () => void => typeof r === 'function')
    if (cb) queueMicrotask(cb)
    return true
  }
  let restored = false
  return () => {
    if (restored) return
    restored = true
    for (const [k, f] of saved) c[k] = f
    out.write = savedWrite
  }
}

export async function dispatchHook(harness: Harness, event: string, stdin: string, deps: HookDeps): Promise<HookOutcome> {
  const restore = divertStdout()
  let handler: Promise<unknown> | undefined
  try {
    const adapter = await deps.loadAdapter(harness)
    if (typeof adapter.hook !== 'function') {
      if (failClosedOutcome(harness, event, '') === undefined) return { stdout: '', exitCode: 0 }
      throw new Error(`the ${harness} adapter has no hook handler`)
    }
    const ctx = deps.loadContext()
    handler = Promise.resolve(adapter.hook(event, stdin, ctx))
    const res: unknown = await withTimeout(handler, deps.timeoutMs)
    if (!isOutcome(res)) throw new Error('adapter returned an invalid hook result')
    return res
  } catch (e) {
    const custom = hookResultOf(e)
    const closed = custom === undefined ? failClosedOutcome(harness, event, shortError(e)) : undefined
    log('error', 'hook handler failed', { harness, event, error: e, result: custom ? 'adapter-provided' : closed ? 'fail-closed' : 'fail-open' })
    return custom ?? closed ?? { stdout: '', exitCode: 0 }
  } finally {
    if (handler === undefined) restore()
    else handler.then(restore, restore)
  }
}

function envTimeout(): number | undefined {
  const raw = process.env['BURACLE_HOOK_TIMEOUT_MS']
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined
  const n = parseInt(raw, 10)
  return n > 0 ? n : undefined
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const args = argv.filter(a => a !== '--' && a !== '--json' && a !== '--verbose' && a !== '-v')
  const [harness, event, ...extra] = args
  if (harness === undefined || event === undefined || event === '' || extra.length > 0) {
    io.stderr.write(usage + '\n')
    return 1
  }
  if (!isHarness(harness)) {
    io.stderr.write(`buracle hook: unknown harness '${harness}' (expected ${HARNESSES.join(', ')})\n`)
    return 1
  }
  let stdin = ''
  try {
    stdin = await io.stdin.text()
  } catch (e) {
    log('warn', 'hook: could not read stdin', { harness, event, error: e })
  }
  const timeoutMs = envTimeout()
  const deps: HookDeps = timeoutMs === undefined ? { loadAdapter, loadContext: createContext } : { loadAdapter, loadContext: createContext, timeoutMs }
  const res = await dispatchHook(harness, event, stdin, deps)
  if (res.stdout !== '') io.stdout.write(res.stdout)
  return res.exitCode
}
