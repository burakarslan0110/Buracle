import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanText, notifyTerminal, oscSequence, tmuxWrap, writeSequence } from '../../src/workflow/terminal-notify'
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

describe('notifyTerminal', () => {
  test('writes the sequence to the tty (wrapped under tmux), calls cmux and herdr with their arguments, and reports what it did', () => withSandbox(async ({ root }) => {
    const tty = join(root, 'tty.out')
    const log = join(root, 'calls.log')
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    fakeExe(join(bin, 'cmux'), `append(${JSON.stringify(log)}, ['cmux', ...argv].join(' '))`)
    fakeExe(join(bin, 'herdr'), `append(${JSON.stringify(log)}, ['herdr', ...argv].join(' '))`)
    const env = { BURACLE_TTY_PATH: tty, CMUX_SURFACE_ID: 'surface-9', HERDR_ENV: '1', HERDR_PANE_ID: 'pane-3', PATH: narrowPath(bin) }
    const r = await withEnv({ PATH: env.PATH }, () => notifyTerminal({ title: 'Task 2 needs you', body: 'which port?', agent: 'codex' }, env))
    expect(r).toEqual({ sent: true, sequence: oscSequence('Task 2 needs you', 'which port?'), cmux: true, herdr: true })
    expect(readFileSync(tty, 'utf8')).toBe(oscSequence('Task 2 needs you', 'which port?'))
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'cmux notify --title Task 2 needs you --body which port?',
      'herdr notification show Task 2 needs you --body which port?',
      'herdr pane report-agent pane-3 --source buracle --agent codex --state blocked --message which port?',
    ])
    writeFileSync(tty, '')
    const t = await notifyTerminal({ title: 'T', body: 'B' }, { BURACLE_TTY_PATH: tty, TMUX: '/tmp/tmux-501/default,123,0' })
    expect(t).toMatchObject({ sent: true, cmux: false, herdr: false })
    expect(readFileSync(tty, 'utf8')).toBe(tmuxWrap(oscSequence('T', 'B')))
    expect(t.sequence).toBe(oscSequence('T', 'B'))
  }))

  test('no terminal, no cmux or herdr and BURACLE_NO_NOTIFY are quiet', async () => {
    const calls: string[][] = []
    const spawn = async (argv: string[]) => { calls.push(argv); return 0 }
    const none = await notifyTerminal({ title: 'T', body: 'B' }, { BURACLE_TTY_PATH: '/nonexistent/dir/tty' }, { spawn })
    expect(none).toMatchObject({ sent: false, cmux: false, herdr: false })
    expect(calls).toEqual([])
    const off = await notifyTerminal({ title: 'T', body: 'B' }, { BURACLE_NO_NOTIFY: '1', CMUX_SURFACE_ID: 'x', HERDR_ENV: '1', BURACLE_TTY_PATH: '/nonexistent/dir/tty' }, { spawn })
    expect(off).toMatchObject({ sent: false, cmux: false, herdr: false })
    expect(off.sequence).toBe(oscSequence('T', 'B'))
    expect(calls).toEqual([])
    const missing = await notifyTerminal({ title: 'T', body: 'B' }, { BURACLE_TTY_PATH: '/nonexistent/dir/tty', CMUX_SURFACE_ID: 'x' }, { spawn: async () => undefined })
    expect(missing.cmux).toBe(false)
  })
})
