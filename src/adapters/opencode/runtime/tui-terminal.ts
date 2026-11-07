// The OpenCode TUI owns the terminal: it emits the OSC notification `buracle work ask` left for the session (the
// server plugin and the CLI run without a controlling terminal) and shows a toast beside it.
import { takeTerminalSequence } from '../../../workflow/board-store'
import { writeSequence } from '../../../workflow/terminal-notify'

const HARNESS = 'opencode' as const

export interface TerminalEmitDeps {
  take?: (sid: string) => string | undefined
  tty?: string
  toast?: (message: string) => void
  env?: Readonly<Record<string, string | undefined>>
}

export const BOARD_TOAST = 'A task board worker in this session waits for your answer: see its question above.'

/** Emits the pending sequence once (tmux-wrapped under tmux); returns whether one was found. BURACLE_NO_NOTIFY=1 drops it without writing. */
export function emitBoardTerminal(sid: string | undefined, deps: TerminalEmitDeps = {}): boolean {
  if (sid === undefined) return false
  const take = deps.take ?? ((s: string) => takeTerminalSequence(HARNESS, s))
  const sequence = take(sid)
  if (sequence === undefined) return false
  const env = deps.env ?? process.env
  if (env['BURACLE_NO_NOTIFY'] === '1') return true
  writeSequence(sequence, env, deps.tty)
  deps.toast?.(BOARD_TOAST)
  return true
}
