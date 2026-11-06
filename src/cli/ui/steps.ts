import { cliVersion, type CommandIO } from '../router'
import { commandHeader, MARGIN, sectionHeading } from './frame'
import { liveList, type LiveList, type Outcome } from './live'
import { sectionMode } from './sections'
import { styleFor } from './style'

// What install and update show while they work: one line per step, a spinner on the running ones.
// Only on a terminal (stderr) that takes control codes: pipes, scripts, --json, NO_COLOR and TERM=dumb keep the
// output they always had.
export interface Steps {
  readonly live: boolean
  readonly list: LiveList
  title(command: string): void
  section(title: string): void
  start(id: string, label: string): void
  done(id: string, outcome: Outcome, label: string): void
  stop(): void
}

const quiet = (list: LiveList): Steps => ({ live: false, list, title() {}, section() {}, start() {}, done() {}, stop() {} })

// The command's header line goes first: on stderr above the live steps, else on stdout when that is a terminal.
export function progressSteps(io: Pick<CommandIO, 'stdout' | 'stderr' | 'flags'>, silent: boolean): Steps {
  const live = !silent && !io.flags.json && sectionMode(io.stderr).live
  const st = styleFor({ isTTY: live })
  const columns = io.stderr.columns ?? 100
  const list = liveList(io.stderr, st, { tty: live, columns })
  if (!live) {
    const steps = quiet(list)
    if (silent || io.flags.json || io.stdout.isTTY !== true) return steps
    return { ...steps, title: command => { io.stdout.write(`\n${commandHeader(styleFor(io.stdout), cliVersion(), command)}\n`) } }
  }
  return {
    live,
    list,
    title: command => list.note(`\n${commandHeader(st, cliVersion(), command)}\n`),
    section: title => list.note(sectionHeading(st, title, columns - 1)),
    start: (id, label) => list.start(id, label),
    done: (id, outcome, label) => list.finish(id, outcome, label),
    stop: () => list.stop(),
  }
}

export const NO_STEPS: Steps = quiet({ start() {}, update() {}, finish() {}, note() {}, stop() {} })

export type ResultState = 'ok' | 'warn' | 'err' | 'info'

// The result lines of a human command. In a terminal: one header line first, each result at the margin with the
// shared symbol, details under it. Elsewhere (a pipe, --json) the text it always had: no header, no symbol.
export interface ResultLines {
  readonly tty: boolean
  header(command: string): string
  top(state: ResultState, text: string): string
  sub(text: string): string
}

export function resultLines(io: Pick<CommandIO, 'flags'>, stream: { isTTY?: boolean }): ResultLines {
  if (stream.isTTY !== true || io.flags.json) return { tty: false, header: () => '', top: (_state, text) => text, sub: text => `  ${text}` }
  const st = styleFor(stream)
  const sym: Readonly<Record<ResultState, string>> = { ok: st.ok(st.sym.ok), warn: st.warn(st.sym.warn), err: st.err(st.sym.err), info: st.accent(st.sym.info) }
  return {
    tty: true,
    header: command => `\n${commandHeader(st, cliVersion(), command)}\n\n`,
    top: (state, text) => `${MARGIN}${sym[state]} ${text}`,
    sub: text => `${MARGIN}  ${text}`,
  }
}
