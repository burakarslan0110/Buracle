import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MuxExec, MuxExecResult, MuxPane } from '../../src/workflow/mux'
import { cmuxBin, detectMux, muxAdapter, paneIdOf, validPaneId, workerCommand } from '../../src/workflow/mux'
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
  test('open inside tmux splits the lead pane, tiles, allows passthrough, titles the pane and records pid and socket', async () => {
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
      'tmux select-layout -t %7 tiled',
      'tmux set-option -p -t %7 allow-passthrough on',
      'tmux select-pane -t %7 -T buracle rate-limit claude 1',
      'tmux display-message -p -t %7 #{pane_pid} #{socket_path}',
    ])
  })

  test('open after a worker pane splits that pane down; outside tmux the first open creates buracle-<slug> and the next one splits it', async () => {
    const f = fakeExec(argv => {
      if (argv[1] === 'split-window' || argv[1] === 'new-session') return '%9\n'
      if (argv[1] === 'display-message') return '1 /tmp/s\n'
      return undefined
    })
    const inside = muxAdapter('tmux', { ...TMUX_ENV }, { exec: f.exec })
    if (!inside.ok) throw new Error(inside.message)
    await inside.adapter.open({ cwd: '/repo', command: 'c', title: 't', slug: 'rate-limit', after: pane({ id: '%7' }) })
    expect(f.lines()[0]).toBe('tmux split-window -d -v -c /repo -P -F #{pane_id} -t %7 c')

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

  test('open splits the current pane right (or the previous worker pane down), renames it and runs the command; the server is the socket path', async () => {
    const f = fakeExec(argv => (argv[2] === 'split' ? split : undefined))
    const a = muxAdapter('herdr', { ...HERDR_ENV }, { exec: f.exec })
    if (!a.ok) throw new Error(a.message)
    const opened = await a.adapter.open({ cwd: '/repo', command: `claude '/buracle-join rate-limit'`, title: 'buracle rate-limit claude 1', slug: 'rate-limit' })
    expect(opened).toEqual({ id: 'w2:p5', server: HERDR_ENV.HERDR_SOCKET_PATH })
    await a.adapter.open({ cwd: '/repo', command: 'c2', title: 't2', slug: 'rate-limit', after: pane({ id: 'w2:p5' }) })
    expect(f.lines()).toEqual([
      'herdr pane split --current --direction right --cwd /repo --no-focus',
      'herdr pane rename w2:p5 buracle rate-limit claude 1',
      `herdr pane run w2:p5 claude '/buracle-join rate-limit'`,
      'herdr pane split --pane w2:p5 --direction down --cwd /repo --no-focus',
      'herdr pane rename w2:p5 t2',
      'herdr pane run w2:p5 c2',
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
  const before = JSON.stringify([{ pane: 'pane:1', pane_id: 'aaaaaaaa-0000-4000-8000-000000000001', surfaces: [{ ref: 'surface:1', id: 'aaaaaaaa-0000-4000-8000-000000000002' }] }])
  const after = JSON.stringify([
    { pane: 'pane:1', pane_id: 'aaaaaaaa-0000-4000-8000-000000000001', surfaces: [{ ref: 'surface:1', id: 'aaaaaaaa-0000-4000-8000-000000000002' }] },
    { pane: 'pane:3', pane_id: 'aaaaaaaa-0000-4000-8000-000000000003', surfaces: [{ ref: 'surface:4', id: 'aaaaaaaa-0000-4000-8000-000000000004' }] },
  ])

  test('open lists surfaces before and after new-split and takes the new ids; the command gets a cd prefix by the caller', () => withSandbox(async ({ root }) => {
    let listed = 0
    const f = fakeExec(argv => (argv[1] === 'list-pane-surfaces' ? (listed++ === 0 ? before : after) : undefined))
    const bin = join(root, 'cmux')
    const a = muxAdapter('cmux', { ...CMUX_ENV }, { exec: f.exec, cmuxBin: bin })
    if (!a.ok) throw new Error(a.message)
    const opened = await a.adapter.open({ cwd: '/repo', command: `cd '/repo' && claude '/buracle-join rate-limit'`, title: 'buracle rate-limit claude 1', slug: 'rate-limit' })
    expect(opened).toEqual({ id: 'aaaaaaaa-0000-4000-8000-000000000004', ids: ['pane:3', 'aaaaaaaa-0000-4000-8000-000000000003', 'surface:4', 'aaaaaaaa-0000-4000-8000-000000000004'], server: CMUX_ENV.CMUX_SOCKET_PATH })
    expect(f.lines()).toEqual([
      `${bin} list-pane-surfaces --json --id-format both`,
      `${bin} new-split right --command cd '/repo' && claude '/buracle-join rate-limit' --focus false`,
      `${bin} list-pane-surfaces --json --id-format both`,
      `${bin} rename-tab --surface aaaaaaaa-0000-4000-8000-000000000004 buracle rate-limit claude 1`,
    ])
    const same = fakeExec(argv => (argv[1] === 'list-pane-surfaces' ? before : undefined))
    const b = muxAdapter('cmux', { ...CMUX_ENV }, { exec: same.exec, cmuxBin: bin })
    if (!b.ok) throw new Error(b.message)
    expect(await b.adapter.open({ cwd: '/repo', command: 'c', title: 't', slug: 's' })).toBeUndefined()
  }))

  test('mark is a no-op, clearMark clears notifications, focus selects the workspace and the pane of the surface, alive and close use the surface id and the socket', () => withSandbox(async ({ root }) => {
    const f = fakeExec(argv => (argv[1] === 'list-pane-surfaces' ? after : undefined))
    const bin = join(root, 'cmux')
    const a = muxAdapter('cmux', { ...CMUX_ENV }, { exec: f.exec, cmuxBin: bin })
    if (!a.ok) throw new Error(a.message)
    const p = pane({ id: 'aaaaaaaa-0000-4000-8000-000000000004', ids: ['pane:3', 'surface:4', 'aaaaaaaa-0000-4000-8000-000000000004'], server: CMUX_ENV.CMUX_SOCKET_PATH })
    expect(await a.adapter.mark(p, 'x')).toBe(true)
    expect(f.calls).toEqual([])
    expect(await a.adapter.clearMark(p)).toBe(true)
    expect(await a.adapter.focus(p)).toBe(true)
    expect(await a.adapter.alive(p)).toBe(true)
    expect(await a.adapter.close(p)).toEqual({ ok: true })
    expect(f.lines()).toEqual([
      `${bin} clear-notifications --surface aaaaaaaa-0000-4000-8000-000000000004`,
      `${bin} select-workspace --workspace workspace:2`,
      `${bin} focus-pane --pane pane:3`,
      `${bin} list-pane-surfaces --json --id-format both`,
      `${bin} list-pane-surfaces --json --id-format both`,
      `${bin} close-surface --surface aaaaaaaa-0000-4000-8000-000000000004`,
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
