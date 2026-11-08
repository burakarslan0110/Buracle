// The terminal multiplexers that hold the task board's worker panes (tmux, cmux, herdr) behind one small interface:
// open a pane that runs a command, title it, mark it when its worker asks the user, focus it, check that it is still
// the pane we opened, close it. Every operation shells out to the multiplexer's own CLI through an injectable `exec`,
// so the tests record argv instead of touching a terminal. Nothing here knows the board; src/workflow/board-panes.ts does.
import { closeSync, existsSync, openSync, writeSync } from 'node:fs'
import type { Harness } from '../core/events'
import { shellQuote } from '../core/policy/shell-text'
import { log } from '../engine/log'
import { run } from '../engine/proc'
import type { SplitDirection } from './mux-layout'

/** `herdr-app` is the Herdr desktop app: its terminals run in herdr-core (`hc`), a different program from the `herdr` TUI with its own socket. */
export type MuxKind = 'tmux' | 'cmux' | 'herdr' | 'herdr-app'
export const MUX_KINDS: readonly MuxKind[] = ['tmux', 'cmux', 'herdr', 'herdr-app']

type Env = Readonly<Record<string, string | undefined>>

export interface MuxExecResult { code: number; stdout: string; stderr: string }
export type MuxExec = (argv: string[], opts: { timeoutMs: number; env: Env }) => Promise<MuxExecResult>

/** One pane Buracle opened, as the sidecar records it. `server` and `pid` keep a reused id from closing a stranger's pane. */
export interface MuxPane { id: string; ids?: string[]; harness: Harness; title: string; server: string; pid?: string }
export interface MuxOpened { id: string; ids?: string[]; server: string; pid?: string; attach?: string }
/**
 * How a new pane is cut out of an existing one: `target` is the pane to split (`lead`: the lead's own pane), `direction`
 * where the new pane goes, and `keep` the share of the split pane's area that pane keeps (the new pane takes the rest).
 * A multiplexer whose CLI takes no size (cmux) splits in halves and ignores `keep`.
 */
export interface Split { target: 'lead' | MuxPane; direction: SplitDirection; keep: number }
/** Without a `split` the pane goes to the right of the lead's pane. */
export interface OpenSpec { cwd: string; command: string; title: string; slug: string; split?: Split }
/**
 * `stale`: the pane is gone or the id now names another pane (nothing was run). `failed`: the multiplexer did not answer.
 * `refused`: it answered and would not close the pane; `message` is what it said.
 */
export type CloseResult = { ok: true } | { ok: false; reason: 'stale' | 'failed' } | { ok: false; reason: 'refused'; message: string }
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
  /** Closes the pane after the `presence` check, its running program included; `stale` and `failed` mean nothing was run. */
  close(pane: MuxPane): Promise<CloseResult>
  /**
   * Every handle the multiplexer has for the pane `id` names (cmux: the surface ref and its UUID), from its listing; `[]`
   * when no pane has it, undefined when the multiplexer did not answer. Only a multiplexer with several ids per pane has it.
   */
  handlesOf?(id: string): Promise<string[] | undefined>
  /**
   * The pid of the shell the pane `id` runs, from the multiplexer; undefined when it has no such pane or did not answer.
   * A worker whose environment names a stale pane (Codex replays a shell snapshot taken in an earlier session) is matched
   * to its pane through this pid: it is an ancestor of the worker's process.
   */
  shellPid?(id: string): Promise<string | undefined>
}

/** What a CLI said when it refused: stderr, else stdout, else its exit code. */
function refusal(r: MuxExecResult): CloseResult {
  if (unreachable(r.code)) return { ok: false, reason: 'failed' }
  const said = r.stderr.trim() !== '' ? r.stderr.trim() : r.stdout.trim()
  return { ok: false, reason: 'refused', message: said !== '' ? said.split('\n')[0] ?? said : `exit ${r.code}` }
}

export type MuxDetect = { ok: true; kind: MuxKind } | { ok: false; code: 'usage' | 'no_mux'; message: string }
export type MuxAdapterResult = { ok: true; adapter: MuxAdapter } | { ok: false; code: 'cmux_missing'; message: string }
/**
 * `pid`: the calling process (tests pass one; the default is this process), the start of the ancestor walk in `ancestorPids`.
 * `hcBin`: the herdr-core CLI (`hc` on PATH, else `herdr-core`).
 */
export interface MuxDeps { exec?: MuxExec; cmuxBin?: string; appBin?: string; pid?: number; hcBin?: string }

export const MUX_TIMEOUT_MS = 10_000
export const CMUX_APP_BIN = '/Applications/cmux.app/Contents/Resources/bin/cmux'
const NO_MUX_HINT = 'no multiplexer detected (TMUX, HERDR_ENV, CMUX_SURFACE_ID or HC_TERMINAL_ID): run the lead inside tmux, herdr, cmux or the Herdr app, or pass --mux tmux to open a detached tmux session'
/** The herdr-core labels that put a terminal into a space and a tab of the Herdr app. */
const HC_SPACE_LABEL = 'herdr.space'
const HC_TAB_LABEL = 'herdr.tab'
/** herdr-core names: 1 to 32 of a-z, 0-9, `-` and `_`, unique among live terminals. */
const HC_NAME_MAX = 32
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const CMUX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Printable ASCII with no space and no leading dash: safe to hand to `herdr pane close` as a single argument. */
const SAFE_ID = /^[^\s-][\x21-\x7e]*$/
const REF = /\b(?:pane|surface|workspace):\d+\b/g

function nonEmpty(v: string | undefined): v is string { return typeof v === 'string' && v !== '' }
function isMuxKind(v: string): v is MuxKind { return (MUX_KINDS as readonly string[]).includes(v) }
function inHerdr(env: Env): boolean { return env['HERDR_ENV'] === '1' && nonEmpty(env['HERDR_PANE_ID']) }
function inCmux(env: Env): boolean { return nonEmpty(env['CMUX_SURFACE_ID']) }
/** A terminal that herdr-core runs: the Herdr app's, or one started with `hc run`. The app's `open` checks the space and tab labels. */
function inHerdrApp(env: Env): boolean { return paneIdOf('herdr-app', env) !== undefined }

/** The multiplexer to use: `explicit` from `--mux`, else the innermost one the environment shows (tmux, then herdr, then cmux, then the Herdr app). */
export function detectMux(env: Env, explicit?: string): MuxDetect {
  if (explicit !== undefined) {
    if (!isMuxKind(explicit)) return { ok: false, code: 'usage', message: `--mux must be one of ${MUX_KINDS.join(', ')} (got '${explicit}')` }
    if (explicit === 'herdr' && !inHerdr(env)) return { ok: false, code: 'no_mux', message: '--mux herdr needs a lead that runs inside a herdr pane (HERDR_ENV=1 and HERDR_PANE_ID)' }
    if (explicit === 'cmux' && !inCmux(env)) return { ok: false, code: 'no_mux', message: '--mux cmux needs a lead that runs inside cmux (CMUX_SURFACE_ID): its socket accepts only processes started inside cmux' }
    if (explicit === 'herdr-app' && !inHerdrApp(env)) return { ok: false, code: 'no_mux', message: '--mux herdr-app needs a lead that runs inside a terminal of the Herdr app (HC_TERMINAL_ID)' }
    return { ok: true, kind: explicit }
  }
  if (nonEmpty(env['TMUX'])) return { ok: true, kind: 'tmux' }
  if (inHerdr(env)) return { ok: true, kind: 'herdr' }
  if (inCmux(env)) return { ok: true, kind: 'cmux' }
  if (inHerdrApp(env)) return { ok: true, kind: 'herdr-app' }
  return { ok: false, code: 'no_mux', message: NO_MUX_HINT }
}

/**
 * What a multiplexer offers for the layout of the worker panes: `exact`, a split takes a size (cmux halves every split);
 * `lead`, the lead's own pane can be split (a detached tmux session, opened from outside tmux, has no lead pane).
 */
export function layoutCaps(kind: MuxKind, env: Env): { exact: boolean; lead: boolean } {
  switch (kind) {
    case 'tmux': return { exact: true, lead: nonEmpty(env['TMUX']) }
    case 'herdr': return { exact: true, lead: true }
    case 'cmux': return { exact: false, lead: true }
    // The app places an adopted terminal in the lead's tab itself; Buracle neither splits nor sizes.
    case 'herdr-app': return { exact: false, lead: false }
    default: { const never: never = kind; return never }
  }
}

/** The share a split gives the new pane, as a whole percentage tmux takes (1 to 99). */
function newShare(keep: number): number {
  return Math.min(99, Math.max(1, Math.round((1 - keep) * 100)))
}

/** The share the split pane keeps, as the short decimal herdr's `--ratio` takes (0.25, 0.333). */
function keepRatio(keep: number): string {
  return String(Math.min(0.99, Math.max(0.01, Math.round(keep * 1000) / 1000)))
}

/** The shape of a pane id per multiplexer; a value that fails this never reaches an argv. */
export function validPaneId(kind: MuxKind, id: string): boolean {
  switch (kind) {
    case 'tmux': return /^%\d+$/.test(id)
    // herdr's ids are opaque handles whose number is written in base 36 (w2:p9, then w2:pA … w2:pZ, observed up to pH), so every letter belongs to the shape.
    case 'herdr': return /^w[0-9a-z]+:p[0-9a-z]+$/i.test(id)
    case 'cmux': return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || /^surface:\d+$/.test(id)
    // herdr-core addresses: `t7`, `t1b` (local only; `machine/t7` names another machine and never a pane of the lead's app).
    case 'herdr-app': return /^t[0-9a-z]+$/i.test(id)
    default: { const never: never = kind; return never }
  }
}

/** The pane the calling process runs in, for one multiplexer (`TMUX_PANE`, `HERDR_PANE_ID`, `CMUX_SURFACE_ID`, `HC_TERMINAL_ID`). */
export function paneIdOf(kind: MuxKind, env: Env): string | undefined {
  const v = kind === 'tmux' ? env['TMUX_PANE'] : kind === 'herdr' ? env['HERDR_PANE_ID'] : kind === 'cmux' ? env['CMUX_SURFACE_ID'] : env['HC_TERMINAL_ID']
  return nonEmpty(v) && validPaneId(kind, v) ? v : undefined
}

/** The server a herdr, cmux or herdr-core pane belongs to, from the environment; tmux asks the server itself (`#{socket_path}`). */
export function muxServerOf(kind: MuxKind, env: Env): string {
  if (kind === 'herdr') return nonEmpty(env['HERDR_SOCKET_PATH']) ? env['HERDR_SOCKET_PATH'] : 'herdr'
  if (kind === 'cmux') return nonEmpty(env['CMUX_SOCKET_PATH']) ? env['CMUX_SOCKET_PATH'] : 'cmux'
  if (kind === 'herdr-app') return nonEmpty(env['HC_TERMINAL_SOCKET']) ? env['HC_TERMINAL_SOCKET'] : 'herdr-core'
  return ''
}

/**
 * The shell line a worker pane runs: the harness in interactive mode with `/buracle-join <slug>` as its first prompt.
 * `bin` is the harness program when the pane's shell may not find it by name (omp installed under ~/.bun/bin, say).
 */
export function workerCommand(harness: Harness, slug: string, dir: string, kind: MuxKind, bin?: string): string {
  const prompt = `${harness === 'codex' ? '$' : '/'}buracle-join ${slug}`
  const exe = bin !== undefined ? shellQuote(bin) : harness
  let cmd: string
  switch (harness) {
    case 'claude': cmd = `${exe} ${shellQuote(prompt)}`; break
    case 'codex': cmd = `${exe} -C ${shellQuote(dir)} ${shellQuote(prompt)}`; break
    case 'opencode': cmd = `${exe} --prompt ${shellQuote(prompt)} ${shellQuote(dir)}`; break
    case 'omp': cmd = `${exe} --cwd=${shellQuote(dir)} ${shellQuote(prompt)}`; break
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

/** The herdr-core CLI: `hc` on PATH, else `herdr-core` (the same program under its long name). */
export function hcBin(env: Env): string {
  return Bun.which('hc', { PATH: env['PATH'] ?? process.env['PATH'] ?? '' }) !== null ? 'hc' : 'herdr-core'
}

/** A herdr-core terminal name from a pane title and the board slug: `Worker 1 (codex) · …` and `rate-limit` give `worker-1-codex-rate-limit`. */
export function hcName(title: string, slug: string): string {
  const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const head = slugify(title.split('·')[0] ?? title)
  const name = `${head}-${slugify(slug)}`.replace(/-+/g, '-').slice(0, HC_NAME_MAX).replace(/^-+|-+$/g, '')
  return name === '' ? 'buracle-worker' : name
}

const defaultExec: MuxExec = async (argv, o) => {
  try {
    const r = await run(argv, { timeoutMs: o.timeoutMs, env: { ...o.env } })
    return { code: r.code, stdout: r.stdout, stderr: r.stderr }
  } catch (e) {
    return { code: 127, stdout: '', stderr: e instanceof Error ? e.message : String(e) }
  }
}

/** The maximum depth of the ancestor walk: a harness sits a few shells and wrappers below its pane's shell, never dozens. */
const ANCESTOR_LIMIT = 32

/**
 * The pids of the process `pid` and its ancestors up to init, nearest first, from `ps -o ppid=`. The walk stops at a pid
 * `ps` does not know, at 0 or 1, or after `ANCESTOR_LIMIT` steps.
 */
export async function ancestorPids(pid: number, env: Env, exec: MuxExec = defaultExec): Promise<string[]> {
  const out: string[] = []
  let cur = pid
  for (let i = 0; i < ANCESTOR_LIMIT && Number.isInteger(cur) && cur > 1; i++) {
    out.push(String(cur))
    const r = await exec(['ps', '-o', 'ppid=', '-p', String(cur)], { timeoutMs: MUX_TIMEOUT_MS, env })
    const next = Number(r.stdout.trim())
    if (r.code !== 0 || !Number.isInteger(next) || out.includes(String(next))) break
    cur = next
  }
  return out
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
  // The lead's pane goes into an argv as a target, so it must look like a tmux pane id.
  const leadPane = paneIdOf('tmux', env)
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
      const split = spec.split
      // A pane that is named as the one to split must look like a tmux pane id: it goes into an argv.
      if (split !== undefined && split.target !== 'lead' && !validPaneId('tmux', split.target.id)) return undefined
      const pane = split !== undefined && split.target !== 'lead' ? split.target.id : undefined
      // The size of the new pane: `-l N%` (tmux 3.1 and later), or `-p N` for an older tmux. No `select-layout`: the
      // window also holds the lead and whatever else the user keeps there.
      const sizeFlags = (percentSign: boolean): string[] => (split === undefined ? [] : percentSign ? ['-l', `${newShare(split.keep)}%`] : ['-p', String(newShare(split.keep))])
      const common = (percentSign: boolean): string[] => ['-d', split?.direction === 'down' ? '-v' : '-h', ...sizeFlags(percentSign), '-c', spec.cwd, '-P', '-F', '#{pane_id}']
      let argvFor: (percentSign: boolean) => string[]
      let sized = split !== undefined
      let attach: string | undefined
      if (inside) {
        const target = pane ?? leadPane
        argvFor = p => ['split-window', ...common(p), ...(nonEmpty(target) ? ['-t', target] : []), spec.command]
      } else {
        const has = await x(['has-session', '-t', `=${session}`])
        if (has.code === 0 && pane !== undefined) {
          // The session exists and the plan names the pane to split.
          argvFor = p => ['split-window', ...common(p), '-t', pane, spec.command]
        } else if (has.code === 0) {
          // The session exists and the plan names no pane: split whatever pane its window shows.
          sized = false
          argvFor = () => ['split-window', '-d', '-v', '-c', spec.cwd, '-P', '-F', '#{pane_id}', '-t', `${session}:`, spec.command]
        } else {
          sized = false
          argvFor = () => ['new-session', '-d', '-s', session, '-c', spec.cwd, '-P', '-F', '#{pane_id}', spec.command]
        }
        attach = `tmux attach -t ${session}`
      }
      let r = await x(argvFor(true))
      // An older tmux refuses a percent size after -l; it takes the same size through -p.
      if (r.code !== 0 && sized) r = await x(argvFor(false))
      const id = r.stdout.trim()
      if (r.code !== 0 || !validPaneId('tmux', id)) return undefined
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
      const r = await x(['kill-pane', '-t', pane.id])
      return r.code === 0 ? { ok: true } : refusal(r)
    },
    async shellPid(id) {
      if (!validPaneId('tmux', id)) return undefined
      const f = await facts(id)
      return f !== undefined && f !== 'failed' ? f.pid : undefined
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
      const split = spec.split
      if (split !== undefined && split.target !== 'lead' && !validPaneId('herdr', split.target.id)) return undefined
      const where = split === undefined
        ? ['--current', '--direction', 'right']
        : [...(split.target === 'lead' ? ['--current'] : ['--pane', split.target.id]), '--direction', split.direction, '--ratio', keepRatio(split.keep)]
      const r = await x(['pane', 'split', ...where, '--cwd', spec.cwd, '--no-focus'])
      if (r.code !== 0) return undefined
      const id = field(parseJson(r.stdout), 'result', 'pane', 'pane_id')
      if (typeof id !== 'string') return undefined
      if (!validPaneId('herdr', id)) {
        // The split worked, so a pane exists. An id of a shape Buracle does not know is still the id herdr gave this pane:
        // take it down again (unless it could pass for a flag) instead of leaving an empty shell nobody records or closes.
        if (SAFE_ID.test(id)) await x(['pane', 'close', id])
        return undefined
      }
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
      const r = await x(['pane', 'close', pane.id])
      return r.code === 0 ? { ok: true } : refusal(r)
    },
    async shellPid(id) {
      if (!validPaneId('herdr', id)) return undefined
      const r = await x(['pane', 'process-info', '--pane', id])
      if (r.code !== 0) return undefined
      const pid = field(parseJson(r.stdout), 'result', 'process_info', 'shell_pid')
      return typeof pid === 'number' && Number.isInteger(pid) ? String(pid) : typeof pid === 'string' && /^\d+$/.test(pid) ? pid : undefined
    },
  }
}

/**
 * The Herdr desktop app. Its terminals run in herdr-core (`hc`): a terminal carries the labels `herdr.space` and `herdr.tab`
 * of the space and tab the app shows it in, and a terminal started with the lead's labels appears in the lead's tab as a
 * pane of its own (the app places it; there is no split to size). A worker terminal's id is its herdr-core address (`t9`),
 * which the worker sees as HC_TERMINAL_ID. Labels on the terminal carry the title and the mark; the app shows the terminal's
 * name (`worker-1-codex-<slug>`). `herdr-app` (the app's CLI) focuses a pane; everything else goes through `hc`.
 */
function herdrAppAdapter(env: Env, exec: MuxExec, hc: string): MuxAdapter {
  const x = (args: string[]) => exec([hc, ...args], { timeoutMs: MUX_TIMEOUT_MS, env })
  const app = (args: string[]) => exec(['herdr-app', ...args], { timeoutMs: MUX_TIMEOUT_MS, env })
  const server = muxServerOf('herdr-app', env)
  const lead = paneIdOf('herdr-app', env)
  const shell = (): string => { const s = env['SHELL']; return nonEmpty(s) && s.startsWith('/') ? s : '/bin/sh' }
  // Without HC_TERMINAL_SOCKET (a lead command run from a shell outside the app) hc talks to its default session, the one
  // the records name: the socket check is only possible when the environment names one.
  const sameServer = (pane: MuxPane): boolean => validPaneId('herdr-app', pane.id) && (pane.server === '' || server === 'herdr-core' || pane.server === server)
  /**
   * `hc get <id> --json`: the terminal's record, undefined when hc has no such terminal (`not_found`), `'failed'` when hc
   * did not answer or refused for another reason (a record is never dropped on a daemon hiccup).
   */
  const record = async (id: string): Promise<Record<string, unknown> | 'failed' | undefined> => {
    const r = await x(['get', id, '--json'])
    if (r.code !== 0) return !unreachable(r.code) && /not_found/.test(r.stderr + r.stdout) ? undefined : 'failed'
    const j = parseJson(r.stdout)
    return j !== null && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : 'failed'
  }
  const presence = async (pane: MuxPane): Promise<Presence> => {
    if (!sameServer(pane)) return 'stale'
    const rec = await record(pane.id)
    if (rec === 'failed') return 'failed'
    return rec !== undefined && rec['state'] === 'live' ? 'ok' : 'stale'
  }
  const label = async (pane: MuxPane, kv: string): Promise<boolean> => (await x(['label', pane.id, kv])).code === 0
  return {
    kind: 'herdr-app',
    async open(spec) {
      if (lead === undefined) return undefined
      const me = await record(lead)
      if (me === 'failed' || me === undefined) return undefined
      const space = field(me, 'labels', HC_SPACE_LABEL)
      const tab = field(me, 'labels', HC_TAB_LABEL)
      // Without the app's labels the lead is a plain hc terminal: a worker started from it would show up in no window.
      if (typeof space !== 'string' || space === '' || typeof tab !== 'string' || tab === '') return undefined
      const run = async (name: string | undefined): Promise<MuxExecResult> => x([
        'run', '--json', '--bg', '--keep', '--outlive-parent', '--no-parent', '--no-notify', '--cwd', spec.cwd,
        ...(name !== undefined ? ['--name', name] : []),
        '--label', `${HC_SPACE_LABEL}=${space}`, '--label', `${HC_TAB_LABEL}=${tab}`,
        '--', shell(), '-lc', spec.command,
      ])
      let r = await run(hcName(spec.title, spec.slug))
      // A live terminal of an earlier run may hold the name: the pane matters more than its name.
      if (r.code !== 0 && /name_taken/.test(r.stderr + r.stdout)) r = await run(undefined)
      if (r.code !== 0) return undefined
      const id = field(parseJson(r.stdout), 'address')
      if (typeof id !== 'string' || !validPaneId('herdr-app', id)) return undefined
      return { id, server }
    },
    async title(pane, text) { return label(pane, `buracle.label=${text}`) },
    async mark(pane, text) { return label(pane, `buracle.mark=${text}`) },
    async clearMark(pane) { return label(pane, 'buracle.mark=') },
    async focus(pane) { return (await app(['do', 'pane.focus', '--terminal', pane.id])).code === 0 },
    presence,
    async alive(pane) { return (await presence(pane)) === 'ok' },
    async close(pane) {
      if (!sameServer(pane)) return { ok: false, reason: 'stale' }
      const rec = await record(pane.id)
      if (rec === 'failed') return { ok: false, reason: 'failed' }
      if (rec === undefined) return { ok: false, reason: 'stale' }
      if (rec['state'] === 'live') {
        const k = await x(['kill', pane.id, '--json'])
        if (k.code !== 0) return refusal(k)
      }
      // A finished terminal (killed now, or a worker that exited on its own, kept by --keep) stays listed, and in the
      // app's tab, until it is removed.
      await x(['rm', pane.id, '--json'])
      return rec['state'] === 'live' ? { ok: true } : { ok: false, reason: 'stale' }
    },
    async shellPid(id) {
      if (!validPaneId('herdr-app', id)) return undefined
      const rec = await record(id)
      if (rec === 'failed' || rec === undefined) return undefined
      const pid = rec['pid']
      return typeof pid === 'number' && Number.isInteger(pid) ? String(pid) : undefined
    },
  }
}

/**
 * Every pane, surface and workspace handle in a cmux listing, in order of appearance, once each. A quoted part of a
 * line is a title (`surface:4 <uuid> "Worker 1 · Task 3: close surface:9"`): what it says is never a handle.
 */
function cmuxTokens(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const unquoted = text.split('\n').map(l => l.split('"')[0] ?? '').join('\n')
  const all = [...unquoted.matchAll(UUID), ...unquoted.matchAll(REF)].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  for (const m of all) {
    const t = m[0]
    if (!seen.has(t)) { seen.add(t); out.push(t) }
  }
  return out
}

/** The handles on the listing line that carries `id`: a surface's ref and its UUID sit on one line of `list-panels`. */
function cmuxLineOf(listing: string, id: string): string[] {
  const want = id.toLowerCase()
  const line = listing.split('\n').find(l => cmuxTokens(l).some(t => t.toLowerCase() === want))
  return line === undefined ? [] : cmuxTokens(line).filter(t => !t.startsWith('workspace:'))
}

function cmuxAdapter(env: Env, exec: MuxExec, bin: string): MuxAdapter {
  const x = (args: string[]) => exec([bin, ...args], { timeoutMs: MUX_TIMEOUT_MS, env })
  const server = muxServerOf('cmux', env)
  // Every surface of the workspace, with refs and UUIDs (`--id-format` is a global option, so it comes before the command).
  // Not `list-pane-surfaces`: that lists the focused pane only, and a split opened unfocused is a pane of its own.
  const listing = async (): Promise<string | undefined> => {
    const r = await x(['--id-format', 'both', 'list-panels'])
    return r.code === 0 ? r.stdout : undefined
  }
  const list = async (): Promise<string[] | undefined> => {
    const text = await listing()
    return text === undefined ? undefined : cmuxTokens(text)
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
      const split = spec.split
      if (split !== undefined && split.target !== 'lead' && !validPaneId('cmux', split.target.id)) return undefined
      // new-split takes a direction and a surface but no size: cmux halves the surface it splits (the lead's, by default).
      const where = split === undefined ? ['right'] : [split.direction, ...(split.target === 'lead' ? [] : ['--surface', split.target.id])]
      const r = await x(['new-split', ...where, '--command', spec.command, '--focus', 'false'])
      if (r.code !== 0) return undefined
      // What cmux printed for the new split counts as well: when the second listing fails the split still exists, and
      // a pane that is not recorded is a pane nobody closes.
      const afterText = await listing()
      const after = afterText === undefined ? undefined : cmuxTokens(afterText)
      const known = new Set(before)
      const notOld = (t: string): boolean => !known.has(t) && !t.startsWith('workspace:')
      // The surface new-split names is the one it made. The listing difference is only for output that names none: a
      // surface a person or another tool opened between the two listings must never be taken for ours (close-surface
      // would later close it).
      const named = cmuxTokens(r.stdout).filter(notOld)
      let fresh = named.some(t => t.startsWith('surface:') || CMUX_UUID.test(t)) ? named : [...new Set([...named, ...(after ?? [])])].filter(notOld)
      // cmux prints the new surface as its ref alone (`OK surface:7`), while the pane's CMUX_SURFACE_ID is the UUID: the
      // worker binds by that UUID, so it comes from the listing line of the named ref. Only that line: a stranger's surface
      // is never taken for ours.
      if (afterText !== undefined && !fresh.some(t => CMUX_UUID.test(t))) {
        const same = fresh.filter(t => t.startsWith('surface:')).flatMap(t => cmuxLineOf(afterText, t))
        fresh = [...new Set([...fresh, ...same])]
        // Without the UUID the worker's CMUX_SURFACE_ID can never match the record: worth a line in the log.
        if (!fresh.some(t => CMUX_UUID.test(t))) log('warn', 'cmux: the listing shows no UUID for the new surface; its worker will have to resolve its pane at join', { fresh, listing: afterText.slice(0, 2000) })
      }
      if (fresh.length === 0) return undefined
      // The surface's UUID is what CMUX_SURFACE_ID carries in the pane: the one right after the new surface ref, else the last UUID.
      const lastSurface = fresh.map((t, i) => (t.startsWith('surface:') ? i : -1)).filter(i => i >= 0).at(-1)
      const uuids = fresh.filter(t => /^[0-9a-f-]{36}$/i.test(t))
      const afterRef = lastSurface !== undefined ? fresh.slice(lastSurface + 1).find(t => /^[0-9a-f-]{36}$/i.test(t)) : undefined
      const id = afterRef ?? uuids.at(-1) ?? fresh.find(t => t.startsWith('surface:')) ?? fresh[0]
      if (id === undefined) return undefined
      await x(['rename-tab', '--surface', id, '--', spec.title])
      return { id, ids: fresh, server }
    },
    async title(pane, text) { return (await x(['rename-tab', '--surface', pane.id, '--', text])).code === 0 },
    async mark() { return true },
    async clearMark(pane) { return (await x(['clear-notifications', '--surface', pane.id])).code === 0 },
    async focus(pane) {
      const ws = env['CMUX_WORKSPACE_ID']
      if (nonEmpty(ws)) await x(['select-workspace', '--workspace', ws])
      return (await x(['focus-panel', '--panel', pane.id])).code === 0
    },
    presence,
    async alive(pane) { return (await presence(pane)) === 'ok' },
    async close(pane) {
      const p = await presence(pane)
      if (p !== 'ok') return { ok: false, reason: p }
      // The worker's harness is still running in the surface (a worker never exits on its own), and without --force cmux
      // answers `confirmation_required` instead of closing. tmux's kill-pane and herdr's pane close kill the program too.
      const r = await x(['close-surface', '--surface', pane.id, '--force'])
      return r.code === 0 ? { ok: true } : refusal(r)
    },
    async handlesOf(id) {
      const text = await listing()
      return text === undefined ? undefined : cmuxLineOf(text, id)
    },
  }
}

/** The adapter for one multiplexer; cmux needs its CLI (PATH or the app bundle). */
export function muxAdapter(kind: MuxKind, env: Env, deps: MuxDeps = {}): MuxAdapterResult {
  const exec = deps.exec ?? defaultExec
  switch (kind) {
    case 'tmux': return { ok: true, adapter: tmuxAdapter(env, exec) }
    case 'herdr': return { ok: true, adapter: herdrAdapter(env, exec) }
    case 'herdr-app': return { ok: true, adapter: herdrAppAdapter(env, exec, deps.hcBin ?? hcBin(env)) }
    case 'cmux': {
      const bin = deps.cmuxBin ?? cmuxBin(env, deps.appBin)
      if (bin === undefined) return { ok: false, code: 'cmux_missing', message: `the cmux CLI was not found on PATH or at ${deps.appBin ?? CMUX_APP_BIN}; install the cmux CLI (cmux settings) or pass --mux tmux` }
      return { ok: true, adapter: cmuxAdapter(env, exec, bin) }
    }
    default: { const never: never = kind; return never }
  }
}
