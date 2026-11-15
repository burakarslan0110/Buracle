import { describe, expect, test } from 'bun:test'
import { menuFits, runMenu } from '../../src/cli/menu'
import type { Key } from '../../src/cli/ui/keys'
import { makeStyle } from '../../src/cli/ui/style'
import type { Terminal } from '../../src/cli/ui/terminal'

function fakeTerminal(keys: Key[]) {
  const events: string[] = []
  const frames: string[][] = []
  const terminal: Terminal = {
    size: () => ({ columns: 80, rows: 24 }),
    draw: lines => { frames.push(lines) },
    nextKey: async () => keys.shift() ?? 'ctrl-c',
    onResize: () => {  },
    close: () => { events.push('close') },
  }
  return { terminal, events, frames }
}

const plain = makeStyle(0, { unicode: false })

describe('the main menu', () => {
  test('it shows the choices and the waiting updates; Enter closes the menu, runs the selected command and returns its exit code', async () => {
    const f = fakeTerminal(['down', 'enter'])
    const code = await runMenu({ terminal: f.terminal, version: '0.5.0', updates: 2, checkedAt: '3 min ago', style: plain, run: async argv => { f.events.push(`run ${argv.join(' ')}`); return 2 } })
    expect(code).toBe(2)
    expect(f.events).toEqual(['close', 'run update'])
    expect(f.frames[0]?.join('\n')).toContain('2 updates waiting · updates checked 3 min ago')
    expect(f.frames[0]?.join('\n')).toContain('> Install or repair')
    expect(f.frames.at(-1)?.join('\n')).toContain('> Update')
  })

  test('q, Escape and Ctrl-C quit with 0 and run nothing; the terminal comes back', async () => {
    for (const key of [{ char: 'q' }, 'escape', 'ctrl-c'] as const) {
      const f = fakeTerminal([key])
      expect(await runMenu({ terminal: f.terminal, version: '0.5.0', style: plain, run: async () => { f.events.push('run'); return 1 } })).toBe(0)
      expect(f.events).toEqual(['close'])
    }
  })

  test('it opens only with a terminal on both ends, no --json, a TERM that is not dumb and at least 40 by 10', () => {
    const ok = { stdinTTY: true, stdoutTTY: true, json: false, term: 'xterm-256color', columns: 40, rows: 10 }
    expect(menuFits(ok)).toBe(true)
    for (const over of [{ stdinTTY: false }, { stdoutTTY: false }, { json: true }, { term: 'dumb' }, { columns: 39 }, { rows: 9 }, { columns: undefined }]) expect(menuFits({ ...ok, ...over })).toBe(false)
  })
})
