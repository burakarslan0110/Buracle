import { describe, expect, test } from 'bun:test'
import { createForwarder, cursorToArea, enterSequence, outputArea, ptySize, repaintSequence, replayBytes, type RunLayout } from '../../../src/cli/ui/run-screen'

const ESC = '\u001b'
const layout: RunLayout = { header: ['', '  ◉ buracle v0.8.0', '', '  ✔ All good', ''], footer: '  ctrl-c stop', columns: 80, rows: 24 }
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const dec = (chunks: ReadonlyArray<Uint8Array | string>): string => chunks.map(c => (typeof c === 'string' ? c : new TextDecoder().decode(c))).join('')

function fakeTimers() {
  const timers: Array<{ f: () => void, ms: number, cleared: boolean }> = []
  return {
    timers,
    setTimer: (f: () => void, ms: number): unknown => { const t = { f, ms, cleared: false }; timers.push(t); return t },
    clearTimer: (t: unknown) => { (t as { cleared: boolean }).cleared = true },
    fire: () => { for (const t of timers.filter(x => !x.cleared)) { t.cleared = true; t.f() } },
  }
}

function forwarder(maxCopy?: number) {
  const out: Array<Uint8Array | string> = []
  const repaints: Array<'footer' | 'all'> = []
  const timers = fakeTimers()
  const fwd = createForwarder({
    write: d => { out.push(d) },
    repaint: what => { repaints.push(what); out.push(`<repaint ${what}>`) },
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    ...(maxCopy !== undefined ? { maxCopy } : {}),
  })
  return { fwd, out, repaints, timers }
}

describe('run screen layout', () => {
  test('the output area lies between the header and the footer row, and the PTY gets its size', () => {
    expect(outputArea(layout)).toEqual({ top: 6, bottom: 23 })
    expect(ptySize(layout)).toEqual({ cols: 80, rows: 18 })
    expect(ptySize({ ...layout, rows: 6 })).toEqual({ cols: 80, rows: 1 })
    expect(ptySize({ ...layout, columns: 0 })).toEqual({ cols: 1, rows: 18 })
  })

  test('entering scrolls the old screen into the scrollback, then draws the header on its rows and the footer on the last row', () => {
    const s = enterSequence(layout)
    expect(s.startsWith(`${ESC}[r${ESC}[24;1H${'\r\n'.repeat(24)}`)).toBe(true)
    for (const [i, line] of layout.header.entries()) expect(s).toContain(`${ESC}[${i + 1};1H${line}${ESC}[K`)
    expect(s.endsWith(`${ESC}[24;1H  ctrl-c stop${ESC}[K`)).toBe(true)
    expect(cursorToArea(layout)).toBe(`${ESC}[6;1H`)
  })

  test('a repaint saves the cursor, draws the footer (and the header when asked) and restores the cursor', () => {
    expect(repaintSequence(layout, 'footer')).toBe(`${ESC}7${ESC}[24;1H  ctrl-c stop${ESC}[K${ESC}8`)
    const all = repaintSequence(layout, 'all')
    expect(all.startsWith(`${ESC}7${ESC}[1;1H${ESC}[K`)).toBe(true)
    expect(all).toContain(`${ESC}[2;1H  ◉ buracle v0.8.0${ESC}[K`)
    expect(all.endsWith(`${ESC}[24;1H  ctrl-c stop${ESC}[K${ESC}8`)).toBe(true)
  })
})

describe('run screen forwarder', () => {
  test('complete output goes to the terminal unchanged and into the copy', () => {
    const f = forwarder()
    f.fwd.feed(enc('hello\r\nwörld\r\n'))
    expect(dec(f.out)).toBe('hello\r\nwörld\r\n')
    expect(dec([f.fwd.copy()])).toBe('hello\r\nwörld\r\n')
    expect(f.repaints).toEqual([])
  })

  test('an erase below the cursor repaints the footer after the chunk; an erase above or of the screen repaints the header too', () => {
    const f = forwarder()
    f.fwd.feed(enc(`spin${ESC}[1A${ESC}[0Jnext\r\n`))
    expect(dec(f.out)).toBe(`spin${ESC}[1A${ESC}[0Jnext\r\n<repaint footer>`)
    for (const [ed, what] of [[`${ESC}[J`, 'footer'], [`${ESC}[1J`, 'all'], [`${ESC}[2J`, 'all']] as const) {
      const g = forwarder()
      g.fwd.feed(enc(`x${ed}`))
      expect(g.repaints).toEqual([what])
    }
    const h = forwarder()
    h.fwd.feed(enc(`${ESC}[2K${ESC}[31mred${ESC}[39m`))
    expect(h.repaints).toEqual([])
  })

  test('an escape sequence split across chunks is held back until it is complete, so a repaint never lands inside it', () => {
    const f = forwarder()
    f.fwd.feed(enc(`abc${ESC}[`))
    expect(dec(f.out)).toBe('abc')
    f.fwd.feed(enc('0Jdef'))
    expect(dec(f.out)).toBe(`abc${ESC}[0Jdef<repaint footer>`)
    expect(f.timers.timers.every(t => t.cleared)).toBe(true)
  })

  test('a UTF-8 character split across chunks is held back too', () => {
    const f = forwarder()
    f.fwd.feed(new Uint8Array([0x61, 0xc4]))
    expect(dec(f.out)).toBe('a')
    f.fwd.feed(new Uint8Array([0xb1, 0x62]))
    expect(dec(f.out)).toBe('aıb')
  })

  test('held bytes go out as they are after 50 ms, and at the end', () => {
    const f = forwarder()
    f.fwd.feed(enc(`${ESC}[1`))
    expect(f.out).toEqual([])
    expect(f.timers.timers.at(-1)?.ms).toBe(50)
    f.timers.fire()
    expect(dec(f.out)).toBe(`${ESC}[1`)
    const g = forwarder()
    g.fwd.feed(enc(`x${ESC}]0;title`))
    g.fwd.flush()
    expect(dec(g.out)).toBe(`x${ESC}]0;title`)
  })

  test('an unfinished tail longer than 64 bytes is not held', () => {
    const f = forwarder()
    const long = `${ESC}]0;${'t'.repeat(80)}`
    f.fwd.feed(enc(long))
    expect(dec(f.out)).toBe(long)
  })

  test('the replay drops terminal queries and keeps every other byte, UTF-8 with bytes 0x80 to 0x9f included', () => {
    const bytes = enc(`✖ 21 errors ${ESC}[6n· ok${ESC}[c ${ESC}[>0c—–\r\n`)
    expect(dec([replayBytes(bytes)])).toBe('✖ 21 errors · ok —–\r\n')
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(replayBytes(all)).toEqual(all)
  })

  test('an erase is found in output that holds bytes 0x80 to 0x9f', () => {
    const f = forwarder()
    f.fwd.feed(enc(`✖${ESC}[0J`))
    expect(f.repaints).toEqual(['footer'])
  })

  test('the copy keeps at most its limit and says so', () => {
    const f = forwarder(8)
    f.fwd.feed(enc('12345'))
    f.fwd.feed(enc('67890'))
    expect(dec([f.fwd.copy()])).toBe('12345678')
    expect(f.fwd.truncated()).toBe(true)
    expect(dec(f.out)).toBe('1234567890')
  })
})
