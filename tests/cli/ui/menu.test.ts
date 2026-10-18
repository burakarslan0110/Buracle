import { describe, expect, test } from 'bun:test'
import type { Key } from '../../../src/cli/ui/keys'
import { initialMenu, MENU, menuStep, renderMenu, type MenuView } from '../../../src/cli/ui/menu'
import { ICON, LOGO, makeStyle, stripAnsi, visibleWidth, type ColorLevel } from '../../../src/cli/ui/style'

const plain = makeStyle(0, { unicode: false })
const color = makeStyle(3, { unicode: true })
const style = (level: ColorLevel) => makeStyle(level, { unicode: level > 0 })

const ALL_GOOD = { updates: 0, problems: 0 }
const menu = (columns: number, rows: number, summary: MenuView['summary'] = ALL_GOOD): MenuView => initialMenu('0.5.0', summary, { columns, rows })
const shown = (st = plain, v: MenuView = menu(80, 24)) => renderMenu(st, v).map(l => stripAnsi(l))
const press = (v: MenuView, ...keys: Key[]): MenuView => keys.reduce((acc, k) => menuStep(acc, k).view, v)
const ch = (c: string): Key => ({ char: c })

const ITEMS_80 = [
  '  > Install or repair  set Buracle up in your coding agents, or repair it',
  '    Update             look for new versions and apply them, step by step',
  '    Health check       check every part and see how to fix what is broken',
  '    Memory             open the memory web UI in your browser',
  '    Detailed view      every part with its version, state and waiting update',
  '    Quit',
]
const HINT = '  ↑↓ move · enter choose · q quit'

describe('main menu frames', () => {
  test('80 by 24 at color level 0: the title, the status, every choice with what it does, and the key hints', () => {
    expect(renderMenu(plain, menu(80, 24))).toEqual([
      '',
      '  buracle 0.5.0 · everything your coding agents need, in one place',
      '',
      '  + All good · no update check yet',
      '',
      ...ITEMS_80,
      ...Array<string>(12).fill(''),
      HINT,
    ])
  })

  test('with color and room, the pixel logo stands on top with the version and the tagline under it', () => {
    const lines = shown(color, menu(80, 24))
    expect(lines.slice(1, 7)).toEqual(LOGO.map(l => `  ${l}`.trimEnd()))
    expect(lines[7]).toBe('  v0.5.0  ·  everything your coding agents need, in one place')
    expect(lines.slice(11, 17)).toEqual(ITEMS_80.map(l => l.replace('  > ', '  ❯ ')))
    expect(lines).toHaveLength(24)
    expect(lines.at(-1)).toBe(HINT)
  })

  test('below 62 columns the icon stands for the logo; descriptions that do not all fit move under the list, for the selected choice only', () => {
    const v = menu(60, 20)
    const lines = shown(color, v)
    expect(lines.slice(1, 7).map(l => l.slice(0, 10).trimEnd())).toEqual(ICON.map(l => `  ${l}`.trimEnd()))
    expect(lines.join('\n')).toContain('buracle')
    expect(lines.slice(10, 16)).toEqual(['  ❯ Install or repair', '    Update', '    Health check', '    Memory', '    Detailed view', '    Quit'])
    expect(lines.at(-3)).toBe('  set Buracle up in your coding agents, or repair it')
    expect(shown(color, press(v, 'down')).at(-3)).toBe('  look for new versions and apply them, step by step')
    expect(shown(color, press(v, 'end')).at(-3)).toBe('')
  })

  test('a lower window drops the logo first, then the empty lines, then the status line', () => {
    const at = (rows: number) => shown(color, menu(80, rows))
    expect(at(20)[1]).toBe(`  ${LOGO[0]}`.trimEnd())
    expect(at(19)[0]).toBe(`  ${LOGO[0]}`.trimEnd())
    expect(at(17).slice(0, 4)).toEqual(['', '  ◉ buracle 0.5.0 · everything your coding agents need, in one place', '', '  ✔ All good · no update check yet'])
    expect(at(10)).toEqual(['  ◉ buracle 0.5.0 · everything your coding agents need, in one place', '  ✔ All good · no update check yet', ...ITEMS_80.map(l => l.replace('  > ', '  ❯ ')), '', HINT])
    expect(at(9)).toEqual(['  ◉ buracle 0.5.0 · everything your coding agents need, in one place', ...ITEMS_80.map(l => l.replace('  > ', '  ❯ ')), '', HINT])
    expect(shown(plain, { ...menu(80, 4), selected: 5 })).toEqual([...ITEMS_80.slice(3, 5), '  > Quit', HINT])
  })

  test('every line fits the width and the frame never has more lines than the terminal', () => {
    for (const level of [0, 1, 2, 3] as const) {
      for (const [columns, rows] of [[120, 40], [100, 30], [80, 24], [62, 20], [61, 20], [50, 12], [43, 18], [42, 18], [40, 10], [30, 8], [20, 6], [12, 4], [1, 1]] as const) {
        for (const v of [menu(columns, rows), press(menu(columns, rows, { updates: 12, problems: 3, checkedAt: '48 min ago' }), 'end'), { ...menu(columns, rows), message: 'buracle update: done, with points that need your attention (exit code 2)' }]) {
          const lines = renderMenu(style(level), v)
          expect(lines.length).toBe(rows)
          for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(columns)
        }
      }
    }
    expect(renderMenu(plain, menu(80, 0))).toEqual([])
  })
})

describe('main menu status line', () => {
  const status = (summary: MenuView['summary']) => shown(plain, menu(80, 24, summary))[3]
  test('all good, the counts that wait, and when updates were last checked', () => {
    expect(status(ALL_GOOD)).toBe('  + All good · no update check yet')
    expect(status({ updates: 0, problems: 0, checkedAt: '5 min ago' })).toBe('  + All good · updates checked 5 min ago')
    expect(status({ updates: 1, problems: 0, checkedAt: 'just now' })).toBe('  i 1 update waiting · updates checked just now')
    expect(status({ updates: 2, problems: 1 })).toBe('  ! 2 updates waiting · 1 problem · no update check yet')
    expect(status({ updates: 0, problems: 3 })).toBe('  ! 3 problems · no update check yet')
  })

  test('the time of the check goes first when the line is too narrow', () => {
    expect(shown(plain, menu(40, 24, { updates: 2, problems: 1, checkedAt: '5 min ago' }))[3]).toBe('  ! 2 updates waiting · 1 problem')
  })
})

describe('main menu text safety', () => {
  test('external text is sanitized: no escape sequence other than the style\'s own SGR reaches the screen', () => {
    const v = { ...initialMenu('0.5.0\u001b[2J', { updates: 1, problems: 0, checkedAt: '5\u001b]0;owned\u0007 min' }, { columns: 100, rows: 30 }), message: 'done\u001b[3J\r' }
    for (const lines of [renderMenu(color, v), renderMenu(color, { ...v, columns: 50 })]) {
      const out = lines.join('\n')
      expect(out).toMatch(/\u001b\[[0-9;]*m/)
      const rest = out.replace(/\u001b\[[0-9;]*m/g, '')
      expect(rest).not.toContain('\u001b')
      expect(rest).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
    }
  })

  test('color level 0 writes no escape at all, no Unicode state symbol and no logo blocks', () => {
    for (const v of [menu(100, 30), press(menu(100, 30, { updates: 1, problems: 1 }), 'down'), menu(50, 20)]) {
      const out = renderMenu(plain, v).join('\n')
      expect(out).not.toContain('\u001b')
      for (const sym of ['✔', '▲', '✖', '❯', 'ℹ', '◉', '█', '▀', '▄']) expect(out).not.toContain(sym)
    }
  })

  test('a message after a command takes the line under the list', () => {
    const lines = shown(plain, { ...menu(60, 20), message: 'buracle install: done' })
    expect(lines).toContain('  buracle install: done')
    expect(lines).not.toContain('  set Buracle up in your coding agents, or repair it')
  })
})

describe('main menu keys', () => {
  test('up, down, k and j move by one choice and stop at the ends; Home, End, g and G jump', () => {
    const v = menu(80, 24)
    expect(press(v, 'down').selected).toBe(1)
    expect(press(v, ch('j'), ch('j'), ch('k')).selected).toBe(1)
    expect(press(v, 'up').selected).toBe(0)
    expect(press(v, 'end').selected).toBe(MENU.length - 1)
    expect(press(v, 'end', 'down').selected).toBe(MENU.length - 1)
    expect(press(v, ch('G'), ch('g')).selected).toBe(0)
    expect(press(v, 'pagedown', 'pageup').selected).toBe(0)
  })

  test('Enter runs the selected choice: the commands, the detailed view and quit', () => {
    const enterAt = (n: number) => menuStep({ ...menu(80, 24), selected: n }, 'enter').action
    expect([0, 1, 2, 3, 4, 5].map(enterAt)).toEqual([
      { kind: 'run', argv: ['install'] },
      { kind: 'run', argv: ['update'] },
      { kind: 'run', argv: ['doctor'] },
      { kind: 'run', argv: ['mem', 'ui', '--open'] },
      { kind: 'detail' },
      { kind: 'quit' },
    ])
  })

  test('the detailed view\'s letters work here too and select their choice; v opens the detailed view', () => {
    const v = menu(80, 24)
    for (const [key, argv, at] of [['i', ['install'], 0], ['u', ['update'], 1], ['d', ['doctor'], 2], ['m', ['mem', 'ui', '--open'], 3]] as const) {
      const step = menuStep(v, ch(key))
      expect(step.action).toEqual({ kind: 'run', argv: [...argv] })
      expect(step.view.selected).toBe(at)
    }
    expect(menuStep(v, ch('v')).action).toEqual({ kind: 'detail' })
    expect(menuStep(v, ch('c')).action).toBeUndefined()
    expect(menuStep(v, 'left').action).toBeUndefined()
  })

  test('q, Escape and Ctrl-C quit; a key clears the message; an action never shares the menu\'s own argv', () => {
    const v = { ...menu(80, 24), message: 'buracle update: done' }
    for (const k of [ch('q'), 'escape', 'ctrl-c'] as const) expect(menuStep(v, k).action).toEqual({ kind: 'quit' })
    expect(menuStep(v, 'down').view.message).toBeUndefined()
    const step = menuStep(v, 'enter')
    if (step.action?.kind === 'run') step.action.argv.push('--yes')
    expect(menuStep(v, 'enter').action).toEqual({ kind: 'run', argv: ['install'] })
  })
})
