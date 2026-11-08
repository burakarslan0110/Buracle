import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanText, notifyRoute, notifyTerminal, oscSequence, tmuxWrap, writeSequence } from '../../src/workflow/terminal-notify'
import { fakeExe, narrowPath } from '../helpers/fake-exe'
import { withEnv, withSandbox } from '../helpers/sandbox'

const ESC = '\x1b'
const BEL = '\x07'

describe('the escape sequences', () => {
  test('OSC 9 then OSC 777, with control characters and semicolons removed and the texts capped', () => {
    expect(oscSequence('Task 2 needs you', 'which port?')).toBe(`${ESC}]9;Task 2 needs you: which port?${BEL}${ESC}]777;notify;Task 2 needs you;which port?${BEL}`)
    const hostile = `which ${ESC}]52;c;aGVsbG8=${BEL} port; now\n please`
    const seq = oscSequence('T', hostile)
    expect(seq.split(ESC)).toHaveLength(3)
    expect(seq).not.toContain(`${ESC}]52`)
    expect(seq.split(BEL)).toHaveLength(3)
    expect(seq).toContain('which ]52 c aGVsbG8= port now please')
    expect(cleanText('x'.repeat(300), 200)).toHaveLength(200)
    expect(cleanText('x'.repeat(300), 200).endsWith('…')).toBe(true)
    expect(cleanText('  a \t b  ', 80)).toBe('a b')
  })

  test('tmuxWrap doubles every ESC inside the DCS passthrough', () => {
    const inner = oscSequence('T', 'B')
    const wrapped = tmuxWrap(inner)
    expect(wrapped.startsWith(`${ESC}Ptmux;${ESC}${ESC}]9;`)).toBe(true)
    expect(wrapped.endsWith(`${ESC}\\`)).toBe(true)
    expect(wrapped.split(`${ESC}${ESC}`)).toHaveLength(3)
  })
})

describe('writeSequence', () => {
  test('writes to BURACLE_TTY_PATH as is, tmux-wrapped under TMUX, nothing under BURACLE_NO_NOTIFY=1, and fails quietly without a terminal', () => withSandbox(({ root }) => {
    const seq = oscSequence('T', 'B')
    const plain = join(root, 'plain.bin')
    expect(writeSequence(seq, { BURACLE_TTY_PATH: plain })).toBe(true)
    expect(readFileSync(plain, 'utf8')).toBe(seq)
    const wrapped = join(root, 'tmux.bin')
    expect(writeSequence(seq, { BURACLE_TTY_PATH: wrapped, TMUX: '/tmp/tmux-501/default,1,0' })).toBe(true)
    expect(readFileSync(wrapped, 'utf8')).toBe(tmuxWrap(seq))
    const explicit = join(root, 'explicit.bin')
    expect(writeSequence(seq, { BURACLE_TTY_PATH: plain, TMUX: 'x' }, explicit)).toBe(true)
    expect(readFileSync(explicit, 'utf8')).toBe(tmuxWrap(seq))
    const quiet = join(root, 'quiet.bin')
    expect(writeSequence(seq, { BURACLE_TTY_PATH: quiet, BURACLE_NO_NOTIFY: '1' })).toBe(false)
    expect(existsSync(quiet)).toBe(false)
    expect(writeSequence(seq, { BURACLE_TTY_PATH: join(root, 'missing', 'tty') })).toBe(false)
  }))
})

describe('notifyRoute', () => {
  test('herdr and cmux own the notification of their panes (herdr first); every other terminal gets the OSC sequence', () => {
    expect(notifyRoute({ HERDR_ENV: '1', HERDR_PANE_ID: 'w2:p1', CMUX_SURFACE_ID: 'x', TMUX: '/t,1,0' })).toBe('herdr')
    expect(notifyRoute({ CMUX_SURFACE_ID: 'x', TMUX: '/t,1,0' })).toBe('cmux')
    expect(notifyRoute({ TMUX: '/t,1,0' })).toBe('osc')
    expect(notifyRoute({})).toBe('osc')
    // herdr without its pane id cannot be told anything.
    expect(notifyRoute({ HERDR_ENV: '1' })).toBe('osc')
  })
})

// One alert per question. herdr plays its own sound and badge when an agent needs input, and shows toasts as the user
// configured them (ui.toast.delivery); cmux posts its own banner. Adding an OSC sequence, a toast and a desktop banner
// on top made the same question announce itself three or four times.
describe('notifyTerminal', () => {
  const HERDR = { HERDR_ENV: '1', HERDR_PANE_ID: 'w2:p3', HERDR_SOCKET_PATH: '/s/herdr.sock' }
  const note = { title: 'Task 2 needs you', body: 'which port?', agent: 'codex' }
  const recorder = (code = 0): { calls: string[][], spawn: (argv: string[]) => Promise<number> } => {
    const calls: string[][] = []
    return { calls, spawn: async argv => { calls.push(argv); return code } }
  }

  test('inside herdr it reports the agent as blocked with the question and sends nothing else: no OSC, no toast', () => withSandbox(async ({ root }) => {
    const tty = join(root, 'tty.out')
    const { calls, spawn } = recorder()
    const r = await notifyTerminal(note, { ...HERDR, BURACLE_TTY_PATH: tty }, { spawn })
    expect(r).toEqual({ sent: false, sequence: '', cmux: false, herdr: true, route: 'herdr' })
    expect(existsSync(tty)).toBe(false)
    expect(calls).toEqual([['herdr', 'pane', 'report-agent', 'w2:p3', '--source', 'buracle', '--agent', 'codex', '--state', 'blocked', '--message', 'which port?']])
    expect(calls.flat()).not.toContain('notification')
    // herdr that does not answer is reported as such, so the caller can fall back to a desktop banner.
    expect((await notifyTerminal(note, { ...HERDR, BURACLE_TTY_PATH: tty }, { spawn: recorder(1).spawn })).herdr).toBe(false)
  }))

  test('inside cmux it asks cmux for the notification and writes no OSC sequence (cmux reads OSC 9 too)', () => withSandbox(async ({ root }) => {
    const tty = join(root, 'tty.out')
    const { calls, spawn } = recorder()
    const r = await notifyTerminal(note, { CMUX_SURFACE_ID: 'surface-9', TMUX: '/t,1,0', BURACLE_TTY_PATH: tty }, { spawn })
    expect(r).toEqual({ sent: false, sequence: '', cmux: true, herdr: false, route: 'cmux' })
    expect(existsSync(tty)).toBe(false)
    expect(calls).toEqual([['cmux', 'notify', '--title', 'Task 2 needs you', '--body', 'which port?']])
  }))

  test('anywhere else it writes the OSC sequence (wrapped under tmux) to the terminal and runs no multiplexer command', () => withSandbox(async ({ root }) => {
    const tty = join(root, 'tty.out')
    const { calls, spawn } = recorder()
    const plain = await notifyTerminal(note, { BURACLE_TTY_PATH: tty }, { spawn })
    expect(plain).toEqual({ sent: true, sequence: oscSequence('Task 2 needs you', 'which port?'), cmux: false, herdr: false, route: 'osc' })
    expect(readFileSync(tty, 'utf8')).toBe(oscSequence('Task 2 needs you', 'which port?'))
    writeFileSync(tty, '')
    const t = await notifyTerminal({ title: 'T', body: 'B' }, { BURACLE_TTY_PATH: tty, TMUX: '/tmp/tmux-501/default,123,0' }, { spawn })
    expect(t).toMatchObject({ sent: true, cmux: false, herdr: false, route: 'osc' })
    expect(readFileSync(tty, 'utf8')).toBe(tmuxWrap(oscSequence('T', 'B')))
    expect(t.sequence).toBe(oscSequence('T', 'B'))
    expect(calls).toEqual([])
  }))

  test('no terminal, no cmux or herdr and BURACLE_NO_NOTIFY are quiet', async () => {
    const { calls, spawn } = recorder()
    const none = await notifyTerminal({ title: 'T', body: 'B' }, { BURACLE_TTY_PATH: '/nonexistent/dir/tty' }, { spawn })
    expect(none).toMatchObject({ sent: false, cmux: false, herdr: false })
    expect(calls).toEqual([])
    const off = await notifyTerminal({ title: 'T', body: 'B' }, { BURACLE_NO_NOTIFY: '1', ...HERDR, BURACLE_TTY_PATH: '/nonexistent/dir/tty' }, { spawn })
    expect(off).toMatchObject({ sent: false, cmux: false, herdr: false, route: 'herdr', sequence: '' })
    const offOsc = await notifyTerminal({ title: 'T', body: 'B' }, { BURACLE_NO_NOTIFY: '1', BURACLE_TTY_PATH: '/nonexistent/dir/tty' }, { spawn })
    expect(offOsc).toMatchObject({ sent: false, route: 'osc' })
    expect(offOsc.sequence).toBe(oscSequence('T', 'B'))
    expect(calls).toEqual([])
    const missing = await notifyTerminal({ title: 'T', body: 'B' }, { CMUX_SURFACE_ID: 'x' }, { spawn: async () => undefined })
    expect(missing.cmux).toBe(false)
  })

  test('the real herdr and cmux programs are run with the same arguments (a fake executable on PATH)', () => withSandbox(async ({ root }) => {
    const log = join(root, 'calls.log')
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    fakeExe(join(bin, 'cmux'), `append(${JSON.stringify(log)}, ['cmux', ...argv].join(' '))`)
    fakeExe(join(bin, 'herdr'), `append(${JSON.stringify(log)}, ['herdr', ...argv].join(' '))`)
    await withEnv({ PATH: narrowPath(bin) }, async () => {
      await notifyTerminal(note, { ...HERDR, BURACLE_TTY_PATH: join(root, 'tty.out') })
      await notifyTerminal(note, { CMUX_SURFACE_ID: 'surface-9', BURACLE_TTY_PATH: join(root, 'tty.out') })
    })
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'herdr pane report-agent w2:p3 --source buracle --agent codex --state blocked --message which port?',
      'cmux notify --title Task 2 needs you --body which port?',
    ])
  }))
})
