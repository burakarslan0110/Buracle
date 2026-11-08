import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MuxExec, MuxExecResult, MuxPane } from '../../src/workflow/mux'
import { cmuxBin, detectMux, layoutCaps, muxAdapter, paneIdOf, validPaneId, workerCommand } from '../../src/workflow/mux'
import { withSandbox } from '../helpers/sandbox'
import { onlyPath } from '../helpers/fake-exe'

type Responder = (argv: string[]) => Partial<MuxExecResult> | string | undefined

/** A fake multiplexer CLI: records every argv and answers from `respond` (a string is stdout with code 0). */
function fakeExec(respond: Responder = () => undefined): { exec: MuxExec, calls: string[][], lines: () => string[] } {
  const calls: string[][] = []
  const exec: MuxExec = async argv => {
    calls.push(argv)
    const r = respond(argv)
    if (typeof r === 'string') return { code: 0, stdout: r, stderr: '' }
    return { code: 0, stdout: '', stderr: '', ...(r ?? {}) }
  }
  return { exec, calls, lines: () => calls.map(c => c.join(' ')) }
}

const TMUX_ENV = { TMUX: '/private/tmp/tmux-501/default,812,0', TMUX_PANE: '%3' }
const HERDR_ENV = { HERDR_ENV: '1', HERDR_PANE_ID: 'w2:p1', HERDR_TAB_ID: 'w2:t1', HERDR_WORKSPACE_ID: 'w2', HERDR_SOCKET_PATH: '/Users/me/.config/herdr/herdr.sock' }
const CMUX_ENV = { CMUX_SURFACE_ID: '0f6b2e2a-1111-4222-8333-444455556666', CMUX_WORKSPACE_ID: 'workspace:2', CMUX_SOCKET_PATH: '/Users/me/.local/state/cmux/cmux.sock' }

const pane = (o: Partial<MuxPane> & { id: string }): MuxPane => ({ harness: 'claude', title: 'buracle rate-limit claude 1', server: 'srv', ...o })

describe('detectMux and paneIdOf', () => {
  test('an explicit kind wins; an unknown kind is a usage error; herdr and cmux need their pane environment, tmux never does', () => {
    expect(detectMux({}, 'tmux')).toEqual({ ok: true, kind: 'tmux' })
    expect(detectMux({ ...HERDR_ENV }, 'herdr')).toEqual({ ok: true, kind: 'herdr' })
    expect(detectMux({ ...CMUX_ENV }, 'cmux')).toEqual({ ok: true, kind: 'cmux' })
    expect(detectMux({}, 'herdr')).toMatchObject({ ok: false, code: 'no_mux' })
    expect(detectMux({ HERDR_ENV: '1' }, 'herdr')).toMatchObject({ ok: false, code: 'no_mux' })
    expect(detectMux({}, 'cmux')).toMatchObject({ ok: false, code: 'no_mux' })
    expect(detectMux({}, 'screen')).toMatchObject({ ok: false, code: 'usage' })
  })

  test('without a flag the innermost multiplexer wins: tmux, then herdr, then cmux; nothing is no_mux with the tmux hint', () => {
    expect(detectMux({ ...TMUX_ENV, ...HERDR_ENV, ...CMUX_ENV })).toEqual({ ok: true, kind: 'tmux' })
    expect(detectMux({ ...HERDR_ENV, ...CMUX_ENV })).toEqual({ ok: true, kind: 'herdr' })
    expect(detectMux({ ...CMUX_ENV })).toEqual({ ok: true, kind: 'cmux' })
    expect(detectMux({ TMUX: '' })).toMatchObject({ ok: false, code: 'no_mux' })
    const none = detectMux({})
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.message).toContain('--mux tmux')
  })

  test('paneIdOf reads the pane of one kind and ignores empty values; validPaneId checks the shape per kind', () => {
    expect(paneIdOf('tmux', { ...TMUX_ENV })).toBe('%3')
    expect(paneIdOf('herdr', { ...HERDR_ENV })).toBe('w2:p1')
    expect(paneIdOf('cmux', { ...CMUX_ENV })).toBe(CMUX_ENV.CMUX_SURFACE_ID)
    expect(paneIdOf('tmux', { TMUX_PANE: '' })).toBeUndefined()
    expect(paneIdOf('herdr', { ...TMUX_ENV })).toBeUndefined()
    expect(validPaneId('tmux', '%12')).toBe(true)
    expect(validPaneId('tmux', '-t')).toBe(false)
    expect(validPaneId('tmux', 'w2:p1')).toBe(false)
    expect(validPaneId('herdr', 'w2:p12')).toBe(true)
    expect(validPaneId('herdr', '%1')).toBe(false)
    expect(validPaneId('cmux', 'surface:4')).toBe(true)
    expect(validPaneId('cmux', CMUX_ENV.CMUX_SURFACE_ID)).toBe(true)
    expect(validPaneId('cmux', '--surface')).toBe(false)
  })
})

describe('layoutCaps', () => {
  test('tmux, herdr and cmux differ in what the layout of the worker panes can rely on: sizes, and a lead pane to split', () => {
    expect(layoutCaps('herdr', { ...HERDR_ENV })).toEqual({ exact: true, lead: true })
    expect(layoutCaps('cmux', { ...CMUX_ENV })).toEqual({ exact: false, lead: true })
    expect(layoutCaps('tmux', { ...TMUX_ENV })).toEqual({ exact: true, lead: true })
    // Opened from outside tmux (--mux tmux), the workers get a session of their own and there is no lead pane in it.
    expect(layoutCaps('tmux', {})).toEqual({ exact: true, lead: false })
  })
})

describe('workerCommand', () => {
  test('builds one quoted shell line per harness; cmux gets a cd prefix; Codex keeps $buracle-join in single quotes', () => {
    const dir = "/Users/me/it's a dir"
    expect(workerCommand('claude', 'rate-limit', dir, 'tmux')).toBe(`claude '/buracle-join rate-limit'`)
    expect(workerCommand('codex', 'rate-limit', dir, 'herdr')).toBe(`codex -C '/Users/me/it'\\''s a dir' '$buracle-join rate-limit'`)
    expect(workerCommand('opencode', 'rate-limit', dir, 'tmux')).toBe(`opencode --prompt '/buracle-join rate-limit' '/Users/me/it'\\''s a dir'`)
    expect(workerCommand('omp', 'rate-limit', dir, 'tmux')).toBe(`omp --cwd='/Users/me/it'\\''s a dir' '/buracle-join rate-limit'`)
    expect(workerCommand('claude', 'rate-limit', dir, 'cmux')).toBe(`cd '/Users/me/it'\\''s a dir' && claude '/buracle-join rate-limit'`)
  })
})

describe('tmux adapter', () => {
  test('open inside tmux splits the lead pane, allows passthrough, titles the pane and records pid and socket; the window is never re-tiled', async () => {
    const f = fakeExec(argv => {
      if (argv[1] === 'split-window') return '%7\n'
      if (argv[1] === 'display-message') return '4242 /private/tmp/tmux-501/default\n'
      return undefined
    })
    const a = muxAdapter('tmux', { ...TMUX_ENV }, { exec: f.exec })
    if (!a.ok) throw new Error(a.message)
    const opened = await a.adapter.open({ cwd: '/repo', command: `claude '/buracle-join rate-limit'`, title: 'buracle rate-limit claude 1', slug: 'rate-limit' })
    expect(opened).toEqual({ id: '%7', server: '/private/tmp/tmux-501/default', pid: '4242' })
    expect(f.lines()).toEqual([
      `tmux split-window -d -h -c /repo -P -F #{pane_id} -t %3 claude '/buracle-join rate-limit'`,
      'tmux set-option -p -t %7 allow-passthrough on',
      'tmux select-pane -t %7 -T buracle rate-limit claude 1',
      'tmux display-message -p -t %7 #{pane_pid} #{socket_path}',
    ])
  })

  test('a split spec names the pane to split, the direction and the share the new pane takes (percent of the pane it splits); the lead is the pane in TMUX_PANE', async () => {
    const f = fakeExec(argv => {
      if (argv[1] === 'split-window' || argv[1] === 'new-session') return '%9\n'
      if (argv[1] === 'display-message') return '1 /tmp/s\n'
      return undefined
    })
    const inside = muxAdapter('tmux', { ...TMUX_ENV }, { exec: f.exec })
    if (!inside.ok) throw new Error(inside.message)
    await inside.adapter.open({ cwd: '/repo', command: 'c', title: 't', slug: 'rate-limit', split: { target: pane({ id: '%7' }), direction: 'right', keep: 0.25 } })
    expect(f.lines()[0]).toBe('tmux split-window -d -h -l 75% -c /repo -P -F #{pane_id} -t %7 c')
    await inside.adapter.open({ cwd: '/repo', command: 'c', title: 't', slug: 'rate-limit', split: { target: 'lead', direction: 'down', keep: 0.4 } })
    expect(f.lines().filter(l => l.startsWith('tmux split-window'))[1]).toBe('tmux split-window -d -v -l 60% -c /repo -P -F #{pane_id} -t %3 c')
    expect(f.lines().some(l => l.includes('select-layout'))).toBe(false)

    let sessions = 0
    const g = fakeExec(argv => {
      if (argv[1] === 'has-session') return sessions > 0 ? { code: 0 } : { code: 1, stderr: "can't find session: buracle-rate-limit" }
      if (argv[1] === 'new-session') { sessions++; return '%0\n' }
      if (argv[1] === 'split-window') return '%1\n'
      if (argv[1] === 'display-message') return '1 /tmp/s\n'
      return undefined
    })
    const outside = muxAdapter('tmux', {}, { exec: g.exec })
    if (!outside.ok) throw new Error(outside.message)
    const first = await outside.adapter.open({ cwd: '/repo', command: 'c', title: 't', slug: 'rate-limit' })
    expect(first).toMatchObject({ id: '%0', attach: 'tmux attach -t buracle-rate-limit' })
    const second = await outside.adapter.open({ cwd: '/repo', command: 'd', title: 't2', slug: 'rate-limit' })
    expect(second).toMatchObject({ id: '%1' })
    const opens = g.lines().filter(l => /has-session|new-session|split-window/.test(l))
    expect(opens).toEqual([
      'tmux has-session -t =buracle-rate-limit',
      'tmux new-session -d -s buracle-rate-limit -c /repo -P -F #{pane_id} c',
      'tmux has-session -t =buracle-rate-limit',
      'tmux split-window -d -v -c /repo -P -F #{pane_id} -t buracle-rate-limit: d',
    ])
  })

  test('an older tmux that does not take a percent size is asked again with -p; one that refuses both opens no pane', async () => {
    const old = fakeExec(argv => {
      if (argv[1] === 'split-window' && argv.includes('-l')) return { code: 1, stderr: 'size invalid' }
      if (argv[1] === 'split-window') return '%9\n'
      if (argv[1] === 'display-message') return '1 /tmp/s\n'
      return undefined
    })
    const a = muxAdapter('tmux', { ...TMUX_ENV }, { exec: old.exec })
    if (!a.ok) throw new Error(a.message)
    expect(await a.adapter.open({ cwd: '/repo', command: 'c', title: 't', slug: 'rate-limit', split: { target: 'lead', direction: 'down', keep: 0.4 } })).toMatchObject({ id: '%9' })
    expect(old.lines().filter(l => l.startsWith('tmux split-window'))).toEqual([
      'tmux split-window -d -v -l 60% -c /repo -P -F #{pane_id} -t %3 c',
      'tmux split-window -d -v -p 60 -c /repo -P -F #{pane_id} -t %3 c',
    ])
    const none = fakeExec(argv => (argv[1] === 'split-window' ? { code: 1, stderr: 'no space for new pane' } : undefined))
    const b = muxAdapter('tmux', { ...TMUX_ENV }, { exec: none.exec })
    if (!b.ok) throw new Error(b.message)
    expect(await b.adapter.open({ cwd: '/repo', command: 'c', title: 't', slug: 'rate-limit', split: { target: 'lead', direction: 'down', keep: 0.4 } })).toBeUndefined()
  })

  test('a TMUX_PANE that is not a tmux pane id is not handed to tmux as a target', async () => {
    const f = fakeExec(argv => (argv[1] === 'split-window' ? '%7\n' : argv[1] === 'display-message' ? '1 /tmp/s\n' : undefined))
    const a = muxAdapter('tmux', { TMUX: '/private/tmp/tmux-501/default,812,0', TMUX_PANE: '%3; touch /tmp/x' }, { exec: f.exec })
    if (!a.ok) throw new Error(a.message)
    await a.adapter.open({ cwd: '/repo', command: 'c', title: 't', slug: 'rate-limit', split: { target: 'lead', direction: 'down', keep: 0.5 } })
    expect(f.lines()[0]).toBe('tmux split-window -d -v -l 50% -c /repo -P -F #{pane_id} c')
  })

  test('a split target that does not look like a pane id of that multiplexer is refused before any split runs, on all three adapters', () => withSandbox(async ({ root }) => {
    const cases: Array<[Parameters<typeof muxAdapter>[0], Record<string, string>, string[]]> = [
      ['tmux', { ...TMUX_ENV }, ['-x', '%7;ls', 'w2:p5', '%7 -t %1']],
      ['herdr', { ...HERDR_ENV }, ['-x', 'w2:p5 --foo', '%7', 'surface:1']],
      ['cmux', { ...CMUX_ENV }, ['-x', 'surface:1 --foo', '%7', 'w2:p5']],
    ]
    for (const [kind, env, bad] of cases) {
      for (const id of bad) {
        const f = fakeExec(argv => (argv.includes('list-panels') ? 'workspace:2\n' : undefined))
        const a = muxAdapter(kind, env, { exec: f.exec, cmuxBin: join(root, 'cmux') })
        if (!a.ok) throw new Error(a.message)
        expect(await a.adapter.open({ cwd: '/repo', command: 'c', title: 't', slug: 's', split: { target: pane({ id }), direction: 'right', keep: 0.5 } })).toBeUndefined()
        expect(f.lines().filter(l => /split/.test(l))).toEqual([])
      }
    }
  }))

  test('mark titles, marks and rings the bell on the pane tty; clearMark restores the title and drops only our mark; focus selects window and pane', () => withSandbox(async ({ root }) => {
    const tty = join(root, 'pane.tty')
    let marked = '1'
    const f = fakeExec(argv => (argv[1] === 'display-message' ? (argv.includes('#{pane_marked}') ? `${marked}\n` : `${tty}\n`) : undefined))
    const a = muxAdapter('tmux', { ...TMUX_ENV }, { exec: f.exec })
    if (!a.ok) throw new Error(a.message)
    const p = pane({ id: '%7', pid: '4242', server: '/tmp/s' })
    expect(await a.adapter.mark(p, 'Task 2 needs you')).toBe(true)
    expect(readFileSync(tty, 'utf8')).toBe('\x07')
    expect(await a.adapter.clearMark(p)).toBe(true)
    expect(await a.adapter.focus(p)).toBe(true)
    expect(f.lines()).toEqual([
      'tmux select-pane -t %7 -T Task 2 needs you',
      'tmux select-pane -m -t %7',
      'tmux display-message -p -t %7 #{pane_tty}',
      'tmux select-pane -t %7 -T buracle rate-limit claude 1',
      'tmux display-message -p -t %7 #{pane_marked}',
      'tmux select-pane -M',
      'tmux select-window -t %7',
      'tmux select-pane -t %7',
    ])
    marked = '0'
    f.calls.length = 0
    expect(await a.adapter.clearMark(p)).toBe(true)
    expect(f.lines()).toEqual(['tmux select-pane -t %7 -T buracle rate-limit claude 1', 'tmux display-message -p -t %7 #{pane_marked}'])
  }))

  test('a multiplexer that does not answer (timeout, missing binary) is failed, not stale: nothing is killed and the record may stay', async () => {
    const down = fakeExec(() => ({ code: 124, stderr: 'timed out' }))
    const a = muxAdapter('tmux', { ...TMUX_ENV }, { exec: down.exec })
    if (!a.ok) throw new Error(a.message)
    expect(await a.adapter.alive(pane({ id: '%7', pid: '4242', server: '/tmp/s' }))).toBe(false)
    expect(await a.adapter.close(pane({ id: '%7', pid: '4242', server: '/tmp/s' }))).toEqual({ ok: false, reason: 'failed' })
    const missing = fakeExec(() => ({ code: 127, stderr: 'not found' }))
    const h = muxAdapter('herdr', { ...HERDR_ENV }, { exec: missing.exec })
    if (!h.ok) throw new Error(h.message)
    expect(await h.adapter.close(pane({ id: 'w2:p5', server: HERDR_ENV.HERDR_SOCKET_PATH }))).toEqual({ ok: false, reason: 'failed' })
    expect(down.lines().some(l => l.includes('kill-pane'))).toBe(false)
    expect(missing.lines().some(l => l.includes('pane close'))).toBe(false)
  })

  test('alive and close compare the recorded pid first: a reused pane id is stale and nothing is killed; a matching one is killed', async () => {
    const f = fakeExec(argv => (argv[1] === 'display-message' ? '4242 /tmp/s\n' : undefined))
    const a = muxAdapter('tmux', { ...TMUX_ENV }, { exec: f.exec })
    if (!a.ok) throw new Error(a.message)
    expect(await a.adapter.alive(pane({ id: '%7', pid: '4242', server: '/tmp/s' }))).toBe(true)
    expect(await a.adapter.alive(pane({ id: '%7', pid: '999', server: '/tmp/s' }))).toBe(false)
    expect(await a.adapter.close(pane({ id: '%7', pid: '999', server: '/tmp/s' }))).toEqual({ ok: false, reason: 'stale' })
    expect(await a.adapter.close(pane({ id: '%7', pid: '4242', server: '/other' }))).toEqual({ ok: false, reason: 'stale' })
    expect(f.lines().some(l => l.startsWith('tmux kill-pane'))).toBe(false)
    expect(await a.adapter.close(pane({ id: '%7', pid: '4242', server: '/tmp/s' }))).toEqual({ ok: true })
    expect(f.lines().at(-1)).toBe('tmux kill-pane -t %7')
    const gone = fakeExec(() => ({ code: 1, stderr: "can't find pane: %7" }))
    const b = muxAdapter('tmux', { ...TMUX_ENV }, { exec: gone.exec })
    if (!b.ok) throw new Error(b.message)
    expect(await b.adapter.alive(pane({ id: '%7', pid: '4242', server: '/tmp/s' }))).toBe(false)
    expect(await b.adapter.close(pane({ id: '%7', pid: '4242', server: '/tmp/s' }))).toEqual({ ok: false, reason: 'stale' })
  })
})

describe('herdr adapter', () => {
  const split = JSON.stringify({ ok: true, result: { pane: { pane_id: 'w2:p5', tab_id: 'w2:t1' } } })

  test('open splits the current pane (or the pane a split spec names) with the share the pane keeps, renames the new one and runs the command; the server is the socket path', async () => {
    const f = fakeExec(argv => (argv[2] === 'split' ? split : undefined))
    const a = muxAdapter('herdr', { ...HERDR_ENV }, { exec: f.exec })
    if (!a.ok) throw new Error(a.message)
    const opened = await a.adapter.open({ cwd: '/repo', command: `claude '/buracle-join rate-limit'`, title: 'buracle rate-limit claude 1', slug: 'rate-limit' })
    expect(opened).toEqual({ id: 'w2:p5', server: HERDR_ENV.HERDR_SOCKET_PATH })
    await a.adapter.open({ cwd: '/repo', command: 'c2', title: 't2', slug: 'rate-limit', split: { target: pane({ id: 'w2:p5' }), direction: 'right', keep: 0.25 } })
    await a.adapter.open({ cwd: '/repo', command: 'c3', title: 't3', slug: 'rate-limit', split: { target: 'lead', direction: 'down', keep: 1 / 3 } })
    expect(f.lines()).toEqual([
      'herdr pane split --current --direction right --cwd /repo --no-focus',
      'herdr pane rename w2:p5 buracle rate-limit claude 1',
      `herdr pane run w2:p5 claude '/buracle-join rate-limit'`,
      'herdr pane split --pane w2:p5 --direction right --ratio 0.25 --cwd /repo --no-focus',
      'herdr pane rename w2:p5 t2',
      'herdr pane run w2:p5 c2',
      'herdr pane split --current --direction down --ratio 0.333 --cwd /repo --no-focus',
      'herdr pane rename w2:p5 t3',
      'herdr pane run w2:p5 c3',
    ])
    const broken = fakeExec(argv => (argv[2] === 'split' ? 'not json' : undefined))
    const b = muxAdapter('herdr', { ...HERDR_ENV }, { exec: broken.exec })
    if (!b.ok) throw new Error(b.message)
    expect(await b.adapter.open({ cwd: '/repo', command: 'c', title: 't', slug: 's' })).toBeUndefined()
    // A pane whose command could not be typed is an empty shell: it is closed again and counts as not opened.
    const norun = fakeExec(argv => (argv[2] === 'split' ? split : argv[2] === 'run' ? { code: 1, stderr: '{"error":{"code":"pane_busy"}}' } : undefined))
    const c = muxAdapter('herdr', { ...HERDR_ENV }, { exec: norun.exec })
    if (!c.ok) throw new Error(c.message)
    expect(await c.adapter.open({ cwd: '/repo', command: 'c', title: 't', slug: 's' })).toBeUndefined()
    expect(norun.lines().at(-1)).toBe('herdr pane close w2:p5')
  })

  test('herdr hands out opaque pane ids written in base 36 (w2:p9, then w2:pA, w2:pH on a real herdr): open, paneIdOf and validPaneId take them; anything that could pass for a flag or a second argument stays out', async () => {
    for (const id of ['w2:pA', 'w2:pB', 'w2:pF', 'w2:pG', 'w2:pH', 'w2:pZ', 'w2:p10', 'w2:p1f', 'w12:p3']) expect(validPaneId('herdr', id)).toBe(true)
    for (const id of ['', 'w2:p', 'w2:', 'p5', 'w2:p-1', '-w2:p1', 'w2:p1;ls', 'w2:p1 x', 'w2:p1\n', 'w2:pA/../x', '%1']) expect(validPaneId('herdr', id)).toBe(false)
    expect(paneIdOf('herdr', { ...HERDR_ENV, HERDR_PANE_ID: 'w2:pB' })).toBe('w2:pB')
    const hex = JSON.stringify({ ok: true, result: { pane: { pane_id: 'w2:pA', tab_id: 'w2:t1' } } })
    const f = fakeExec(argv => (argv[2] === 'split' ? hex : undefined))
    const a = muxAdapter('herdr', { ...HERDR_ENV }, { exec: f.exec })
    if (!a.ok) throw new Error(a.message)
    expect(await a.adapter.open({ cwd: '/repo', command: 'c', title: 'Worker 3', slug: 'rate-limit' })).toEqual({ id: 'w2:pA', server: HERDR_ENV.HERDR_SOCKET_PATH })
    expect(f.lines()).toEqual([
      'herdr pane split --current --direction right --cwd /repo --no-focus',
      'herdr pane rename w2:pA Worker 3',
      'herdr pane run w2:pA c',
    ])
    expect(await a.adapter.presence(pane({ id: 'w2:pA', server: HERDR_ENV.HERDR_SOCKET_PATH }))).toBe('ok')
  })

  test('a split that worked but gave an id Buracle does not know the shape of is closed again, so no empty shell stays behind; an id that could pass for a flag is never handed to a command', async () => {
    const odd = JSON.stringify({ ok: true, result: { pane: { pane_id: 'w2:p#7' } } })
    const f = fakeExec(argv => (argv[2] === 'split' ? odd : undefined))
    const a = muxAdapter('herdr', { ...HERDR_ENV }, { exec: f.exec })
    if (!a.ok) throw new Error(a.message)
    expect(await a.adapter.open({ cwd: '/repo', command: 'c', title: 't', slug: 's' })).toBeUndefined()
    // The pane is closed by the id herdr just gave for it; the command is never run in it, and it is not renamed.
    expect(f.lines()).toEqual(['herdr pane split --current --direction right --cwd /repo --no-focus', 'herdr pane close w2:p#7'])
    for (const bad of ['-w2:p1', '', 'w2:p1 x', 12, null]) {
      const g = fakeExec(argv => (argv[2] === 'split' ? JSON.stringify({ ok: true, result: { pane: { pane_id: bad } } }) : undefined))
      const b = muxAdapter('herdr', { ...HERDR_ENV }, { exec: g.exec })
      if (!b.ok) throw new Error(b.message)
      expect(await b.adapter.open({ cwd: '/repo', command: 'c', title: 't', slug: 's' })).toBeUndefined()
      expect(g.lines()).toEqual(['herdr pane split --current --direction right --cwd /repo --no-focus'])
    }
  })

  test('mark is a no-op (notifyTerminal reports blocked), clearMark reports working with the pane harness, focus uses agent focus, alive and close check the socket', async () => {
    const f = fakeExec(argv => (argv[2] === 'get' ? JSON.stringify({ ok: true, result: { pane: { pane_id: 'w2:p5' } } }) : undefined))
    const a = muxAdapter('herdr', { ...HERDR_ENV }, { exec: f.exec })
    if (!a.ok) throw new Error(a.message)
    const p = pane({ id: 'w2:p5', harness: 'codex', server: HERDR_ENV.HERDR_SOCKET_PATH })
    expect(await a.adapter.mark(p, 'Task 2 needs you')).toBe(true)
    expect(f.calls).toEqual([])
    expect(await a.adapter.clearMark(p)).toBe(true)
    expect(await a.adapter.focus(p)).toBe(true)
    expect(await a.adapter.alive(p)).toBe(true)
    expect(await a.adapter.close(p)).toEqual({ ok: true })
    expect(f.lines()).toEqual([
      'herdr pane report-agent w2:p5 --source buracle --agent codex --state working',
      'herdr agent focus w2:p5',
      'herdr pane get w2:p5',
      'herdr pane get w2:p5',
      'herdr pane close w2:p5',
    ])
    const other = pane({ id: 'w2:p5', server: '/elsewhere/herdr.sock' })
    expect(await a.adapter.alive(other)).toBe(false)
    expect(await a.adapter.close(other)).toEqual({ ok: false, reason: 'stale' })
    expect(f.lines().filter(l => l === 'herdr pane close w2:p5')).toHaveLength(1)
  })
})

describe('cmux adapter', () => {
  // `cmux list-panels` lists every surface of the workspace; `list-pane-surfaces` lists the surfaces of the focused pane
  // only, and a split opened with --focus false is a pane of its own, so that one would never show the new surface.
  const U = (n: number): string => `aaaaaaaa-0000-4000-8000-00000000000${n}`
  const before = `workspace:2\nsurface:1 ${U(2)} "zsh"\n`
  const after = `${before}surface:4 ${U(4)} "claude"\n`
  const LIST = ['--id-format', 'both', 'list-panels']
  const isList = (argv: string[]): boolean => argv.slice(1).join(' ') === LIST.join(' ')

  test('open lists the surfaces of the whole workspace before and after new-split and takes the new ids; the command gets a cd prefix by the caller', () => withSandbox(async ({ root }) => {
    let listed = 0
    const f = fakeExec(argv => (isList(argv) ? (listed++ === 0 ? before : after) : undefined))
    const bin = join(root, 'cmux')
    const a = muxAdapter('cmux', { ...CMUX_ENV }, { exec: f.exec, cmuxBin: bin })
    if (!a.ok) throw new Error(a.message)
    const opened = await a.adapter.open({ cwd: '/repo', command: `cd '/repo' && claude '/buracle-join rate-limit'`, title: 'Worker 1 (claude) · waiting for a task', slug: 'rate-limit' })
    expect(opened).toEqual({ id: U(4), ids: ['surface:4', U(4)], server: CMUX_ENV.CMUX_SOCKET_PATH })
    expect(f.lines()).toEqual([
      `${bin} ${LIST.join(' ')}`,
      `${bin} new-split right --command cd '/repo' && claude '/buracle-join rate-limit' --focus false`,
      `${bin} ${LIST.join(' ')}`,
      `${bin} rename-tab --surface ${U(4)} -- Worker 1 (claude) · waiting for a task`,
    ])
    const same = fakeExec(argv => (isList(argv) ? before : undefined))
    const b = muxAdapter('cmux', { ...CMUX_ENV }, { exec: same.exec, cmuxBin: bin })
    if (!b.ok) throw new Error(b.message)
    expect(await b.adapter.open({ cwd: '/repo', command: 'c', title: 't', slug: 's' })).toBeUndefined()
  }))

  test('open takes the new surface from the output of new-split when the second listing fails: the split is never left behind unrecorded', () => withSandbox(async ({ root }) => {
    let listed = 0
    const f = fakeExec(argv => {
      if (isList(argv)) return listed++ === 0 ? before : { code: 1, stderr: 'timed out' }
      if (argv[1] === 'new-split') return `OK surface:4 ${U(4)} pane:3 workspace:2\n`
      return undefined
    })
    const bin = join(root, 'cmux')
    const a = muxAdapter('cmux', { ...CMUX_ENV }, { exec: f.exec, cmuxBin: bin })
    if (!a.ok) throw new Error(a.message)
    expect(await a.adapter.open({ cwd: '/repo', command: 'c', title: 't', slug: 's' })).toEqual({ id: U(4), ids: ['surface:4', U(4), 'pane:3'], server: CMUX_ENV.CMUX_SOCKET_PATH })
  }))

  test('open takes the surface that new-split names, not one a person or another tool opened in the workspace between the two listings', () => withSandbox(async ({ root }) => {
    let listed = 0
    const stranger = `${after}surface:9 ${U(9)} "someone else"\n`
    const f = fakeExec(argv => {
      if (isList(argv)) return listed++ === 0 ? before : stranger
      if (argv[1] === 'new-split') return `OK surface:4 ${U(4)}\n`
      return undefined
    })
    const bin = join(root, 'cmux')
    const a = muxAdapter('cmux', { ...CMUX_ENV }, { exec: f.exec, cmuxBin: bin })
    if (!a.ok) throw new Error(a.message)
    // close-surface would later run on this id: it must be the split Buracle made.
    expect(await a.adapter.open({ cwd: '/repo', command: 'c', title: 't', slug: 's' })).toEqual({ id: U(4), ids: ['surface:4', U(4)], server: CMUX_ENV.CMUX_SOCKET_PATH })
  }))

  test('a split spec names the surface to split and the direction; cmux has no size flag, so the share is left to cmux (an even split)', () => withSandbox(async ({ root }) => {
    let listed = 0
    const f = fakeExec(argv => {
      if (isList(argv)) return listed++ % 2 === 0 ? before : after
      if (argv[1] === 'new-split') return `OK surface:4 ${U(4)}\n`
      return undefined
    })
    const bin = join(root, 'cmux')
    const a = muxAdapter('cmux', { ...CMUX_ENV }, { exec: f.exec, cmuxBin: bin })
    if (!a.ok) throw new Error(a.message)
    await a.adapter.open({ cwd: '/repo', command: 'c', title: 't', slug: 's', split: { target: 'lead', direction: 'down', keep: 0.5 } })
    await a.adapter.open({ cwd: '/repo', command: 'd', title: 't', slug: 's', split: { target: pane({ id: 'surface:1' }), direction: 'right', keep: 0.25 } })
    expect(f.lines().filter(l => l.includes(' new-split '))).toEqual([
      `${bin} new-split down --command c --focus false`,
      `${bin} new-split right --surface surface:1 --command d --focus false`,
    ])
  }))

  test('mark is a no-op, clearMark clears notifications, focus selects the workspace and the surface, alive and close use the surface id and the socket', () => withSandbox(async ({ root }) => {
    const f = fakeExec(argv => (isList(argv) ? after : undefined))
    const bin = join(root, 'cmux')
    const a = muxAdapter('cmux', { ...CMUX_ENV }, { exec: f.exec, cmuxBin: bin })
    if (!a.ok) throw new Error(a.message)
    const p = pane({ id: U(4), ids: ['surface:4', U(4)], server: CMUX_ENV.CMUX_SOCKET_PATH })
    expect(await a.adapter.mark(p, 'x')).toBe(true)
    expect(f.calls).toEqual([])
    expect(await a.adapter.clearMark(p)).toBe(true)
    expect(await a.adapter.focus(p)).toBe(true)
    expect(await a.adapter.alive(p)).toBe(true)
    expect(await a.adapter.close(p)).toEqual({ ok: true })
    expect(f.lines()).toEqual([
      `${bin} clear-notifications --surface ${U(4)}`,
      `${bin} select-workspace --workspace workspace:2`,
      `${bin} focus-panel --panel ${U(4)}`,
      `${bin} ${LIST.join(' ')}`,
      `${bin} ${LIST.join(' ')}`,
      `${bin} close-surface --surface ${U(4)}`,
    ])
    expect(await a.adapter.alive(pane({ id: 'aaaaaaaa-0000-4000-8000-000000000009', server: CMUX_ENV.CMUX_SOCKET_PATH }))).toBe(false)
    expect(await a.adapter.close(pane({ id: p.id, server: '/elsewhere.sock' }))).toEqual({ ok: false, reason: 'stale' })
  }))

  test('the cmux binary comes from PATH, else from the app bundle, else cmux_missing', () => withSandbox(async ({ root }) => {
    const missing = cmuxBin({ PATH: onlyPath(join(root, 'empty')) }, join(root, 'no-app', 'cmux'))
    expect(missing).toBeUndefined()
    const a = muxAdapter('cmux', { ...CMUX_ENV, PATH: onlyPath(join(root, 'empty')) }, { exec: fakeExec().exec, appBin: join(root, 'no-app', 'cmux') })
    expect(a).toMatchObject({ ok: false, code: 'cmux_missing' })
    expect(existsSync(join(root, 'no-app', 'cmux'))).toBe(false)
  }))
})

describe('third review round', () => {
  test('tmux open records the socket path from TMUX when display-message gives no answer, without a pid', async () => {
    for (const code of [124, 1]) {
      const f = fakeExec(argv => (argv[1] === 'split-window' ? '%7\n' : argv[1] === 'display-message' ? { code, stderr: 'no answer' } : undefined))
      const a = muxAdapter('tmux', { ...TMUX_ENV }, { exec: f.exec })
      if (!a.ok) throw new Error(a.message)
      const opened = await a.adapter.open({ cwd: '/repo', command: 'c', title: 't', slug: 'rate-limit' })
      expect(opened).toEqual({ id: '%7', server: '/private/tmp/tmux-501/default' })
    }
    const outside = fakeExec(argv => (argv[1] === 'has-session' ? { code: 1 } : argv[1] === 'new-session' ? '%0\n' : argv[1] === 'display-message' ? { code: 124 } : undefined))
    const b = muxAdapter('tmux', {}, { exec: outside.exec })
    if (!b.ok) throw new Error(b.message)
    expect(await b.adapter.open({ cwd: '/repo', command: 'c', title: 't', slug: 'rate-limit' })).toEqual({ id: '%0', server: '', attach: 'tmux attach -t buracle-rate-limit' })
  })

  test('herdr presence: only a not_found error means the pane is gone; any other error is a failure that keeps the record', async () => {
    const other = fakeExec(() => ({ code: 1, stderr: '{"error":{"code":"connection_refused"}}' }))
    const a = muxAdapter('herdr', { ...HERDR_ENV }, { exec: other.exec })
    if (!a.ok) throw new Error(a.message)
    const p = pane({ id: 'w2:p5', server: HERDR_ENV.HERDR_SOCKET_PATH })
    expect(await a.adapter.presence(p)).toBe('failed')
    expect(await a.adapter.close(p)).toEqual({ ok: false, reason: 'failed' })
    const gone = fakeExec(() => ({ code: 1, stderr: '{"error":{"code":"pane_not_found","message":"pane w2:p5 not found"}}' }))
    const b = muxAdapter('herdr', { ...HERDR_ENV }, { exec: gone.exec })
    if (!b.ok) throw new Error(b.message)
    expect(await b.adapter.presence(p)).toBe('stale')
  })
})
