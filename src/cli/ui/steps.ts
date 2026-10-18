import type { CommandIO } from '../router'
import { liveList, type LiveList, type Outcome } from './live'
import { heading, styleFor, wordmark } from './style'

// What install and update show while they work: one line per step, a spinner on the running ones.
// Only on a terminal (stderr): pipes, scripts and --json keep the output they always had.
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

export function progressSteps(io: Pick<CommandIO, 'stderr' | 'flags'>, silent: boolean): Steps {
  const live = !silent && !io.flags.json && io.stderr.isTTY === true
  const st = styleFor({ isTTY: live })
  const columns = io.stderr.columns ?? 100
  const list = liveList(io.stderr, st, { tty: live, columns })
  if (!live) return quiet(list)
  return {
    live,
    list,
    title: command => list.note(`\n  ${wordmark(st)} ${st.muted(command)}\n`),
    section: title => list.note(heading(st, title, columns)),
    start: (id, label) => list.start(id, label),
    done: (id, outcome, label) => list.finish(id, outcome, label),
    stop: () => list.stop(),
  }
}

export const NO_STEPS: Steps = quiet({ start() {}, update() {}, finish() {}, note() {}, stop() {} })
