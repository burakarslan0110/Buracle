// A notification for the terminal pane a worker runs in, sent once, by the one that owns the pane: herdr (told that the
// agent is blocked) or cmux (`cmux notify`) when the pane is theirs, else OSC 9 and OSC 777 on the controlling terminal
// (wrapped for tmux). The OSC sequence is also handed back, so a hook
// that cannot reach the terminal (Claude Code's `terminalSequence`) can emit it.
import { closeSync, openSync, writeSync } from 'node:fs'
import { run } from '../engine/proc'

export interface TerminalNote { title: string; body: string; agent?: string }
export interface TerminalNotifyDeps { tty?: string; spawn?: (argv: string[]) => Promise<number | undefined> }
/** Who announces the question: herdr or cmux (they notify on their own), or the terminal itself through an OSC sequence. */
export type NotifyRoute = 'herdr' | 'cmux' | 'osc'
export interface TerminalNotifyResult { sent: boolean; sequence: string; cmux: boolean; herdr: boolean; route: NotifyRoute }

export const TITLE_MAX = 80
export const BODY_MAX = 200
const ESC = '\x1b'
const BEL = '\x07'
// C0 and C1 control characters and the OSC field separator never enter an escape sequence.
const CONTROL = /[\u0000-\u001f\u007f-\u009f;]/g

export function cleanText(s: string, max: number): string {
  const one = s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** OSC 9 (iTerm2, WezTerm, cmux) followed by OSC 777 (urxvt, kitty, Ghostty, Windows Terminal). */
export function oscSequence(title: string, body: string): string {
  const t = cleanText(title, TITLE_MAX)
  const b = cleanText(body, BODY_MAX)
  return `${ESC}]9;${t}: ${b}${BEL}${ESC}]777;notify;${t};${b}${BEL}`
}

/** tmux passes a sequence to the outer terminal only inside a DCS wrapper with every ESC doubled (allow-passthrough on). */
export function tmuxWrap(sequence: string): string {
  return `${ESC}Ptmux;${sequence.split(ESC).join(`${ESC}${ESC}`)}${ESC}\\`
}

async function spawnQuietly(argv: string[]): Promise<number | undefined> {
  try {
    const r = await run(argv, { timeoutMs: 5000, env: { ...process.env } })
    return r.code
  } catch {
    return undefined
  }
}

function writeTty(path: string, text: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(path, 'w')
    writeSync(fd, text)
    return true
  } catch {
    return false
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch {  } }
  }
}

/**
 * Writes an OSC sequence to the terminal: the controlling terminal (BURACLE_TTY_PATH in tests, /dev/tty otherwise),
 * wrapped for tmux when TMUX is set. Every process that owns a terminal (the CLI, the OpenCode TUI, the omp
 * extension) writes through here. BURACLE_NO_NOTIFY=1 writes nothing; a process without a terminal fails quietly.
 */
export function writeSequence(sequence: string, env: Readonly<Record<string, string | undefined>>, tty?: string): boolean {
  if (env['BURACLE_NO_NOTIFY'] === '1') return false
  const inTmux = typeof env['TMUX'] === 'string' && env['TMUX'] !== ''
  return writeTty(tty ?? env['BURACLE_TTY_PATH'] ?? '/dev/tty', inTmux ? tmuxWrap(sequence) : sequence)
}

/**
 * Who announces a question asked in this terminal. herdr and cmux notify on their own (herdr plays its sound, shows its
 * badge and the toasts the user configured; cmux posts a banner), and both also read OSC sequences, so one alert is
 * enough: the one they own. The innermost one wins (herdr, then cmux); any other terminal gets the OSC sequence.
 */
export function notifyRoute(env: Readonly<Record<string, string | undefined>>): NotifyRoute {
  const pane = env['HERDR_PANE_ID']
  if (env['HERDR_ENV'] === '1' && typeof pane === 'string' && pane !== '') return 'herdr'
  const surface = env['CMUX_SURFACE_ID']
  if (typeof surface === 'string' && surface !== '') return 'cmux'
  return 'osc'
}

/**
 * Announces the note in this terminal, once (`notifyRoute`): in herdr by telling it the agent is blocked, with the question
 * (herdr then notifies the way the user set it up); in cmux through `cmux notify`; elsewhere with an OSC sequence on the
 * controlling terminal, and `sent` says whether it took it. `sequence` is what a hook that owns the terminal should
 * emit, empty when herdr or cmux took the note. BURACLE_NO_NOTIFY=1 sends nothing and runs nothing.
 */
export async function notifyTerminal(note: TerminalNote, env: Readonly<Record<string, string | undefined>>, deps: TerminalNotifyDeps = {}): Promise<TerminalNotifyResult> {
  const route = notifyRoute(env)
  const out: TerminalNotifyResult = { sent: false, sequence: route === 'osc' ? oscSequence(note.title, note.body) : '', cmux: false, herdr: false, route }
  if (env['BURACLE_NO_NOTIFY'] === '1') return out
  const spawn = deps.spawn ?? spawnQuietly
  const title = cleanText(note.title, TITLE_MAX)
  const body = cleanText(note.body, BODY_MAX)
  if (route === 'osc') {
    out.sent = writeSequence(out.sequence, env, deps.tty)
  } else if (route === 'cmux') {
    out.cmux = (await spawn(['cmux', 'notify', '--title', title, '--body', body])) === 0
  } else {
    out.herdr = (await spawn(['herdr', 'pane', 'report-agent', env['HERDR_PANE_ID'] as string, '--source', 'buracle', '--agent', note.agent ?? 'buracle', '--state', 'blocked', '--message', body])) === 0
  }
  return out
}
