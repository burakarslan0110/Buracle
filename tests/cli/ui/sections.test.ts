import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { renderSection, SECTION_ORDER, sectionMode, sectionPrinter, unicodeLocale } from '../../../src/cli/ui/sections'
import { makeStyle, stripAnsi } from '../../../src/cli/ui/style'
import * as paths from '../../../src/engine/paths'
import { withSandbox } from '../../helpers/sandbox'

const plain = makeStyle(0)
const ascii = makeStyle(0, { unicode: false })

function sink(): { out: { write(s: string): void }, text: () => string } {
  let buf = ''
  return { out: { write: s => { buf += s } }, text: () => buf }
}

describe('install sections', () => {
  test('the fixed order of the sections', () => {
    expect([...SECTION_ORDER]).toEqual(['Prerequisites', 'Buracle', 'Harnesses', 'Tools', 'Memory', 'Result'])
  })

  test('a section with a failed item: the section line, then the item indented by four', () => {
    const lines = renderSection({ name: 'Tools', status: 'warn', detail: '26/27 ready', items: [{ status: 'warn', name: 'gopls', detail: 'optional · needs Go' }] }, { style: plain })
    expect(lines).toEqual(['▲ Tools           26/27 ready', '    ▲ gopls        optional · needs Go'])
  })

  test('items that passed are never printed, so a passing section is one line', () => {
    const lines = renderSection({ name: 'Harnesses', status: 'ok', detail: 'claude, codex', items: [{ status: 'ok', name: 'claude', detail: 'applied' }] }, { style: plain })
    expect(lines).toEqual(['✔ Harnesses       claude, codex'])
  })

  test('every status has its icon, and an ASCII locale gets + ! x i', () => {
    const r = (status: 'ok' | 'warn' | 'fail' | 'skip' | 'info') => renderSection({ name: 'Memory', status, detail: 'd' }, { style: plain })[0]
    expect([r('ok'), r('warn'), r('fail'), r('skip'), r('info')].map(l => l?.slice(0, 1))).toEqual(['✔', '▲', '✖', '▲', 'ℹ'])
    const a = (status: 'ok' | 'warn' | 'fail' | 'info') => renderSection({ name: 'Memory', status, detail: 'd' }, { style: ascii })[0]?.slice(0, 1)
    expect([a('ok'), a('warn'), a('fail'), a('info')]).toEqual(['+', '!', 'x', 'i'])
  })

  test('a line longer than the terminal is cut to columns - 1 with an ellipsis, never inside a character', () => {
    const detail = 'ğüşİı'.repeat(40)
    const [line] = renderSection({ name: 'Result', status: 'ok', detail }, { style: plain, columns: 80 })
    expect(line).toBeDefined()
    expect([...line as string]).toHaveLength(79)
    expect(line?.endsWith('…')).toBe(true)
    expect(line).toStartWith('✔ Result          ğüşİı')
  })

  test('the colour codes sit only around the icon, and the cut counts visible columns', () => {
    const color = makeStyle(3)
    const [line] = renderSection({ name: 'Tools', status: 'fail', detail: 'x'.repeat(200) }, { style: color, columns: 60 })
    expect(line).toContain('\u001b[')
    expect([...stripAnsi(line as string)]).toHaveLength(59)
  })
})

describe('section printer', () => {
  test('on a terminal one live line shows the running section and turns into the result', () => {
    const s = sink()
    const p = sectionPrinter(s.out, { live: true, style: plain, columns: 80, frameMs: 0 })
    p.start('Tools', 'installing codegraph')
    expect(stripAnsi(s.text())).toContain('Tools           installing codegraph')
    p.update('installing semble')
    expect(stripAnsi(s.text())).toContain('installing semble')
    p.done({ name: 'Tools', status: 'ok', detail: '27/27 ready' })
    p.stop()
    const finalScreen = s.text().split('\r').pop() ?? ''
    expect(stripAnsi(finalScreen).replace(/\u001b\[2K/g, '')).toBe('✔ Tools           27/27 ready\n')
  })

  test('without a terminal there is no live line and no control code at all', () => {
    const s = sink()
    const p = sectionPrinter(s.out, { live: false, style: plain, columns: 80 })
    p.start('Tools', 'installing codegraph')
    p.update('installing semble')
    p.done({ name: 'Tools', status: 'warn', detail: '26/27 ready', items: [{ status: 'fail', name: 'node', detail: 'sha256 mismatch' }] })
    p.stop()
    expect(s.text()).toBe('▲ Tools           26/27 ready\n    ✖ node         sha256 mismatch\n')
    expect(s.text()).not.toContain('\u001b')
    expect(s.text()).not.toContain('\r')
  })
})

describe('section mode', () => {
  test('a terminal gets the live line and colour; NO_COLOR, TERM=dumb and a pipe get plain text', () => {
    const utf = { LANG: 'en_US.UTF-8' }
    expect(sectionMode({ isTTY: true }, { ...utf, TERM: 'xterm-256color' }, 'darwin')).toMatchObject({ live: true, unicode: true })
    expect(sectionMode({ isTTY: true }, { ...utf, NO_COLOR: '1' }, 'darwin')).toMatchObject({ live: false })
    expect(sectionMode({ isTTY: true }, { ...utf, NO_COLOR: '1' }, 'darwin').style.level).toBe(0)
    expect(sectionMode({ isTTY: true }, { ...utf, TERM: 'dumb' }, 'darwin')).toMatchObject({ live: false })
    expect(sectionMode({ isTTY: false }, utf, 'linux')).toMatchObject({ live: false })
    expect(sectionMode({ isTTY: false }, utf, 'linux').style.level).toBe(0)
  })

  test('block symbols only in a UTF-8 locale; Windows always', () => {
    expect(unicodeLocale({ LANG: 'C.UTF-8' }, 'linux')).toBe(true)
    expect(unicodeLocale({ LC_ALL: 'tr_TR.utf8' }, 'linux')).toBe(true)
    expect(unicodeLocale({ LANG: 'C' }, 'linux')).toBe(false)
    expect(unicodeLocale({}, 'darwin')).toBe(false)
    expect(unicodeLocale({ LC_ALL: 'C', LANG: 'en_US.UTF-8' }, 'linux')).toBe(false)
    expect(unicodeLocale({}, 'win32')).toBe(true)
  })
})

describe('install log', () => {
  test('one file per day under the logs folder', () => withSandbox(() => {
    expect(paths.installLogFile(new Date('2026-11-01T10:00:00Z'))).toBe(join(paths.logsDir(), 'install-2026-11-01.log'))
  }))
})
