import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { workSpawn } from '../../src/workflow/board-panes'
import type { MuxExec } from '../../src/workflow/mux'
import { muxStorePath, readMuxStore } from '../../src/workflow/mux-store'
import { CMUX_ENV, CU, HERDR_ENV, LEAD, NOW, fakeCmux, fakeHerdr, published, sandbox, which } from './board-panes-helpers'
import { ctxAt } from './fixture'

describe('work spawn: where the worker panes go', () => {
  test('six workers fill two rows of three under the lead: each column is split down once, and the pane map reads left to right, top to bottom', () => sandbox(async root => {
    const { repo } = await published(root, { n: 6 })
    const h = fakeHerdr()
    const r = await workSpawn({}, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })
    expect(r.errors).toEqual([])
    const cwd = String(r.data['cwd'])
    expect(h.lines().filter(l => l.startsWith('herdr pane split'))).toEqual([
      `herdr pane split --current --direction down --ratio 0.4 --cwd ${cwd} --no-focus`,
      `herdr pane split --pane w2:p1 --direction right --ratio 0.333 --cwd ${cwd} --no-focus`,
      `herdr pane split --pane w2:p2 --direction right --ratio 0.5 --cwd ${cwd} --no-focus`,
      `herdr pane split --pane w2:p1 --direction down --ratio 0.5 --cwd ${cwd} --no-focus`,
      `herdr pane split --pane w2:p2 --direction down --ratio 0.5 --cwd ${cwd} --no-focus`,
      `herdr pane split --pane w2:p3 --direction down --ratio 0.5 --cwd ${cwd} --no-focus`,
    ])
    expect(r.lines).toContain('  w2:p4  Worker 4 (claude) · waiting for a task')
  }))

  test('a spawn that finds worker panes already open adds the new ones next to the last of them and leaves the others as they are', () => sandbox(async root => {
    const { repo } = await published(root, { n: 4 })
    const live = new Set<string>()
    const h = fakeHerdr({ live })
    expect((await workSpawn({ workers: 1 }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
    h.reset()
    const r = await workSpawn({ workers: 2 }, ctxAt(repo, NOW + 1, HERDR_ENV), LEAD, { exec: h.exec, which })
    expect(r.errors).toEqual([])
    const cwd = String(r.data['cwd'])
    // The old pane keeps a third of its width and the two new ones take a third each.
    expect(h.lines().filter(l => l.startsWith('herdr pane split'))).toEqual([
      `herdr pane split --pane w2:p1 --direction right --ratio 0.333 --cwd ${cwd} --no-focus`,
      `herdr pane split --pane w2:p2 --direction right --ratio 0.5 --cwd ${cwd} --no-focus`,
    ])
  }))

  test('a pane that fails to open leaves no gap: the pane that was to split it is replaced by the last pane opened, and by the lead when none opened, each in halves', () => sandbox(async root => {
    const { repo } = await published(root, { n: 3 })
    // The second split fails: Worker 2 is missing, so Worker 3 (which was to split it) halves the pane opened before.
    const second = fakeHerdr({ failSplit: 2 })
    const r = await workSpawn({}, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: second.exec, which })
    expect(r.code).toBe(2)
    const cwd = String(r.data['cwd'])
    expect(second.lines().filter(l => l.startsWith('herdr pane split'))).toEqual([
      `herdr pane split --current --direction down --ratio 0.5 --cwd ${cwd} --no-focus`,
      `herdr pane split --pane w2:p1 --direction right --ratio 0.333 --cwd ${cwd} --no-focus`,
      `herdr pane split --pane w2:p1 --direction right --ratio 0.5 --cwd ${cwd} --no-focus`,
    ])
    // The first split fails: nothing opened yet, so the next pane halves the lead itself.
    const { repo: repo2 } = await published(join(root, 'two'), { n: 2 })
    const first = fakeHerdr({ failSplit: 1 })
    const late = await workSpawn({}, ctxAt(repo2, NOW, HERDR_ENV), LEAD, { exec: first.exec, which })
    expect(late.code).toBe(2)
    expect(first.lines().filter(l => l.startsWith('herdr pane split')).at(-1)).toBe(`herdr pane split --current --direction right --ratio 0.5 --cwd ${String(late.data['cwd'])} --no-focus`)
  }))

  test('cmux only halves, so three workers open in the order rank 1, 3, 2; the pane map and the opened list still read Worker 1, 2, 3 left to right', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 3 })
    const c = fakeCmux()
    const r = await workSpawn({}, ctxAt(repo, NOW, CMUX_ENV), LEAD, { exec: c.exec, cmuxBin: '/opt/cmux', which })
    expect(r.errors).toEqual([])
    const splits = c.lines().filter(l => l.includes(' new-split ')).map(l => l.replace(/ --command .* --focus false$/, ''))
    expect(splits).toEqual([
      '/opt/cmux new-split down',
      `/opt/cmux new-split right --surface ${CU(2)}`,
      `/opt/cmux new-split right --surface ${CU(2)}`,
    ])
    // Creation order is Worker 1 (CU 2), Worker 3 (CU 3), Worker 2 (CU 4); everything the lead reads is in Worker order.
    expect((r.data['opened'] as Array<{ id: string, title: string }>).map(p => [p.id, p.title])).toEqual([
      [CU(2), 'Worker 1 (claude) · waiting for a task'],
      [CU(4), 'Worker 2 (claude) · waiting for a task'],
      [CU(3), 'Worker 3 (claude) · waiting for a task'],
    ])
    expect(r.lines.filter(l => l.startsWith('  ') && l.includes('Worker'))).toEqual([
      `  ${CU(2)}  Worker 1 (claude) · waiting for a task`,
      `  ${CU(4)}  Worker 2 (claude) · waiting for a task`,
      `  ${CU(3)}  Worker 3 (claude) · waiting for a task`,
    ])
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes.map(p => p.id)).toEqual([CU(2), CU(3), CU(4)])
  }))

  test('tmux gives the new panes a percentage of the pane they split and never re-tiles the window the lead and the user work in', () => sandbox(async root => {
    const { repo } = await published(root, { n: 4 })
    let next = 7
    const calls: string[][] = []
    const exec: MuxExec = async argv => {
      calls.push(argv)
      if (argv[1] === 'split-window') return { code: 0, stdout: `%${next++}\n`, stderr: '' }
      if (argv[1] === 'display-message') return { code: 0, stdout: '4242 /private/tmp/tmux-501/default\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const r = await workSpawn({ mux: 'tmux', workers: 4 }, ctxAt(repo, NOW, { TMUX: '/private/tmp/tmux-501/default,812,0', TMUX_PANE: '%3' }), LEAD, { exec, which })
    expect(r.errors).toEqual([])
    const lines = calls.map(c => c.join(' '))
    expect(lines.some(l => l.includes('select-layout'))).toBe(false)
    expect(lines.filter(l => l.startsWith('tmux split-window')).map(l => l.replace(/ -c \S+ -P -F #\{pane_id\}/, '').replace(/ claude .*$/, ''))).toEqual([
      'tmux split-window -d -v -l 50% -t %3',
      'tmux split-window -d -h -l 75% -t %7',
      'tmux split-window -d -h -l 67% -t %8',
      'tmux split-window -d -h -l 50% -t %9',
    ])
  }))

  test('outside tmux the workers get a window of their own: the first pane starts the session and the rest split it into a row', () => sandbox(async root => {
    const { repo } = await published(root, { n: 3 })
    let next = 7
    let sessions = 0
    const calls: string[][] = []
    const exec: MuxExec = async argv => {
      calls.push(argv)
      if (argv[1] === 'has-session') return sessions > 0 ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'no session' }
      if (argv[1] === 'new-session') { sessions++; return { code: 0, stdout: `%${next++}\n`, stderr: '' } }
      if (argv[1] === 'split-window') return { code: 0, stdout: `%${next++}\n`, stderr: '' }
      if (argv[1] === 'display-message') return { code: 0, stdout: '4242 /tmp/s\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const r = await workSpawn({ mux: 'tmux', workers: 3 }, ctxAt(repo, NOW), LEAD, { exec, which })
    expect(r.errors).toEqual([])
    const lines = calls.map(c => c.join(' ')).filter(l => /new-session|split-window/.test(l)).map(l => l.replace(/ -c \S+ -P -F #\{pane_id\}/, '').replace(/ claude .*$/, ''))
    expect(lines).toEqual([
      'tmux new-session -d -s buracle-rate-limit',
      'tmux split-window -d -h -l 67% -t %7',
      'tmux split-window -d -h -l 50% -t %8',
    ])
  }))
})
