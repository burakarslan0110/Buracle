// A notification for the terminal pane a worker runs in: OSC 9 and OSC 777 on the controlling terminal (wrapped for
// tmux), plus the cmux and herdr CLIs when their environment is present. The sequence is also handed back, so a hook
// that cannot reach the terminal (Claude Code's `terminalSequence`) can emit it.
import { closeSync, openSync, writeSync } from 'node:fs'
import { run } from '../engine/proc'

export interface TerminalNote { title: string; body: string; agent?: string }
export interface TerminalNotifyDeps { tty?: string; spawn?: (argv: string[]) => Promise<number | undefined> }
export interface TerminalNotifyResult { sent: boolean; sequence: string; cmux: boolean; herdr: boolean }

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
 * Sends the note to the terminal. `sent` says whether the controlling terminal took the sequence (`writeSequence`).
 * BURACLE_NO_NOTIFY=1 sends nothing and runs nothing.
 */
export async function notifyTerminal(note: TerminalNote, env: Readonly<Record<string, string | undefined>>, deps: TerminalNotifyDeps = {}): Promise<TerminalNotifyResult> {
  const sequence = oscSequence(note.title, note.body)
  const out: TerminalNotifyResult = { sent: false, sequence, cmux: false, herdr: false }
  if (env['BURACLE_NO_NOTIFY'] === '1') return out
  out.sent = writeSequence(sequence, env, deps.tty)
  const spawn = deps.spawn ?? spawnQuietly
  const title = cleanText(note.title, TITLE_MAX)
  const body = cleanText(note.body, BODY_MAX)
  if (typeof env['CMUX_SURFACE_ID'] === 'string' && env['CMUX_SURFACE_ID'] !== '') {
    out.cmux = (await spawn(['cmux', 'notify', '--title', title, '--body', body])) === 0
  }
  if (env['HERDR_ENV'] === '1') {
    out.herdr = (await spawn(['herdr', 'notification', 'show', title, '--body', body])) === 0
    const pane = env['HERDR_PANE_ID']
    if (typeof pane === 'string' && pane !== '') {
      await spawn(['herdr', 'pane', 'report-agent', pane, '--source', 'buracle', '--agent', note.agent ?? 'buracle', '--state', 'blocked', '--message', body])
    }
  }
  return out
}
