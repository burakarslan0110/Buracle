import { describe, expect, test } from 'bun:test'
import { dashboardStep, initialView, renderDashboard, SECTION_TITLES, type DashRow, type DashView } from '../../../src/cli/ui/dashboard'
import type { Key } from '../../../src/cli/ui/keys'
import { makeStyle, stripAnsi, visibleWidth, type ColorLevel } from '../../../src/cli/ui/style'
import { textWidth } from '../../../src/core/status/format'

const plain = makeStyle(0, { unicode: false })
const color = makeStyle(3, { unicode: true })
const style = (level: ColorLevel) => makeStyle(level, { unicode: level > 0 })

const SAMPLE: DashRow[] = [
  { id: 'buracle', section: 'buracle', label: 'Buracle', version: '0.4.0', state: 'ok', status: 'up to date', source: 'git checkout', detail: 'runs from ~/Code/buracle' },
  { id: 'claude', section: 'harnesses', label: 'Claude Code', version: '2.1.294', state: 'ok', status: 'ready', source: 'native installer' },
  { id: 'codex', section: 'harnesses', label: 'Codex', version: '0.164.0', state: 'warn', status: 'update available', update: '0.165.0', source: 'Homebrew cask codex', action: { argv: ['update', 'codex'], label: 'update Codex' } },
  { id: 'opencode', section: 'harnesses', label: 'OpenCode', version: '1.2.27', state: 'ok', status: 'ready', source: 'npm opencode-ai' },
  { id: 'omp', section: 'harnesses', label: 'Oh My Pi', state: 'off', status: 'not installed', action: { argv: ['install', 'omp'], label: 'install it' } },
  { id: 'context7', section: 'mcp', label: 'context7', version: '2.1.0', state: 'ok', status: 'running', source: 'npm @upstash/context7-mcp' },
  { id: 'semble', section: 'mcp', label: 'semble', version: '0.3.1', state: 'err', status: 'down', source: 'uv tool semble', detail: 'the server exited at start; run buracle doctor' },
  { id: 'web-fetch', section: 'mcp', label: 'web-fetch', version: '1.0.4', state: 'ok', status: 'running', source: 'npm' },
  { id: 'codegraph', section: 'tools', label: 'codegraph', version: '0.9.2', state: 'ok', status: 'installed', source: 'npm' },
  { id: 'ast-grep', section: 'tools', label: 'ast-grep', state: 'err', status: 'missing', action: { argv: ['install'], label: 'install it' } },
  { id: 'ts-lsp', section: 'tools', label: 'typescript-language-server', version: '5.1.3', state: 'ok', status: 'installed', source: 'npm' },
  { id: 'memory', section: 'memory', label: 'Memory', state: 'ok', status: '412 memories', source: 'cortexdb 0.8.0' },
]

const view = (columns: number, rows: number, items: DashRow[] = SAMPLE): DashView => initialView('0.4.0', items, { columns, rows })

const press = (v: DashView, ...keys: Key[]): DashView => keys.reduce((acc, k) => dashboardStep(acc, k).view, v)
const ch = (c: string): Key => ({ char: c })

const FRAME_100_30 = [
  '  buracle 0.4.0                                                               1 update · 2 problems',
  '',
  '  Buracle',
  '  > Buracle                   0.4.0    + up to date                    git checkout',
  '',
  '  Harnesses',
  '    Claude Code               2.1.294  + ready                         native installer',
  '    Codex                     0.164.0  ! update available  -> 0.165.0  Homebrew cask codex',
  '    OpenCode                  1.2.27   + ready                         npm opencode-ai',
  '    Oh My Pi                           * not installed',
  '',
  '  MCP servers',
  '    context7                  2.1.0    + running                       npm @upstash/context7-mcp',
  '    semble                    0.3.1    x down                          uv tool semble',
  '    web-fetch                 1.0.4    + running                       npm',
  '',
  '  Tools and language servers',
  '    codegraph                 0.9.2    + installed                     npm',
  '    ast-grep                           x missing',
  '    typescript-language-ser…  5.1.3    + installed                     npm',
  '',
  '  Memory',
  '    Memory                             + 412 memories                  cortexdb 0.8.0',
  '',
  '',
  '',
  '',
  '',
  '  runs from ~/Code/buracle',
  '  ↑↓ move · enter check this · u update · c check · i install · esc menu · ? keys · q quit',
]

const FRAME_60_20 = [
  '  buracle 0.4.0                       1 update · 2 problems',
  '',
  '  Buracle',
  '  > Buracle         0.4.0    + up to date',
  '',
  '  Harnesses',
  '    Claude Code     2.1.294  + ready',
  '    Codex           0.164.0  ! update available  -> 0.165.0',
  '    OpenCode        1.2.27   + ready',
  '    Oh My Pi                 * not installed',
  '',
  '  MCP servers',
  '    context7        2.1.0    + running',
  '    semble          0.3.1    x down',
  '    web-fetch       1.0.4    + running',
  '',
  '',
  '  4 more below',
  '  runs from ~/Code/buracle',
  '  ↑↓ move · enter check this · esc menu · ? keys · q quit',
]

const FRAME_40_10 = [
  '  buracle 0.4.0   1 update · 2 problems',
  '',
  '  Buracle',
  '  > Buracle             + up to date',
  '',
  '  Harnesses',
  '    Claude Code         + ready',
  '  10 more below',
  '  runs from ~/Code/buracle',
  '  enter check this · ? keys · q quit',
]

describe('dashboard frames at color level 0', () => {
  test('100 by 30: every column, the summary, the detail and the key hints', () => {
    expect(renderDashboard(plain, view(100, 30)).join('\n')).toBe(FRAME_100_30.join('\n'))
  })

  test('60 by 20: no source column, the list scrolls below the fold', () => {
    expect(renderDashboard(plain, view(60, 20)).join('\n')).toBe(FRAME_60_20.join('\n'))
  })

  test('40 by 10: no version or source, the update moves into the status column', () => {
    expect(renderDashboard(plain, view(40, 10)).join('\n')).toBe(FRAME_40_10.join('\n'))
    const codex = renderDashboard(plain, press(view(40, 10), 'down', 'down'))
    expect(codex).toContain('  > Codex               ! -> 0.165.0')
  })
})

describe('dashboard rendering', () => {
  test('every line fits the width and the frame never has more lines than the terminal', () => {
    for (const level of [0, 1, 2, 3] as const) {
      for (const [columns, rows] of [[100, 30], [80, 24], [60, 20], [59, 20], [50, 12], [49, 12], [40, 10], [30, 8], [20, 6], [12, 4], [1, 1]] as const) {
        for (const v of [view(columns, rows), press(view(columns, rows), 'end'), press(view(columns, rows), ch('?'))]) {
          const lines = renderDashboard(style(level), v)
          expect(lines.length).toBeLessThanOrEqual(rows)
          for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(columns)
        }
      }
    }
  })

  test('Turkish dotted and dotless i and wide CJK text keep the columns aligned and inside the width', () => {
    const items: DashRow[] = [
      { id: 'a', section: 'tools', label: 'İstanbul ışık', version: '1.0.0', state: 'ok', status: 'kurulu ı', source: '/Users/ışık/プロジェクト/とても/長い/パス/to/the/tool' },
      { id: 'b', section: 'tools', label: '日本語のツールとその他のもの', version: '2.0.0', state: 'warn', status: '更新がありますよ、今すぐどうぞ', update: '2.1.0', source: 'npm' },
      { id: 'c', section: 'tools', label: 'plain', version: '3.0.0', state: 'ok', status: 'ready', detail: 'パス /Users/İı/長い長い長い長い長い長い長い長い長い長い長い長い長い' },
    ]
    for (const columns of [100, 72, 60, 45, 33]) {
      for (const level of [0, 3] as const) {
        const lines = renderDashboard(style(level), press(view(columns, 12, items), 'end'))
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(columns)
        if (columns < 60) continue
        const rows = lines.map(l => stripAnsi(l)).filter(l => /[0-9]\.0\.0/.test(l))
        expect(rows).toHaveLength(3)
        const versionColumn = rows.map(l => textWidth(l.slice(0, l.search(/[0-9]\.0\.0/))))
        expect(new Set(versionColumn).size).toBe(1)
      }
    }
  })

  test('external text is sanitized: no escape sequence other than the style\'s own SGR reaches the screen', () => {
    const evil: DashRow[] = [{
      id: 'x', section: 'harnesses', label: 'Codex\u001b]0;owned\u0007', version: '\u001b[2J1.0', state: 'warn', status: 'up\rdate\u009b2J',
      update: '2.0\u001b[31m', source: 'npm\u001b[H\u001b[2J', detail: 'see\u001b[6n', action: { argv: ['x'], label: 'run\u001b[?1049l' },
    }]
    const v = { ...initialView('0.4.0\u001b[2J', evil, { columns: 100, rows: 20 }), message: 'done\u001b[3J' }
    for (const shown of [v, { ...v, message: undefined } as DashView]) {
      const out = renderDashboard(color, shown).join('\n')
      expect(out).toMatch(/\u001b\[[0-9;]*m/)
      const rest = out.replace(/\u001b\[[0-9;]*m/g, '')
      expect(rest).not.toContain('\u001b')
      expect(rest).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
    }
  })

  test('color level 0 writes no escape at all and none of the Unicode state symbols', () => {
    for (const v of [view(100, 30), press(view(100, 30), 'down', 'down'), press(view(100, 30), ch('?'))]) {
      const out = renderDashboard(plain, v).join('\n')
      expect(out).not.toContain('\u001b')
      for (const sym of ['✔', '▲', '✖', '❯', '●', '•']) expect(out).not.toContain(sym)
    }
  })

  test('headings are bold, in sentence case and without letter-spacing; the selected row carries the pointer', () => {
    const lines = renderDashboard(color, view(100, 30))
    for (const id of ['buracle', 'harnesses', 'mcp', 'tools', 'memory'] as const) {
      expect(lines).toContain(`  ${color.bold(SECTION_TITLES[id])}`)
    }
    expect(Object.values(SECTION_TITLES)).toEqual(['Buracle', 'Harnesses', 'MCP servers', 'Tools and language servers', 'Memory'])
    expect(stripAnsi(lines[3] ?? '')).toStartWith('  ❯ Buracle')
    expect(stripAnsi(lines[7] ?? '')).toContain('▲ update available  → 0.165.0')
    expect(stripAnsi(lines[0] ?? '')).toStartWith('  ◉ buracle 0.4.0')
  })

  test('the version column goes below 60 columns and the source column below 50', () => {
    const at = (columns: number) => renderDashboard(plain, view(columns, 30)).join('\n')
    expect(at(60)).toContain('2.1.294')
    expect(at(59)).not.toContain('2.1.294')
    expect(at(90)).toContain('Homebrew cask codex')
    expect(at(80)).toContain('Homebrew')
    expect(at(50)).not.toContain('Homebrew')
    expect(at(49)).not.toContain('Homebrew')
    expect(at(55)).toContain('-> 0.165.0')
  })

  test('the summary: plural, singular, all good, and the time of the last check', () => {
    const title = (summary: DashView['summary']) => stripAnsi(renderDashboard(plain, { ...view(100, 30), summary })[0] ?? '')
    expect(title({ updates: 2, problems: 3 })).toEndWith('2 updates · 3 problems')
    expect(title({ updates: 1, problems: 1 })).toEndWith('1 update · 1 problem')
    expect(title({ updates: 0, problems: 0 })).toEndWith('all good')
    expect(title({ updates: 0, problems: 0, checkedAt: '10:42' })).toEndWith('all good · checked 10:42')
    expect(initialView('1', SAMPLE, { columns: 80, rows: 24 }).summary).toEqual({ updates: 1, problems: 2 })
  })

  test('the hint names the selected row\'s action; a message takes the detail line', () => {
    const codex = press(view(100, 30), 'down', 'down')
    expect(renderDashboard(plain, codex).at(-1)).toStartWith('  ↑↓ move · enter update Codex · u update')
    expect(renderDashboard(plain, codex).at(-2)).toBe('  Homebrew cask codex · update available')
    const semble = press(view(100, 30), 'end', 'up', 'up', 'up', 'up', 'up')
    expect(renderDashboard(plain, semble).at(-2)).toBe('  the server exited at start; run buracle doctor')
    expect(renderDashboard(plain, { ...codex, message: 'update finished' }).at(-2)).toBe('  update finished')
  })

  test('a long list scrolls so the selected row stays visible; the title and the hints stay put', () => {
    let v = view(40, 10)
    for (let i = 0; i < SAMPLE.length; i++) {
      const lines = renderDashboard(plain, v).map(l => stripAnsi(l))
      expect(lines).toHaveLength(10)
      expect(lines[0]).toStartWith('  buracle 0.4.0')
      expect(lines[9]).toEndWith('? keys · q quit')
      const selected = SAMPLE[v.selected]
      expect(lines.some(l => l.startsWith('  > ') && l.includes((selected?.label ?? '?').slice(0, 10)))).toBe(true)
      v = dashboardStep(v, 'down').view
    }
    expect(v.selected).toBe(SAMPLE.length - 1)
    expect(v.scroll).toBeGreaterThan(0)
    const bottom = renderDashboard(plain, v).map(l => stripAnsi(l))
    expect(bottom[1]).toBe('  9 more above')
    expect(bottom.slice(2, 7)).toEqual(['    ast-grep            x missing', '    typescript-langua…  + installed', '', '  Memory', '  > Memory              + 412 memories'])
    const top = press(v, 'home')
    expect(top.scroll).toBe(0)
    expect(renderDashboard(plain, top).map(l => stripAnsi(l))[2]).toBe('  Buracle')
  })

  test('the help overlay replaces the list with one key per line', () => {
    const lines = renderDashboard(plain, press(view(100, 30), ch('?')))
    expect(lines.slice(2, 15)).toEqual([
      '  Keys',
      '  ↑ ↓ or k j                move',
      '  PgUp PgDn, Home End, g G  jump',
      '  enter                     run the action of the selected row',
      '  u                         update everything',
      '  c                         check for updates',
      '  i                         install or repair',
      '  d                         health check',
      '  m                         open the memory web UI',
      '  r                         reload',
      '  esc                       back to the main menu',
      '  ?                         close this help',
      '  q                         quit',
    ])
    expect(lines.join('\n')).not.toContain('Harnesses')
    expect(lines.at(-2)).toBe('  Esc or any key closes this help · q quits')
    const narrow = renderDashboard(plain, press(view(40, 30), ch('?')))
    expect(narrow).toContain('  enter  run the action of the selecte…')
  })
})

describe('dashboard keys', () => {
  test('up, down, k and j move by one item and stop at the ends', () => {
    const v = view(100, 30)
    expect(press(v, 'down').selected).toBe(1)
    expect(press(v, ch('j'), ch('j'), ch('k')).selected).toBe(1)
    expect(press(v, 'up').selected).toBe(0)
    expect(press(v, 'end', 'down').selected).toBe(SAMPLE.length - 1)
    expect(press(v, 'end', ch('k')).selected).toBe(SAMPLE.length - 2)
  })

  test('Page Up and Down move by the visible height, Home and g go first, End and G go last', () => {
    const v = view(40, 10)
    expect(press(v, 'pagedown').selected).toBe(5)
    expect(press(v, 'pagedown', 'pagedown', 'pagedown').selected).toBe(SAMPLE.length - 1)
    expect(press(v, 'end', 'pageup').selected).toBe(SAMPLE.length - 6)
    expect(press(v, ch('G')).selected).toBe(SAMPLE.length - 1)
    expect(press(v, ch('G'), ch('g')).selected).toBe(0)
    expect(press(v, 'end', 'home').selected).toBe(0)
  })

  test('Enter runs the selected row\'s action; a row without one does nothing', () => {
    const v = view(100, 30)
    expect(dashboardStep(press(v, 'down', 'down'), 'enter').action).toEqual({ kind: 'run', argv: ['update', 'codex'] })
    expect(dashboardStep(v, 'enter').action).toBeUndefined()
  })

  test('the letter keys run their commands, r reloads, Escape and Backspace go back to the main menu, q and Ctrl-C quit', () => {
    const v = view(100, 30)
    const run = (c: string) => dashboardStep(v, ch(c)).action
    expect(run('u')).toEqual({ kind: 'run', argv: ['update'] })
    expect(run('c')).toEqual({ kind: 'run', argv: ['update', '--check'] })
    expect(run('i')).toEqual({ kind: 'run', argv: ['install'] })
    expect(run('d')).toEqual({ kind: 'run', argv: ['doctor'] })
    expect(run('m')).toEqual({ kind: 'run', argv: ['mem', 'ui', '--open'] })
    expect(run('r')).toEqual({ kind: 'reload' })
    expect(run('q')).toEqual({ kind: 'quit' })
    expect(dashboardStep(v, 'escape').action).toEqual({ kind: 'back' })
    expect(dashboardStep(v, 'backspace').action).toEqual({ kind: 'back' })
    expect(dashboardStep(v, 'ctrl-c').action).toEqual({ kind: 'quit' })
    expect(run('x')).toBeUndefined()
    expect(dashboardStep(v, 'left').view.selected).toBe(0)
  })

  test('? opens the help; there Escape and any key but q and Ctrl-C only close it', () => {
    const help = press(view(100, 30), ch('?'))
    expect(help.help).toBe(true)
    expect(press(help, ch('?')).help).toBe(false)
    const closed = dashboardStep(help, ch('j'))
    expect(closed.view.help).toBe(false)
    expect(closed.view.selected).toBe(0)
    expect(closed.action).toBeUndefined()
    expect(dashboardStep(help, ch('u')).action).toBeUndefined()
    expect(dashboardStep(help, ch('q')).action).toEqual({ kind: 'quit' })
    const escaped = dashboardStep(help, 'escape')
    expect(escaped.action).toBeUndefined()
    expect(escaped.view.help).toBe(false)
    expect(dashboardStep(help, 'ctrl-c').action).toEqual({ kind: 'quit' })
    expect(dashboardStep(escaped.view, 'escape').action).toEqual({ kind: 'back' })
  })

  test('a key clears the message; the scroll follows the selection both ways', () => {
    const v = { ...view(40, 10), message: 'update finished' }
    expect(dashboardStep(v, 'down').view.message).toBeUndefined()
    const end = press(v, 'end')
    expect(end.scroll).toBe(9)
    expect(press(end, 'up', 'up', 'up').scroll).toBe(8)
    expect(press(end, 'home').scroll).toBe(0)
  })

  test('initialView groups the rows by section in the fixed order and starts at the top', () => {
    const shuffled = [SAMPLE[11], SAMPLE[5], SAMPLE[0], SAMPLE[8], SAMPLE[1], SAMPLE[6]].filter((r): r is DashRow => r !== undefined)
    const v = initialView('0.4.0', shuffled, { columns: 90, rows: 25 })
    expect(v.items.map(r => r.id)).toEqual(['buracle', 'claude', 'context7', 'semble', 'codegraph', 'memory'])
    expect(v).toMatchObject({ version: '0.4.0', columns: 90, rows: 25, selected: 0, scroll: 0, help: false })
    expect(v.message).toBeUndefined()
    const empty = initialView('0.4.0', [], { columns: 60, rows: 12 })
    expect(dashboardStep(empty, 'down').view.selected).toBe(0)
    expect(dashboardStep(empty, 'enter').action).toBeUndefined()
    expect(renderDashboard(plain, empty)).toHaveLength(12)
  })
})
