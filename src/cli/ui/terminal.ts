import { createKeyDecoder, ESC_WAIT_MS, type Key } from './keys'

export interface TermIn {
  isTTY?: boolean
  setRawMode?(on: boolean): unknown
  on(ev: 'data', f: (d: Buffer | string) => void): unknown
  off(ev: 'data', f: (d: Buffer | string) => void): unknown
  resume(): unknown
  pause(): unknown
}

export interface TermOut {
  write(s: string): unknown
  columns?: number
  rows?: number
  on?(ev: 'resize', f: () => void): unknown
  off?(ev: 'resize', f: () => void): unknown
}

export interface SignalHost {
  on(sig: 'SIGTERM' | 'SIGHUP', f: () => void): unknown
  off(sig: 'SIGTERM' | 'SIGHUP', f: () => void): unknown
}

export interface Terminal {
  size(): { columns: number; rows: number }
  draw(lines: string[]): void
  // After close it resolves with 'ctrl-c', so a loop still waiting for a key ends.
  nextKey(): Promise<Key>
  // While suspended: one key on the normal screen (under a finished child command); the screen stays as it is.
  anyKey(): Promise<Key>
  onResize(f: () => void): void
  suspend(): void
  resume(): void
  close(): void
}

const ENTER_SCREEN = '\u001b[?1049h\u001b[?25l'
const LEAVE_SCREEN = '\u001b[?1049l\u001b[?25h'
const DEFAULT_SIZE = { columns: 100, rows: 30 } as const
const SIGNAL_NUMBER = { SIGHUP: 1, SIGTERM: 15 } as const

export function openTerminal(o: {
  input: TermIn
  output: TermOut
  signals?: SignalHost
  now?: () => number
  setTimer?: (f: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  exit?: (code: number) => void
}): Terminal {
  const signals: SignalHost = o.signals ?? process
  const exit = o.exit ?? ((code: number) => { process.exit(code) })
  const setTimer = o.setTimer ?? ((f: () => void, ms: number): unknown => setTimeout(f, ms))
  const clearTimer = o.clearTimer ?? ((t: unknown) => { clearTimeout(t as ReturnType<typeof setTimeout>) })
  const decoder = createKeyDecoder(o.now !== undefined ? { now: o.now } : {})
  const utf8 = new TextDecoder()
  const queue: Key[] = []
  const waiting: Array<(k: Key) => void> = []
  const resizers: Array<() => void> = []
  let timer: unknown
  let reading = false
  let suspended = false
  let closed = false

  const deliver = (keys: readonly Key[]): void => {
    for (const k of keys) {
      const w = waiting.shift()
      if (w !== undefined) w(k)
      else queue.push(k)
    }
  }
  const stopTimer = (): void => {
    if (timer === undefined) return
    clearTimer(timer)
    timer = undefined
  }
  const onData = (d: Buffer | string): void => {
    stopTimer()
    deliver(decoder.feed(typeof d === 'string' ? d : utf8.decode(d, { stream: true })))
    if (decoder.pending()) {
      timer = setTimer(() => {
        timer = undefined
        deliver(decoder.flush())
      }, ESC_WAIT_MS)
    }
  }
  const onOutputResize = (): void => { for (const f of [...resizers]) f() }
  const startReading = (): void => {
    if (reading) return
    reading = true
    o.input.on('data', onData)
    o.input.resume()
  }
  const stopReading = (): void => {
    if (!reading) return
    reading = false
    o.input.off('data', onData)
    o.input.pause()
  }
  const onSignal = (sig: keyof typeof SIGNAL_NUMBER) => (): void => {
    close()
    exit(128 + SIGNAL_NUMBER[sig])
  }
  const onTerm = onSignal('SIGTERM')
  const onHup = onSignal('SIGHUP')

  function close(): void {
    if (closed) return
    closed = true
    stopTimer()
    o.input.setRawMode?.(false)
    o.output.write(LEAVE_SCREEN)
    stopReading()
    o.output.off?.('resize', onOutputResize)
    signals.off('SIGTERM', onTerm)
    signals.off('SIGHUP', onHup)
    for (const w of waiting.splice(0)) w('ctrl-c')
  }

  o.input.setRawMode?.(true)
  o.output.write(ENTER_SCREEN)
  startReading()
  o.output.on?.('resize', onOutputResize)
  signals.on('SIGTERM', onTerm)
  signals.on('SIGHUP', onHup)

  function nextKey(): Promise<Key> {
    const k = queue.shift()
    if (k !== undefined) return Promise.resolve(k)
    if (closed) return Promise.resolve<Key>('ctrl-c')
    return new Promise<Key>(resolve => { waiting.push(resolve) })
  }

  return {
    size() {
      const { columns, rows } = o.output
      return {
        columns: columns !== undefined && columns > 0 ? columns : DEFAULT_SIZE.columns,
        rows: rows !== undefined && rows > 0 ? rows : DEFAULT_SIZE.rows,
      }
    },
    draw(lines) {
      if (closed || suspended) return
      o.output.write(`\u001b[H${lines.join('\u001b[K\n')}\u001b[J`)
    },
    nextKey,
    anyKey() {
      if (closed) return Promise.resolve<Key>('ctrl-c')
      if (!suspended) return nextKey()
      queue.length = 0 // keys typed before the child command started are not the answer
      o.input.setRawMode?.(true)
      startReading()
      return new Promise<Key>(resolve => {
        waiting.push(k => {
          if (!closed && suspended) {
            stopTimer()
            decoder.flush()
            o.input.setRawMode?.(false)
            stopReading()
          }
          resolve(k)
        })
      })
    },
    onResize(f) { resizers.push(f) },
    suspend() {
      if (closed || suspended) return
      suspended = true
      stopTimer()
      decoder.flush() // a half-read key from before the child command is dropped, never delivered after it
      o.input.setRawMode?.(false)
      o.output.write(LEAVE_SCREEN)
      stopReading()
    },
    resume() {
      if (closed || !suspended) return
      suspended = false
      o.input.setRawMode?.(true)
      o.output.write(ENTER_SCREEN)
      startReading()
    },
    close,
  }
}
