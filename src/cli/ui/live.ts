import type { Style } from './style'
import { stripAnsi } from './style'

export interface LiveWriter { write(s: string): void }

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export type Outcome = 'ok' | 'warn' | 'err' | 'info' | 'skip'

export interface LiveList {
  start(id: string, label: string): void
  update(id: string, label: string): void
  finish(id: string, outcome: Outcome, label: string): void
  note(line: string): void
  stop(): void
}

export function liveList(out: LiveWriter, st: Style, opts: { tty: boolean, indent?: string, columns?: number }): LiveList {
  const indent = opts.indent ?? '  '
  const running = new Map<string, string>()
  let drawn = 0
  let frame = 0
  let timer: ReturnType<typeof setInterval> | undefined
  const cols = Math.max(20, (opts.columns ?? 100) - 1)
  const fit = (s: string): string => {
    const plain = stripAnsi(s)
    return plain.length <= cols ? s : plain.slice(0, cols - 1) + '…'
  }
  const clear = () => {
    if (!opts.tty || drawn === 0) return
    out.write(`\u001b[${drawn}A\u001b[0J`)
    drawn = 0
  }
  const draw = () => {
    if (!opts.tty) return
    clear()
    const f = st.accent(FRAMES[frame % FRAMES.length] ?? '-')
    const lines = [...running.values()].map(l => fit(`${indent}${f} ${l}`))
    if (lines.length > 0) out.write(lines.join('\n') + '\n')
    drawn = lines.length
  }
  const icon = (o: Outcome): string => o === 'ok' ? st.ok(st.sym.ok) : o === 'warn' ? st.warn(st.sym.warn) : o === 'err' ? st.err(st.sym.err) : o === 'skip' ? st.muted('-') : st.accent(st.sym.info)
  const ensureTimer = () => {
    if (!opts.tty || timer !== undefined) return
    timer = setInterval(() => { frame++; draw() }, 90)
  }
  return {
    start(id, label) { running.set(id, label); ensureTimer(); draw() },
    update(id, label) { if (running.has(id)) { running.set(id, label); draw() } },
    finish(id, outcome, label) {
      running.delete(id)
      clear()
      out.write(`${indent}${icon(outcome)} ${opts.tty ? fit(label) : stripAnsi(label)}\n`)
      draw()
    },
    note(line) { clear(); out.write(line + '\n'); draw() },
    stop() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      clear()
      running.clear()
    },
  }
}
