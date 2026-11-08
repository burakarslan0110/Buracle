// The terminal multiplexers that hold the task board's worker panes (tmux, cmux, herdr) behind one small interface:
// open a pane that runs a command, title it, mark it when its worker asks the user, focus it, check that it is still
// the pane we opened, close it. Every operation shells out to the multiplexer's own CLI through an injectable `exec`,
// so the tests record argv instead of touching a terminal. Nothing here knows the board; src/workflow/board-panes.ts does.
import { closeSync, existsSync, openSync, writeSync } from 'node:fs'
import type { Harness } from '../core/events'
import { shellQuote } from '../core/policy/shell-text'
import { run } from '../engine/proc'

export type MuxKind = 'tmux' | 'cmux' | 'herdr'
export const MUX_KINDS: readonly MuxKind[] = ['tmux', 'cmux', 'herdr']

type Env = Readonly<Record<string, string | undefined>>

export interface MuxExecResult { code: number; stdout: string; stderr: string }
export type MuxExec = (argv: string[], opts: { timeoutMs: number; env: Env }) => Promise<MuxExecResult>

/** One pane Buracle opened, as the sidecar records it. `server` and `pid` keep a reused id from closing a stranger's pane. */
export interface MuxPane { id: string; ids?: string[]; harness: Harness; title: string; server: string; pid?: string }
export interface MuxOpened { id: string; ids?: string[]; server: string; pid?: string; attach?: string }
export interface OpenSpec { cwd: string; command: string; title: string; slug: string; after?: MuxPane }
/** `stale`: the pane is gone or the id now names another pane (nothing was run). `failed`: the multiplexer did not answer or refused. */
export type CloseResult = { ok: true } | { ok: false; reason: 'stale' | 'failed' }
/** `ok`: the recorded pane is there. `stale`: gone or another pane now. `failed`: the multiplexer could not be asked. */
export type Presence = 'ok' | 'stale' | 'failed'

/** Exit codes that mean the CLI itself could not run or answer, as opposed to "no such pane". */
function unreachable(code: number): boolean { return code === 124 || code === 127 }

export interface MuxAdapter {
  readonly kind: MuxKind
  /** Opens a pane that runs `command` in `cwd`; undefined when the multiplexer refused or printed no id. */
  open(spec: OpenSpec): Promise<MuxOpened | undefined>
  title(pane: MuxPane, text: string): Promise<boolean>
  /** The worker asked the user. tmux gets a title, the mark and a bell; herdr and cmux are told by `notifyTerminal` already. */
  mark(pane: MuxPane, text: string): Promise<boolean>
  clearMark(pane: MuxPane): Promise<boolean>
  focus(pane: MuxPane): Promise<boolean>
  /** Whether the recorded pane is still there: same server (tmux: same shell pid too), or `failed` when the multiplexer did not answer. */
  presence(pane: MuxPane): Promise<Presence>
  /** `presence` is `ok`. */
  alive(pane: MuxPane): Promise<boolean>
  /** Closes the pane after the `presence` check; `stale` and `failed` mean nothing was run. */
  close(pane: MuxPane): Promise<CloseResult>
}

export type MuxDetect = { ok: true; kind: MuxKind } | { ok: false; code: 'usage' | 'no_mux'; message: string }
export type MuxAdapterResult = { ok: true; adapter: MuxAdapter } | { ok: false; code: 'cmux_missing'; message: string }
export interface MuxDeps { exec?: MuxExec; cmuxBin?: string; appBin?: string }

export const MUX_TIMEOUT_MS = 10_000
export const CMUX_APP_BIN = '/Applications/cmux.app/Contents/Resources/bin/cmux'
const NO_MUX_HINT = 'no multiplexer detected (TMUX, HERDR_ENV or CMUX_SURFACE_ID): run the lead inside tmux, herdr or cmux, or pass --mux tmux to open a detached tmux session'
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const REF = /\b(?:pane|surface|workspace):\d+\b/g

function nonEmpty(v: string | undefined): v is string { return typeof v === 'string' && v !== '' }
function isMuxKind(v: string): v is MuxKind { return (MUX_KINDS as readonly string[]).includes(v) }
function inHerdr(env: Env): boolean { return env['HERDR_ENV'] === '1' && nonEmpty(env['HERDR_PANE_ID']) }
function inCmux(env: Env): boolean { return nonEmpty(env['CMUX_SURFACE_ID']) }

/** The multiplexer to use: `explicit` from `--mux`, else the innermost one the environment shows (tmux, then herdr, then cmux). */
export function detectMux(env: Env, explicit?: string): MuxDetect {
  if (explicit !== undefined) {
    if (!isMuxKind(explicit)) return { ok: false, code: 'usage', message: `--mux must be one of ${MUX_KINDS.join(', ')} (got '${explicit}')` }
    if (explicit === 'herdr' && !inHerdr(env)) return { ok: false, code: 'no_mux', message: '--mux herdr needs a lead that runs inside a herdr pane (HERDR_ENV=1 and HERDR_PANE_ID)' }
    if (explicit === 'cmux' && !inCmux(env)) return { ok: false, code: 'no_mux', message: '--mux cmux needs a lead that runs inside cmux (CMUX_SURFACE_ID): its socket accepts only processes started inside cmux' }
    return { ok: true, kind: explicit }
  }
  if (nonEmpty(env['TMUX'])) return { ok: true, kind: 'tmux' }
  if (inHerdr(env)) return { ok: true, kind: 'herdr' }
  if (inCmux(env)) return { ok: true, kind: 'cmux' }
  return { ok: false, code: 'no_mux', message: NO_MUX_HINT }
}

/** The shape of a pane id per multiplexer; a value that fails this never reaches an argv. */
export function validPaneId(kind: MuxKind, id: string): boolean {
  switch (kind) {
    case 'tmux': return /^%\d+$/.test(id)
    case 'herdr': return /^w\d+:p\d+$/.test(id)
    case 'cmux': return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || /^surface:\d+$/.test(id)
    default: { const never: never = kind; return never }
  }
}

/** The pane the calling process runs in, for one multiplexer (`TMUX_PANE`, `HERDR_PANE_ID`, `CMUX_SURFACE_ID`). */
export function paneIdOf(kind: MuxKind, env: Env): string | undefined {
  const v = kind === 'tmux' ? env['TMUX_PANE'] : kind === 'herdr' ? env['HERDR_PANE_ID'] : env['CMUX_SURFACE_ID']
  return nonEmpty(v) && validPaneId(kind, v) ? v : undefined
}

/** The server a herdr or cmux pane belongs to, from the environment; tmux asks the server itself (`#{socket_path}`). */
export function muxServerOf(kind: MuxKind, env: Env): string {
  if (kind === 'herdr') return nonEmpty(env['HERDR_SOCKET_PATH']) ? env['HERDR_SOCKET_PATH'] : 'herdr'
  if (kind === 'cmux') return nonEmpty(env['CMUX_SOCKET_PATH']) ? env['CMUX_SOCKET_PATH'] : 'cmux'
  return ''
}

/** The shell line a worker pane runs: the harness in interactive mode with `/buracle-join <slug>` as its first prompt. */
export function workerCommand(harness: Harness, slug: string, dir: string, kind: MuxKind): string {
  const prompt = `${harness === 'codex' ? '$' : '/'}buracle-join ${slug}`
  let cmd: string
  switch (harness) {
    case 'claude': cmd = `claude ${shellQuote(prompt)}`; break
    case 'codex': cmd = `codex -C ${shellQuote(dir)} ${shellQuote(prompt)}`; break
    case 'opencode': cmd = `opencode --prompt ${shellQuote(prompt)} ${shellQuote(dir)}`; break
    case 'omp': cmd = `omp --cwd=${shellQuote(dir)} ${shellQuote(prompt)}`; break
    default: { const never: never = harness; return never }
  }
  // cmux's new-split has no working-directory flag, so the line changes directory first.
  return kind === 'cmux' ? `cd ${shellQuote(dir)} && ${cmd}` : cmd
}

/** The cmux CLI: on PATH, else inside the app bundle. */
export function cmuxBin(env: Env, appBin = CMUX_APP_BIN): string | undefined {
  const onPath = Bun.which('cmux', { PATH: env['PATH'] ?? process.env['PATH'] ?? '' })
  if (onPath !== null) return onPath
  return existsSync(appBin) ? appBin : undefined
}

const defaultExec: MuxExec = async (argv, o) => {
  try {
    const r = await run(argv, { timeoutMs: o.timeoutMs, env: { ...o.env } })
    return { code: r.code, stdout: r.stdout, stderr: r.stderr }
  } catch (e) {
    return { code: 127, stdout: '', stderr: e instanceof Error ? e.message : String(e) }
  }
}

function writeBell(tty: string): void {
  let fd: number | undefined
  try {
    fd = openSync(tty, 'w')
    writeSync(fd, '\x07')
  } catch {  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch {  } }
  }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { return undefined }
}

function field(x: unknown, ...path: string[]): unknown {
  let cur = x
  for (const p of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function tmuxAdapter(env: Env, exec: MuxExec): MuxAdapter {
  const x = (args: string[]) => exec(['tmux', ...args], { timeoutMs: MUX_TIMEOUT_MS, env })
  const inside = nonEmpty(env['TMUX'])
  const leadPane = env['TMUX_PANE']
  const facts = async (id: string): Promise<{ pid: string; server: string } | 'failed' | undefined> => {
    const r = await x(['display-message', '-p', '-t', id, '#{pane_pid} #{socket_path}'])
    if (unreachable(r.code)) return 'failed'
    if (r.code !== 0) return undefined
    const [pid, ...rest] = r.stdout.trim().split(' ')
    const server = rest.join(' ')
    return nonEmpty(pid) && server !== '' ? { pid, server } : undefined
  }
  const presence = async (pane: MuxPane): Promise<Presence> => {
    if (!validPaneId('tmux', pane.id)) return 'stale'
    const f = await facts(pane.id)
    if (f === 'failed') return 'failed'
    if (f === undefined) return 'stale'
    if (pane.pid !== undefined && f.pid !== pane.pid) return 'stale'
    return pane.server === '' || f.server === pane.server ? 'ok' : 'stale'
  }
  return {
    kind: 'tmux',
    async open(spec) {
      const session = `buracle-${spec.slug}`
      const common = ['-d', ...(spec.after !== undefined ? ['-v'] : ['-h']), '-c', spec.cwd, '-P', '-F', '#{pane_id}']
      let argv: string[]
      let attach: string | undefined
      if (inside) {
        const target = spec.after !== undefined ? spec.after.id : leadPane
        argv = ['split-window', ...common, ...(nonEmpty(target) ? ['-t', target] : []), spec.command]
      } else {
        const has = await x(['has-session', '-t', `=${session}`])
        argv = has.code === 0
          ? ['split-window', '-d', '-v', '-c', spec.cwd, '-P', '-F', '#{pane_id}', '-t', `${session}:`, spec.command]
          : ['new-session', '-d', '-s', session, '-c', spec.cwd, '-P', '-F', '#{pane_id}', spec.command]
        attach = `tmux attach -t ${session}`
      }
      const r = await x(argv)
      const id = r.stdout.trim()
      if (r.code !== 0 || !validPaneId('tmux', id)) return undefined
      await x(['select-layout', '-t', id, 'tiled'])
      await x(['set-option', '-p', '-t', id, 'allow-passthrough', 'on'])
      await x(['select-pane', '-t', id, '-T', spec.title])
      const f = await facts(id)
      const known = f !== undefined && f !== 'failed' ? f : undefined
      // Without an answer, the socket path in TMUX (inside tmux) still names the server; a record needs one.
      const out: MuxOpened = { id, server: known?.server ?? (env['TMUX'] ?? '').split(',')[0] ?? '' }
      if (known !== undefined) out.pid = known.pid
      if (attach !== undefined) out.attach = attach
      return out
    },
    async title(pane, text) { return (await x(['select-pane', '-t', pane.id, '-T', text])).code === 0 },
    async mark(pane, text) {
      const titled = await x(['select-pane', '-t', pane.id, '-T', text])
      await x(['select-pane', '-m', '-t', pane.id])
      const tty = await x(['display-message', '-p', '-t', pane.id, '#{pane_tty}'])
      if (tty.code === 0 && tty.stdout.trim() !== '') writeBell(tty.stdout.trim())
      return titled.code === 0
    },
    async clearMark(pane) {
      const titled = await x(['select-pane', '-t', pane.id, '-T', pane.title])
      // -M clears whichever pane is marked, so only touch it while the mark is ours.
      const marked = await x(['display-message', '-p', '-t', pane.id, '#{pane_marked}'])
      if (marked.code === 0 && marked.stdout.trim() === '1') await x(['select-pane', '-M'])
      return titled.code === 0
    },
    async focus(pane) {
      const w = await x(['select-window', '-t', pane.id])
      const p = await x(['select-pane', '-t', pane.id])
      return w.code === 0 && p.code === 0
    },
    presence,
    async alive(pane) { return (await presence(pane)) === 'ok' },
    async close(pane) {
      const p = await presence(pane)
      if (p !== 'ok') return { ok: false, reason: p }
      return (await x(['kill-pane', '-t', pane.id])).code === 0 ? { ok: true } : { ok: false, reason: 'failed' }
    },
  }
}

function herdrAdapter(env: Env, exec: MuxExec): MuxAdapter {
  const x = (args: string[]) => exec(['herdr', ...args], { timeoutMs: MUX_TIMEOUT_MS, env })
  const server = muxServerOf('herdr', env)
  const sameServer = (pane: MuxPane): boolean => validPaneId('herdr', pane.id) && (pane.server === '' || pane.server === server)
  const presence = async (pane: MuxPane): Promise<Presence> => {
    if (!sameServer(pane)) return 'stale'
    const r = await x(['pane', 'get', pane.id])
    if (r.code === 0) return 'ok'
    // herdr answers every error as JSON on stderr with exit 1: only a missing pane is "gone", anything else is "could not ask".
    return !unreachable(r.code) && /not_found/.test(r.stderr) ? 'stale' : 'failed'
  }
  return {
    kind: 'herdr',
    async open(spec) {
      const where = spec.after !== undefined ? ['--pane', spec.after.id, '--direction', 'down'] : ['--current', '--direction', 'right']
      const r = await x(['pane', 'split', ...where, '--cwd', spec.cwd, '--no-focus'])
      if (r.code !== 0) return undefined
      const id = field(parseJson(r.stdout), 'result', 'pane', 'pane_id')
      if (typeof id !== 'string' || !validPaneId('herdr', id)) return undefined
      await x(['pane', 'rename', id, spec.title])
      const ran = await x(['pane', 'run', id, spec.command])
      if (ran.code !== 0) {
        // A pane without its command is an empty shell nobody joins from: take it down again and report no pane.
        await x(['pane', 'close', id])
        return undefined
      }
      return { id, server }
    },
    async title(pane, text) { return (await x(['pane', 'rename', pane.id, text])).code === 0 },
    async mark() { return true },
    async clearMark(pane) {
      return (await x(['pane', 'report-agent', pane.id, '--source', 'buracle', '--agent', pane.harness, '--state', 'working'])).code === 0
    },
    async focus(pane) { return (await x(['agent', 'focus', pane.id])).code === 0 },
    presence,
    async alive(pane) { return (await presence(pane)) === 'ok' },
    async close(pane) {
      const p = await presence(pane)
      if (p !== 'ok') return { ok: false, reason: p }
      return (await x(['pane', 'close', pane.id])).code === 0 ? { ok: true } : { ok: false, reason: 'failed' }
    },
  }
}

/** Every pane, surface and workspace handle in a cmux listing, in order of appearance, once each. */
function cmuxTokens(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const all = [...text.matchAll(UUID), ...text.matchAll(REF)].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  for (const m of all) {
    const t = m[0]
    if (!seen.has(t)) { seen.add(t); out.push(t) }
  }
  return out
}

function cmuxAdapter(env: Env, exec: MuxExec, bin: string): MuxAdapter {
  const x = (args: string[]) => exec([bin, ...args], { timeoutMs: MUX_TIMEOUT_MS, env })
  const server = muxServerOf('cmux', env)
  const list = async (): Promise<string[] | undefined> => {
    const r = await x(['list-pane-surfaces', '--json', '--id-format', 'both'])
    return r.code === 0 ? cmuxTokens(r.stdout) : undefined
  }
  const handles = (pane: MuxPane): string[] => [pane.id, ...(pane.ids ?? [])]
  const sameServer = (pane: MuxPane): boolean => validPaneId('cmux', pane.id) && (pane.server === '' || pane.server === server)
  const presence = async (pane: MuxPane): Promise<Presence> => {
    if (!sameServer(pane)) return 'stale'
    const now = await list()
    if (now === undefined) return 'failed'
    return handles(pane).some(h => now.includes(h)) ? 'ok' : 'stale'
  }
  return {
    kind: 'cmux',
    async open(spec) {
      const before = await list()
      if (before === undefined) return undefined
      const where = spec.after !== undefined ? ['down', '--surface', spec.after.id] : ['right']
      const r = await x(['new-split', ...where, '--command', spec.command, '--focus', 'false'])
      if (r.code !== 0) return undefined
      const after = await list()
      if (after === undefined) return undefined
      const fresh = after.filter(t => !before.includes(t))
      if (fresh.length === 0) return undefined
      // The surface's UUID is what CMUX_SURFACE_ID carries in the pane: the one right after the new surface ref, else the last UUID.
      const lastSurface = fresh.map((t, i) => (t.startsWith('surface:') ? i : -1)).filter(i => i >= 0).at(-1)
      const uuids = fresh.filter(t => /^[0-9a-f-]{36}$/i.test(t))
      const afterRef = lastSurface !== undefined ? fresh.slice(lastSurface + 1).find(t => /^[0-9a-f-]{36}$/i.test(t)) : undefined
      const id = afterRef ?? uuids.at(-1) ?? fresh.find(t => t.startsWith('surface:')) ?? fresh[0]
      if (id === undefined) return undefined
      await x(['rename-tab', '--surface', id, spec.title])
      return { id, ids: fresh, server }
    },
    async title(pane, text) { return (await x(['rename-tab', '--surface', pane.id, text])).code === 0 },
    async mark() { return true },
    async clearMark(pane) { return (await x(['clear-notifications', '--surface', pane.id])).code === 0 },
    async focus(pane) {
      const ws = env['CMUX_WORKSPACE_ID']
      if (nonEmpty(ws)) await x(['select-workspace', '--workspace', ws])
      const paneRef = pane.ids?.find(t => t.startsWith('pane:')) ?? pane.id
      return (await x(['focus-pane', '--pane', paneRef])).code === 0
    },
    presence,
    async alive(pane) { return (await presence(pane)) === 'ok' },
    async close(pane) {
      const p = await presence(pane)
      if (p !== 'ok') return { ok: false, reason: p }
      return (await x(['close-surface', '--surface', pane.id])).code === 0 ? { ok: true } : { ok: false, reason: 'failed' }
    },
  }
}

/** The adapter for one multiplexer; cmux needs its CLI (PATH or the app bundle). */
export function muxAdapter(kind: MuxKind, env: Env, deps: MuxDeps = {}): MuxAdapterResult {
  const exec = deps.exec ?? defaultExec
  switch (kind) {
    case 'tmux': return { ok: true, adapter: tmuxAdapter(env, exec) }
    case 'herdr': return { ok: true, adapter: herdrAdapter(env, exec) }
    case 'cmux': {
      const bin = deps.cmuxBin ?? cmuxBin(env, deps.appBin)
      if (bin === undefined) return { ok: false, code: 'cmux_missing', message: `the cmux CLI was not found on PATH or at ${deps.appBin ?? CMUX_APP_BIN}; install the cmux CLI (cmux settings) or pass --mux tmux` }
      return { ok: true, adapter: cmuxAdapter(env, exec, bin) }
    }
    default: { const never: never = kind; return never }
  }
}
