import { describe, expect, test } from 'bun:test'
import { createKeyDecoder, ESC_WAIT_MS, type Key } from '../../../src/cli/ui/keys'
import { openTerminal, type SignalHost, type TermIn, type TermOut } from '../../../src/cli/ui/terminal'

const ESC = '\u001b'
const ch = (c: string): Key => ({ char: c })

describe('key decoder', () => {
  test('one chunk can hold several keys', () => {
    const d = createKeyDecoder({ now: () => 0 })
    expect(d.feed('jjk')).toEqual([ch('j'), ch('j'), ch('k')])
    expect(d.feed(`${ESC}[A${ESC}[B`)).toEqual(['up', 'down'])
    expect(d.pending()).toBe(false)
  })

  test('arrows in CSI and SS3 form, Page Up and Down, Home and End in every form', () => {
    const d = createKeyDecoder({ now: () => 0 })
    expect(d.feed(`${ESC}[A${ESC}[B${ESC}[C${ESC}[D`)).toEqual(['up', 'down', 'right', 'left'])
    expect(d.feed(`${ESC}OA${ESC}OB${ESC}OC${ESC}OD`)).toEqual(['up', 'down', 'right', 'left'])
    expect(d.feed(`${ESC}[5~${ESC}[6~`)).toEqual(['pageup', 'pagedown'])
    expect(d.feed(`${ESC}[H${ESC}[F${ESC}[1~${ESC}[4~${ESC}OH${ESC}OF`)).toEqual(['home', 'end', 'home', 'end', 'home', 'end'])
    expect(d.feed(`${ESC}[1;5A`)).toEqual(['up'])
  })

  test('Enter, Tab, Backspace, Ctrl-C and Ctrl-D', () => {
    const d = createKeyDecoder({ now: () => 0 })
    expect(d.feed('\r\n\t\u007f\b\u0003\u0004')).toEqual(['enter', 'enter', 'tab', 'backspace', 'backspace', 'ctrl-c', 'ctrl-c'])
  })

  test('unknown CSI sequences are swallowed whole and never leak as characters', () => {
    const d = createKeyDecoder({ now: () => 0 })
    expect(d.feed(`a${ESC}[2;3Rb${ESC}[200~${ESC}[?1;2c${ESC}[3~${ESC}OPq`)).toEqual([ch('a'), ch('b'), ch('q')])
    expect(d.pending()).toBe(false)
  })

  test('a sequence split across chunks decodes as one key', () => {
    const d = createKeyDecoder({ now: () => 0 })
    expect(d.feed(`${ESC}[`, 0)).toEqual([])
    expect(d.pending()).toBe(true)
    expect(d.feed('5~', 5)).toEqual(['pageup'])
    expect(d.feed(ESC, 10)).toEqual([])
    expect(d.feed('[B', 20)).toEqual(['down'])
    expect(d.feed(`${ESC}O`, 30)).toEqual([])
    expect(d.feed('A', 31)).toEqual(['up'])
    expect(d.feed(`k${ESC}[1;`, 40)).toEqual([ch('k')])
    expect(d.feed('2B', 45)).toEqual(['down'])
    expect(d.pending()).toBe(false)
  })

  test('a lone ESC waits ESC_WAIT_MS: [ or O inside the wait joins it, a later feed or flush makes it Escape', () => {
    let t = 0
    const d = createKeyDecoder({ now: () => t })
    expect(d.feed(ESC)).toEqual([])
    expect(d.pending()).toBe(true)
    t = ESC_WAIT_MS - 1
    expect(d.feed('[A')).toEqual(['up'])

    t = 100
    expect(d.feed(ESC)).toEqual([])
    t = 100 + ESC_WAIT_MS
    expect(d.feed('[A')).toEqual(['escape', ch('['), ch('A')])

    expect(d.feed(ESC, 200)).toEqual([])
    expect(d.flush(200 + ESC_WAIT_MS - 1)).toEqual([])
    expect(d.pending()).toBe(true)
    expect(d.flush(200 + ESC_WAIT_MS)).toEqual(['escape'])
    expect(d.pending()).toBe(false)

    expect(d.feed(ESC, 300)).toEqual([])
    expect(d.feed('j', 301)).toEqual(['escape', ch('j')])

    expect(d.feed(`${ESC}${ESC}`, 400)).toEqual(['escape'])
    expect(d.flush()).toEqual(['escape'])
    expect(d.flush()).toEqual([])
  })

  test('an Alt or Option chord (ESC and a character in one read, as Option+Left sends ESC b) is no key, so it never quits', () => {
    const d = createKeyDecoder({ now: () => 0 })
    expect(d.feed(`${ESC}b`)).toEqual([])
    expect(d.feed(`${ESC}fj`)).toEqual([ch('j')])
    expect(d.pending()).toBe(false)
  })

  test('flush drops an unfinished sequence instead of leaking it', () => {
    const d = createKeyDecoder({ now: () => 0 })
    expect(d.feed(`${ESC}[1;`)).toEqual([])
    expect(d.flush()).toEqual([])
    expect(d.pending()).toBe(false)
  })

  test('text decodes by code point; other control characters are dropped', () => {
    const d = createKeyDecoder({ now: () => 0 })
    expect(d.feed('ıİ日\u{1F600}\u0001 G?')).toEqual([ch('ı'), ch('İ'), ch('日'), ch('\u{1F600}'), ch(' '), ch('G'), ch('?')])
  })
})

function fakeTerminal(size: { columns?: number, rows?: number } = {}) {
  const writes: string[] = []
  const events: string[] = []
  const data = new Set<(d: Buffer | string) => void>()
  const resize = new Set<() => void>()
  const signals = new Map<string, Set<() => void>>()
  const timers: Array<{ f: () => void, ms: number, cleared: boolean }> = []
  const exits: number[] = []
  const exitHooks = new Set<() => void>()
  const input: TermIn = {
    isTTY: true,
    setRawMode: on => { events.push(on ? 'raw on' : 'raw off') },
    on: (_ev, f) => { data.add(f) },
    off: (_ev, f) => { data.delete(f) },
    resume: () => { events.push('resume') },
    pause: () => { events.push('pause') },
  }
  const output: TermOut = {
    write: s => { writes.push(s) },
    ...size,
    on: (_ev, f) => { resize.add(f) },
    off: (_ev, f) => { resize.delete(f) },
  }
  const host: SignalHost = {
    on: (sig, f) => { const set = signals.get(sig) ?? new Set(); set.add(f); signals.set(sig, set) },
    off: (sig, f) => { signals.get(sig)?.delete(f) },
  }
  const term = openTerminal({
    input, output, signals: host, now: () => 0,
    setTimer: (f, ms) => { const t = { f, ms, cleared: false }; timers.push(t); return t },
    clearTimer: t => { (t as { cleared: boolean }).cleared = true },
    exit: code => { exits.push(code) },
    exitHost: { on: (_ev, f) => { exitHooks.add(f) }, off: (_ev, f) => { exitHooks.delete(f) } },
  })
  const listeners = () => data.size + resize.size + [...signals.values()].reduce((n, s) => n + s.size, 0)
  return {
    term, writes, events, timers, exits, listeners, exitHooks,
    type: (d: Buffer | string) => { for (const f of [...data]) f(d) },
    resizeTo: () => { for (const f of [...resize]) f() },
    signal: (sig: string) => { for (const f of [...signals.get(sig) ?? []]) f() },
    reading: () => data.size > 0,
  }
}

describe('terminal', () => {
  test('open turns raw mode on, enters the alternate screen and hides the cursor', () => {
    const f = fakeTerminal()
    expect(f.writes).toEqual(['\u001b[?1049h\u001b[?25l'])
    expect(f.events).toEqual(['raw on', 'resume'])
    expect(f.reading()).toBe(true)
  })

  test('draw homes the cursor, clears each line to its end and the rest of the screen', () => {
    const f = fakeTerminal()
    f.term.draw(['one', 'two'])
    expect(f.writes.at(-1)).toBe('\u001b[Hone\u001b[K\ntwo\u001b[J')
  })

  test('size comes from the output and defaults to 100 by 30', () => {
    expect(fakeTerminal({ columns: 72, rows: 18 }).term.size()).toEqual({ columns: 72, rows: 18 })
    expect(fakeTerminal().term.size()).toEqual({ columns: 100, rows: 30 })
  })

  test('nextKey yields decoded keys in order, also when a sequence or a UTF-8 character is split across chunks', async () => {
    const f = fakeTerminal()
    const first = f.term.nextKey()
    f.type(`${ESC}[`)
    f.type('A')
    f.type('jk')
    f.type(Buffer.from([0xc4]))
    f.type(Buffer.from([0xb1]))
    expect(await first).toBe('up')
    expect(await f.term.nextKey()).toEqual(ch('j'))
    expect(await f.term.nextKey()).toEqual(ch('k'))
    expect(await f.term.nextKey()).toEqual(ch('ı'))
  })

  test('a lone ESC becomes Escape when its ESC_WAIT_MS timer fires', async () => {
    const f = fakeTerminal()
    const key = f.term.nextKey()
    f.type(ESC)
    const timer = f.timers.at(-1)
    expect(timer?.ms).toBe(ESC_WAIT_MS)
    timer?.f()
    expect(await key).toBe('escape')
    f.type(ESC)
    f.type('[B')
    expect(f.timers.at(-1)?.cleared).toBe(true)
    expect(await f.term.nextKey()).toBe('down')
  })

  test('onResize callbacks run when the output reports a resize', () => {
    const f = fakeTerminal()
    let calls = 0
    f.term.onResize(() => { calls++ })
    f.resizeTo()
    expect(calls).toBe(1)
  })

  test('suspend leaves the screen for a child command and resume comes back', () => {
    const f = fakeTerminal()
    f.writes.length = 0
    f.events.length = 0
    f.term.suspend()
    expect(f.writes).toEqual(['\u001b[?1049l\u001b[?25h'])
    expect(f.events).toEqual(['raw off', 'pause'])
    expect(f.reading()).toBe(false)
    f.term.draw(['hidden'])
    expect(f.writes).toHaveLength(1)
    f.term.resume()
    expect(f.writes).toEqual(['\u001b[?1049l\u001b[?25h', '\u001b[?1049h\u001b[?25l'])
    expect(f.events).toEqual(['raw off', 'pause', 'raw on', 'resume'])
    expect(f.reading()).toBe(true)
  })

  test('anyKey while suspended reads one key in raw mode on the normal screen, then lets go of the input again', async () => {
    const f = fakeTerminal()
    f.term.suspend()
    f.writes.length = 0
    f.events.length = 0
    const key = f.term.anyKey()
    expect(f.events).toEqual(['raw on', 'resume'])
    expect(f.reading()).toBe(true)
    f.type('x')
    expect(await key).toEqual({ char: 'x' })
    expect(f.events).toEqual(['raw on', 'resume', 'raw off', 'pause'])
    expect(f.reading()).toBe(false)
    expect(f.writes).toEqual([])
    f.term.resume()
    const next = f.term.nextKey()
    f.type('j')
    expect(await next).toEqual({ char: 'j' })
  })

  test('close restores the terminal once and removes every listener', async () => {
    const f = fakeTerminal()
    f.term.onResize(() => {})
    const waiting = f.term.nextKey()
    expect(f.listeners()).toBe(4)
    f.writes.length = 0
    f.events.length = 0
    f.term.close()
    f.term.close()
    expect(f.writes).toEqual(['\u001b[r\u001b[?1049l\u001b[?25h'])
    expect(f.events).toEqual(['raw off', 'pause'])
    expect(f.listeners()).toBe(0)
    expect(await waiting).toBe('ctrl-c')
  })

  test('SIGTERM and SIGHUP close the terminal, then exit with 128 plus the signal number', () => {
    const term = fakeTerminal()
    term.writes.length = 0
    term.signal('SIGTERM')
    expect(term.writes).toEqual(['\u001b[r\u001b[?1049l\u001b[?25h'])
    expect(term.listeners()).toBe(0)
    expect(term.exits).toEqual([143])
    const hup = fakeTerminal()
    hup.signal('SIGHUP')
    expect(hup.writes.at(-1)).toBe('\u001b[r\u001b[?1049l\u001b[?25h')
    expect(hup.exits).toEqual([129])
  })

  test('passthrough while suspended hands every raw chunk on undecoded, in raw mode, until it is turned off', async () => {
    const f = fakeTerminal()
    f.term.suspend()
    f.events.length = 0
    const got: Array<Buffer | string> = []
    f.term.passthrough(d => { got.push(d) })
    expect(f.events).toEqual(['raw on', 'resume'])
    f.type(`${ESC}[A`)
    f.type('\u0003')
    f.type(Buffer.from([0xc4]))
    expect(got).toEqual([`${ESC}[A`, '\u0003', Buffer.from([0xc4])])
    expect(f.timers).toHaveLength(0) // no key decoding, so no wait for a lone ESC either
    f.term.passthrough(undefined)
    expect(f.events).toEqual(['raw on', 'resume', 'raw off', 'pause'])
    f.type('x')
    expect(got).toHaveLength(3)
    const key = f.term.anyKey()
    f.type('y')
    expect(await key).toEqual(ch('y'))
    f.term.resume()
    const next = f.term.nextKey()
    f.type('j')
    expect(await next).toEqual(ch('j'))
  })

  test('SIGTERM during a passthrough closes the terminal once, below the output, and exits with 143', () => {
    const f = fakeTerminal({ columns: 80, rows: 24 })
    f.term.suspend()
    f.term.passthrough(() => {})
    f.writes.length = 0
    f.signal('SIGTERM')
    f.signal('SIGTERM')
    expect(f.writes).toEqual(['\u001b[r\u001b[24;1H\r\n'])
    expect(f.exits).toEqual([143])
    expect(f.listeners()).toBe(0)
  })

  test('onClose callbacks run once before the terminal is restored; an unsubscribed one does not run', () => {
    const f = fakeTerminal()
    const calls: string[] = []
    f.term.onClose(() => { calls.push(`a:${f.writes.length}`) })
    const off = f.term.onClose(() => { calls.push('b') })
    off()
    const before = f.writes.length
    f.signal('SIGTERM')
    f.term.close()
    expect(calls).toEqual([`a:${before}`])
    expect(f.exits).toEqual([143])
  })

  test('a scroll region keeps an exit hook that resets it; resetting the region removes the hook', () => {
    const f = fakeTerminal({ columns: 80, rows: 24 })
    f.term.suspend()
    f.writes.length = 0
    f.term.region({ top: 12, bottom: 23 })
    expect(f.writes).toEqual(['\u001b[12;23r'])
    expect(f.exitHooks.size).toBe(1)
    for (const hook of f.exitHooks) hook()
    expect(f.writes.at(-1)).toBe('\u001b[r')
    f.term.region()
    expect(f.writes.at(-1)).toBe('\u001b[r')
    expect(f.exitHooks.size).toBe(0)
  })

  test('close while suspended resets the region and puts the cursor on a new line at the bottom, without leaving a screen', () => {
    const f = fakeTerminal({ columns: 80, rows: 24 })
    f.term.suspend()
    f.term.region({ top: 12, bottom: 23 })
    f.writes.length = 0
    f.term.close()
    expect(f.writes).toEqual(['\u001b[r\u001b[24;1H\r\n'])
    expect(f.exitHooks.size).toBe(0)
    expect(f.listeners()).toBe(0)
  })
})
