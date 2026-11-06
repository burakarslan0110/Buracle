import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runDashboard, type DashData, type DashSource } from '../../src/cli/dashboard'
import type { Key } from '../../src/cli/ui/keys'
import { makeStyle } from '../../src/cli/ui/style'
import type { Terminal } from '../../src/cli/ui/terminal'
import { withSandbox } from '../helpers/sandbox'

// These run real child processes in a real Bun PTY: the parts a fake cannot prove (a TTY for the child, the
// question answered through the passthrough, Ctrl-C turned into SIGINT by the PTY, the output forwarded).

const plain = makeStyle(0, { unicode: false })
const ESC = '\u001b'

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

function harness(script: string) {
  const keys: Key[] = []
  let waiter: ((k: Key) => void) | undefined
  let pass: ((d: Buffer | string) => void) | undefined
  const events: string[] = []
  let out = ''
  const next = (): Promise<Key> => {
    const k = keys.shift()
    return k !== undefined ? Promise.resolve(k) : new Promise<Key>(r => { waiter = r })
  }
  const term: Terminal = {
    size: () => ({ columns: 80, rows: 24 }),
    draw: () => {  },
    nextKey: () => { events.push('nextKey'); return next() },
    anyKey: () => { events.push('anyKey'); return next() },
    onResize: () => {  },
    suspend: () => {  },
    resume: () => {  },
    passthrough: f => { pass = f },
    onClose: () => () => {  },
    region: () => {  },
    close: () => {  },
  }
  const press = (k: Key): void => {
    const w = waiter
    waiter = undefined
    if (w !== undefined) w(k)
    else keys.push(k)
  }
  const source: DashSource = { read: (): DashData => ({ version: '0.8.0', rows: [] }), fill: async () => {  } }
  const done = runDashboard({
    terminal: term, now: () => 0, source, command: [process.execPath, script], style: plain,
    shim: () => undefined, env: { ...process.env }, write: s => { out += typeof s === 'string' ? s : new TextDecoder().decode(s) },
  })
  return { press, done, events, out: () => out, typeIn: (d: string) => { pass?.(d) }, passing: () => pass !== undefined, waiting: () => waiter !== undefined }
}

function childScript(root: string, name: string, body: string): string {
  mkdirSync(root, { recursive: true })
  const file = join(root, name)
  writeFileSync(file, body)
  return file
}

describe('a menu command in a real PTY', () => {
  test('a split escape sequence the command leaves hanging goes out while it still runs', () => withSandbox(async ({ root }) => {
    const script = childScript(root, 'stall.ts', `
process.stdout.write('before${ESC}[1')
setTimeout(() => process.exit(0), 3_000)
`)
    const h = harness(script)
    await until(h.waiting, 'the first key')
    h.press({ char: 'd' })
    await until(() => h.out().includes('before'), 'the first output')
    // The forwarder releases what it held after 50 ms; the command is still running for seconds.
    await until(() => h.out().includes(`before${ESC}[1`), 'the held bytes', 1_000)
    expect(h.events).not.toContain('anyKey')
    await until(() => h.events.includes('anyKey'), 'the key prompt')
    h.press({ char: 'x' })
    await until(() => h.events.filter(e => e === 'nextKey').length === 2, 'the menu again')
    h.press({ char: 'q' })
    expect(await h.done).toBe(0)
  }), 30_000)

  test('the command sees a terminal of the output area, gets its answer through the passthrough and exits 0', () => withSandbox(async ({ root }) => {
    const script = childScript(root, 'ask.ts', `
process.stdout.write('tty=' + process.stdout.isTTY + ' stdin=' + process.stdin.isTTY + ' size=' + process.stdout.columns + 'x' + process.stdout.rows + '\\n')
process.stdout.write('Go on? [Y/n] ')
process.stdin.once('data', d => { process.stdout.write('answer=' + String(d).trim() + '\\n'); process.exit(0) })
`)
    const h = harness(script)
    await until(h.waiting, 'the first key')
    h.press({ char: 'd' })
    await until(() => h.out().includes('Go on? [Y/n]'), 'the question')
    h.typeIn('y\r')
    await until(() => h.events.includes('anyKey'), 'the key prompt')
    // The plain header at 80 by 24 has 5 lines, so the area between it and the footer row has 24 - 5 - 1 rows.
    expect(h.out()).toContain('tty=true stdin=true size=80x18')
    expect(h.out()).toContain('answer=y')
    expect(h.out()).toContain('  + buracle doctor: done')
    h.press({ char: 'x' })
    await until(() => h.events.filter(e => e === 'nextKey').length === 2, 'the menu again')
    h.press({ char: 'q' })
    expect(await h.done).toBe(0)
  }), 30_000)

  test('Ctrl-C typed while the command runs reaches it as SIGINT; the menu stays open', () => withSandbox(async ({ root }) => {
    const script = childScript(root, 'wait.ts', `
process.on('SIGINT', () => { process.stdout.write('got SIGINT\\n'); process.exit(130) })
process.stdout.write('waiting\\n')
setTimeout(() => process.exit(0), 20_000)
`)
    const h = harness(script)
    await until(h.waiting, 'the first key')
    h.press({ char: 'u' })
    await until(() => h.out().includes('waiting'), 'the child')
    h.typeIn('\u0003')
    await until(() => h.events.includes('anyKey'), 'the key prompt')
    expect(h.out()).toContain('got SIGINT')
    expect(h.out()).toContain('  x buracle update: failed (exit code 130)')
    h.press({ char: 'x' })
    await until(() => h.events.filter(e => e === 'nextKey').length === 2, 'the menu again')
    h.press({ char: 'q' })
    expect(await h.done).toBe(0)
  }), 30_000)

  test('an erase the command writes is followed by a repaint of the footer', () => withSandbox(async ({ root }) => {
    const script = childScript(root, 'erase.ts', `
process.stdout.write('one\\r\\n${ESC}[1A${ESC}[0Jtwo\\r\\n')
setTimeout(() => process.exit(0), 100)
`)
    const h = harness(script)
    await until(h.waiting, 'the first key')
    h.press({ char: 'd' })
    await until(() => h.events.includes('anyKey'), 'the key prompt')
    const out = h.out()
    const erase = out.indexOf(`${ESC}[1A${ESC}[0J`)
    expect(erase).toBeGreaterThan(-1)
    // ESC 7, the footer on the last row (24), ESC 8.
    expect(out.indexOf(`${ESC}7${ESC}[24;1H  ctrl-c stop${ESC}[K${ESC}8`, erase)).toBeGreaterThan(erase)
    h.press({ char: 'x' })
    await until(() => h.events.filter(e => e === 'nextKey').length === 2, 'the menu again')
    h.press({ char: 'q' })
    expect(await h.done).toBe(0)
  }), 30_000)
})
