import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { userConfigFile } from '../../src/engine/paths'
import { workAsk, workClose, workDone, workJoin, workMerge, workPublish, workResume, workStatus } from '../../src/workflow/board'
import { readBoard } from '../../src/workflow/board-store'
import { workSpawn } from '../../src/workflow/board-panes'
import type { MuxExec, MuxExecResult } from '../../src/workflow/mux'
import { workerCommand } from '../../src/workflow/mux'
import { muxStorePath, readMuxStore, writeMuxStore } from '../../src/workflow/mux-store'
import type { ResolvedSession } from '../../src/workflow/session-store'
import { writeTelemetry } from '../../src/workflow/session-store'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { ctxAt, g, makeRepo, planDoc, write } from './fixture'

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0)
const LEAD: ResolvedSession = { harness: 'claude', sessionId: 'lead-1', source: '--session' }
const W = (harness: ResolvedSession['harness'], id: string): ResolvedSession => ({ harness, sessionId: id, source: '--session' })
const A = W('codex', 'worker-a')
const HERDR_ENV = { HERDR_ENV: '1', HERDR_PANE_ID: 'w2:p0', HERDR_TAB_ID: 'w2:t1', HERDR_WORKSPACE_ID: 'w2', HERDR_SOCKET_PATH: '/Users/me/.config/herdr/herdr.sock' }

function sandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  return withSandbox(({ root }) => withEnv({ BURACLE_NO_MEMORY: '1', BURACLE_LOCK_TIMEOUT_MS: '2000' }, () => fn(root)))
}

async function published(root: string, o: { n?: number, dep?: boolean, maxWorkers?: number, name?: string } = {}): Promise<{ repo: string, plan: string, path: string, commonDir: string }> {
  const repo = await makeRepo(root, o.name ?? 'repo')
  const plan = join(repo, 'docs', 'plan-build', '2026-11-08-rate-limit.md')
  let doc = planDoc({ n: o.n ?? 3, status: 'IN_PROGRESS', approved: true })
  if (o.dep === true) doc = doc.replace('- Modify: `src/s3.ts`', '- Modify: `src/s1.ts`\n- Modify: `src/s3.ts`')
  write(plan, doc)
  const pub = await workPublish({ planPath: plan, ...(o.maxWorkers !== undefined ? { maxWorkers: o.maxWorkers } : {}) }, ctxAt(repo, NOW), LEAD)
  if (pub.code !== 0) throw new Error(pub.errors.join('; '))
  const path = String(pub.data['path'])
  return { repo, plan, path, commonDir: join(path, '..', '..', '..') }
}

/** A fake herdr: `pane split` hands out w2:p1, w2:p2, …; `pane get` answers for the panes in `live`; `failSplit` breaks the n-th split. */
function fakeHerdr(o: { live?: Set<string>, failSplit?: number, getCode?: number } = {}): { exec: MuxExec, calls: string[][], lines: () => string[], reset: () => void } {
  const calls: string[][] = []
  let splits = 0
  const exec: MuxExec = async argv => {
    calls.push(argv)
    const r: MuxExecResult = { code: 0, stdout: '', stderr: '' }
    if (argv[1] === 'pane' && argv[2] === 'split') {
      splits++
      if (o.failSplit === splits) return { code: 1, stdout: '', stderr: '{"error":{"code":"layout_full"}}' }
      const id = `w2:p${splits}`
      o.live?.add(id)
      return { ...r, stdout: JSON.stringify({ ok: true, result: { pane: { pane_id: id } } }) }
    }
    if (argv[1] === 'pane' && argv[2] === 'get') {
      if (o.getCode !== undefined) return { code: o.getCode, stdout: '', stderr: 'timed out' }
      return o.live === undefined || o.live.has(argv[3] ?? '') ? r : { code: 1, stdout: '', stderr: '{"error":{"code":"not_found"}}' }
    }
    return r
  }
  return { exec, calls, lines: () => calls.map(c => c.join(' ')), reset: () => { calls.length = 0 } }
}

const which = (bin: string): boolean => ['claude', 'codex', 'opencode', 'omp'].includes(bin)

describe('work spawn', () => {
  test('opens one pane per ready task by default, round-robins the harness list, titles and records every pane', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 5 })
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)).code).toBe(0)
    const h = fakeHerdr()
    const r = await workSpawn({ harness: 'claude,codex' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })
    expect(r.errors).toEqual([])
    expect(r.code).toBe(0)
    expect(r.data).toMatchObject({ ok: true, slug: 'rate-limit', mux: 'herdr', workers: { requested: 4, opened: 4, active: 1, max: 6 }, failed: [] })
    expect((r.data['opened'] as Array<{ id: string, harness: string, title: string }>)).toEqual([
      { id: 'w2:p1', harness: 'claude', title: 'buracle rate-limit claude 1' },
      { id: 'w2:p2', harness: 'codex', title: 'buracle rate-limit codex 2' },
      { id: 'w2:p3', harness: 'claude', title: 'buracle rate-limit claude 3' },
      { id: 'w2:p4', harness: 'codex', title: 'buracle rate-limit codex 4' },
    ])
    const cwd = String(r.data['cwd'])
    expect(h.lines()).toEqual([
      `herdr pane split --current --direction right --cwd ${cwd} --no-focus`,
      'herdr pane rename w2:p1 buracle rate-limit claude 1',
      `herdr pane run w2:p1 ${workerCommand('claude', 'rate-limit', cwd, 'herdr')}`,
      `herdr pane split --pane w2:p1 --direction down --cwd ${cwd} --no-focus`,
      'herdr pane rename w2:p2 buracle rate-limit codex 2',
      `herdr pane run w2:p2 ${workerCommand('codex', 'rate-limit', cwd, 'herdr')}`,
      `herdr pane split --pane w2:p2 --direction down --cwd ${cwd} --no-focus`,
      'herdr pane rename w2:p3 buracle rate-limit claude 3',
      `herdr pane run w2:p3 ${workerCommand('claude', 'rate-limit', cwd, 'herdr')}`,
      `herdr pane split --pane w2:p3 --direction down --cwd ${cwd} --no-focus`,
      'herdr pane rename w2:p4 buracle rate-limit codex 4',
      `herdr pane run w2:p4 ${workerCommand('codex', 'rate-limit', cwd, 'herdr')}`,
    ])
    const store = readMuxStore(muxStorePath(commonDir, 'rate-limit'))
    expect(store?.mux).toBe('herdr')
    expect(store?.panes.map(p => ({ id: p.id, harness: p.harness, server: p.server, openedAt: p.openedAt, session: p.session }))).toEqual([
      { id: 'w2:p1', harness: 'claude', server: HERDR_ENV.HERDR_SOCKET_PATH, openedAt: NOW, session: undefined },
      { id: 'w2:p2', harness: 'codex', server: HERDR_ENV.HERDR_SOCKET_PATH, openedAt: NOW, session: undefined },
      { id: 'w2:p3', harness: 'claude', server: HERDR_ENV.HERDR_SOCKET_PATH, openedAt: NOW, session: undefined },
      { id: 'w2:p4', harness: 'codex', server: HERDR_ENV.HERDR_SOCKET_PATH, openedAt: NOW, session: undefined },
    ])
    expect(r.lines[0]).toContain('4 pane(s)')
    expect(r.lines.join('\n')).toContain('/buracle-join rate-limit')
  }))

  test('--workers above the free slots is clamped with a max_workers warning; from the fourth worker on a hot rate window clamps to three (usage_low)', () => sandbox(async root => {
    const { repo } = await published(root, { n: 5 })
    const h = fakeHerdr()
    const r = await workSpawn({ workers: 9 }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })
    expect(r.code).toBe(2)
    expect(r.errors.join('\n')).toContain('max_workers')
    expect(r.data).toMatchObject({ workers: { requested: 6, opened: 6, active: 0, max: 6 } })

    const { repo: repo2 } = await published(join(root, 'hot'), { n: 5 })
    writeTelemetry('claude', 'lead-1', { at: NOW, windows: [{ pct: 95, label: '5h' }], windowsAt: NOW })
    const hot = await workSpawn({}, ctxAt(repo2, NOW, HERDR_ENV), LEAD, { exec: fakeHerdr().exec, which })
    expect(hot.code).toBe(2)
    expect(hot.errors.join('\n')).toContain('usage_low')
    expect(hot.data).toMatchObject({ workers: { requested: 3, opened: 3 } })
  }))

  test('--dry-run runs nothing and always exits 0: the commands with a board, board null without one, mux null without a multiplexer', () => sandbox(async root => {
    const { repo } = await published(root, { n: 2 })
    const h = fakeHerdr()
    const r = await workSpawn({ dryRun: true, harness: 'codex' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which: () => false })
    expect(r.code).toBe(0)
    expect(h.calls).toEqual([])
    const cwd = String(r.data['cwd'])
    expect(r.data).toMatchObject({ ok: true, dryRun: true, mux: 'herdr', board: 'rate-limit' })
    expect(r.data['panes']).toEqual([
      { harness: 'codex', command: workerCommand('codex', 'rate-limit', cwd, 'herdr'), title: 'buracle rate-limit codex 1' },
      { harness: 'codex', command: workerCommand('codex', 'rate-limit', cwd, 'herdr'), title: 'buracle rate-limit codex 2' },
    ])
    const none = await workSpawn({ dryRun: true }, ctxAt(repo, NOW), LEAD, { exec: h.exec, which })
    expect(none.code).toBe(0)
    expect(none.data).toMatchObject({ ok: true, dryRun: true, mux: null, board: 'rate-limit' })
    const bare = await makeRepo(root, 'bare')
    const noBoard = await workSpawn({ dryRun: true }, ctxAt(bare, NOW, HERDR_ENV), W('claude', 'lead-2'), { exec: h.exec, which })
    expect(noBoard.code).toBe(0)
    expect(noBoard.data).toMatchObject({ ok: true, dryRun: true, mux: 'herdr', board: null })
    expect(h.calls).toEqual([])
  }))

  test('refuses: no multiplexer (no_mux with the tmux hint), an unknown --mux (usage), a worker (not_lead), unknown or missing harnesses, cmux without its CLI', () => sandbox(async root => {
    const { repo } = await published(root, { n: 2 })
    const h = fakeHerdr()
    const none = await workSpawn({}, ctxAt(repo, NOW), LEAD, { exec: h.exec, which })
    expect(none.data).toMatchObject({ error: 'no_mux' })
    expect(String(none.data['message'])).toContain('--mux tmux')
    expect((await workSpawn({ mux: 'screen' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).data['error']).toBe('usage')
    expect((await workSpawn({ mux: 'herdr' }, ctxAt(repo, NOW), LEAD, { exec: h.exec, which })).data['error']).toBe('no_mux')
    expect((await workSpawn({ mux: 'cmux' }, ctxAt(repo, NOW), LEAD, { exec: h.exec, which })).data['error']).toBe('no_mux')
    expect((await workSpawn({}, ctxAt(repo, NOW, HERDR_ENV), A, { exec: h.exec, which })).data['error']).toBe('not_lead')
    expect((await workSpawn({ harness: 'claude,gemini' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).data['error']).toBe('usage')
    const missing = await workSpawn({ harness: 'omp' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which: b => b !== 'omp' })
    expect(missing.data).toMatchObject({ error: 'harness_missing' })
    const cmux = await workSpawn({ mux: 'cmux' }, ctxAt(repo, NOW, { CMUX_SURFACE_ID: '0f6b2e2a-1111-4222-8333-444455556666', PATH: join(root, 'empty') }), LEAD, { exec: h.exec, which, appBin: join(root, 'no-app', 'cmux') })
    expect(cmux.data).toMatchObject({ error: 'cmux_missing' })
    expect(h.calls).toEqual([])
  }))

  test('a pane that does not open is reported and the rest are recorded (exit 2); when none opens the result is mux_failed', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 3 })
    const h = fakeHerdr({ failSplit: 2 })
    const r = await workSpawn({}, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })
    expect(r.code).toBe(2)
    expect(r.data).toMatchObject({ workers: { requested: 3, opened: 2 } })
    expect(r.data['failed']).toEqual([{ index: 2, harness: 'claude', error: 'the multiplexer opened no pane' }])
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes.map(p => p.id)).toEqual(['w2:p1', 'w2:p3'])

    const { repo: repo2 } = await published(join(root, 'two'), { n: 1 })
    const broken = fakeHerdr({ failSplit: 1 })
    const none = await workSpawn({}, ctxAt(repo2, NOW, HERDR_ENV), LEAD, { exec: broken.exec, which })
    expect(none.code).toBe(1)
    expect(none.data).toMatchObject({ error: 'mux_failed' })
  }))

  test('a second spawn drops dead panes, counts live idle panes as workers and keeps numbering the titles', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 5 })
    const live = new Set<string>()
    const h = fakeHerdr({ live })
    expect((await workSpawn({ workers: 2 }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
    live.delete('w2:p1')
    // One live idle pane holds a slot (5 free of 6) but takes no task by itself, so all 5 ready tasks get a pane.
    const again = await workSpawn({}, ctxAt(repo, NOW + 1000, HERDR_ENV), LEAD, { exec: h.exec, which })
    expect(again.errors).toEqual([])
    expect(again.data).toMatchObject({ workers: { requested: 5, opened: 5, active: 0, max: 6 } })
    const store = readMuxStore(muxStorePath(commonDir, 'rate-limit'))
    expect(store?.panes.map(p => p.id)).toEqual(['w2:p2', 'w2:p3', 'w2:p4', 'w2:p5', 'w2:p6', 'w2:p7'])
    expect(store?.panes.map(p => p.title)).toEqual(['buracle rate-limit claude 2', 'buracle rate-limit claude 3', 'buracle rate-limit claude 4', 'buracle rate-limit claude 5', 'buracle rate-limit claude 6', 'buracle rate-limit claude 7'])
    expect((await workSpawn({}, ctxAt(repo, NOW + 2000, HERDR_ENV), LEAD, { exec: h.exec, which })).data).toMatchObject({ workers: { requested: 0, opened: 0 } })
    const other = await workSpawn({ mux: 'tmux' }, ctxAt(repo, NOW + 3000, { ...HERDR_ENV, TMUX: '/tmp/t,1,0', TMUX_PANE: '%1' }), LEAD, { exec: h.exec, which })
    expect(other.data).toMatchObject({ error: 'mux_mismatch' })
  }))

  test('publish names the multiplexer it sees and points at spawn', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-08-rate-limit.md')
    write(plan, planDoc({ n: 2, status: 'IN_PROGRESS', approved: true }))
    const inside = await workPublish({ planPath: plan }, ctxAt(repo, NOW, HERDR_ENV), LEAD)
    expect(inside.data['mux']).toBe('herdr')
    expect(inside.lines.join('\n')).toContain('buracle work spawn --json (herdr detected)')
    const outside = await workPublish({ planPath: plan }, ctxAt(repo, NOW), LEAD)
    expect(outside.data['mux']).toBeNull()
    expect(outside.lines.join('\n')).not.toContain('work spawn')
  }))
})

describe('worker side: join binds, ask marks, resume clears', () => {
  const TMUX_LEAD = { TMUX: '/private/tmp/tmux-501/default,812,0', TMUX_PANE: '%3' }

  /** A fake tmux: new panes are %7, %8, …; display-message answers pid and socket (or a tty file). */
  function fakeTmux(tty: string): { exec: MuxExec, calls: string[][], lines: () => string[], reset: () => void } {
    const calls: string[][] = []
    let next = 7
    const exec: MuxExec = async argv => {
      calls.push(argv)
      const r: MuxExecResult = { code: 0, stdout: '', stderr: '' }
      if (argv[1] === 'has-session') return { ...r, code: 1 }
      if (argv[1] === 'split-window' || argv[1] === 'new-session') return { ...r, stdout: `%${next++}\n` }
      if (argv[1] === 'display-message') return { ...r, stdout: argv.includes('#{pane_tty}') ? `${tty}\n` : argv.includes('#{pane_marked}') ? '1\n' : `4242 /private/tmp/tmux-501/default\n` }
      return r
    }
    return { exec, calls, lines: () => calls.map(c => c.join(' ')), reset: () => { calls.length = 0 } }
  }

  test('join binds the pane Buracle opened to the worker session; a pane Buracle did not open, or no pane, binds nothing', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 3 })
    const live = new Set<string>()
    const h = fakeHerdr({ live })
    expect((await workSpawn({ workers: 2 }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
    const a = await workJoin('rate-limit', {}, ctxAt(repo, NOW, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p1' }), A)
    expect(a.code).toBe(0)
    expect(a.data['pane']).toEqual({ mux: 'herdr', id: 'w2:p1', bound: true })
    const b = await workJoin('rate-limit', {}, ctxAt(repo, NOW, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p9' }), W('opencode', 'worker-b'))
    expect(b.data['pane']).toEqual({ mux: 'herdr', id: 'w2:p9', bound: false })
    const c = await workJoin('rate-limit', {}, ctxAt(repo, NOW), W('omp', 'worker-c'))
    expect(c.data['pane']).toBeNull()
    const store = readMuxStore(muxStorePath(commonDir, 'rate-limit'))
    expect(store?.panes.map(p => p.session)).toEqual([{ harness: 'codex', session: 'worker-a' }, undefined])
  }))

  test('ask marks the bound tmux pane (title, mark, bell) and focuses it only with plan.board.muxOnAsk focus; resume clears the mark, also after a hook resumed first', () => sandbox(async root => {
    const { repo } = await published(root, { n: 2 })
    const tty = join(root, 'pane.tty')
    const t = fakeTmux(tty)
    expect((await workSpawn({ mux: 'tmux', workers: 1 }, ctxAt(repo, NOW, TMUX_LEAD), LEAD, { exec: t.exec, which })).code).toBe(0)
    const worker = { ...TMUX_LEAD, TMUX_PANE: '%7', BURACLE_NO_NOTIFY: '0', BURACLE_TTY_PATH: join(root, 'osc.out') }
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW, worker), A)
    expect(j.data['pane']).toEqual({ mux: 'tmux', id: '%7', bound: true })
    t.reset()
    const ask = await workAsk('which port?', ctxAt(repo, NOW + 1, worker), A, { exec: t.exec })
    expect(ask.code).toBe(0)
    expect(ask.data['pane']).toEqual({ marked: true, focused: false })
    expect(t.lines()).toEqual([
      'tmux select-pane -t %7 -T Task 1 needs you',
      'tmux select-pane -m -t %7',
      'tmux display-message -p -t %7 #{pane_tty}',
    ])
    expect(readFileSync(tty, 'utf8')).toBe('\x07')
    t.reset()
    const res = await workResume(ctxAt(repo, NOW + 2, worker), A, { exec: t.exec })
    expect(res.data).toMatchObject({ status: 'claimed', already: false, pane: { cleared: true } })
    expect(t.lines()).toEqual(['tmux select-pane -t %7 -T buracle rate-limit claude 1', 'tmux display-message -p -t %7 #{pane_marked}', 'tmux select-pane -M'])
    t.reset()
    const again = await workResume(ctxAt(repo, NOW + 3, worker), A, { exec: t.exec })
    expect(again.data).toMatchObject({ already: true, pane: { cleared: true } })
    expect(t.lines()).toEqual(['tmux select-pane -t %7 -T buracle rate-limit claude 1', 'tmux display-message -p -t %7 #{pane_marked}', 'tmux select-pane -M'])

    mkdirSync(dirname(userConfigFile()), { recursive: true })
    writeFileSync(userConfigFile(), 'version: 1\nplan:\n  board:\n    muxOnAsk: focus\n')
    t.reset()
    const focused = await workAsk('still?', ctxAt(repo, NOW + 4, worker), A, { exec: t.exec })
    expect(focused.data['pane']).toEqual({ marked: true, focused: true })
    expect(t.lines().slice(-2)).toEqual(['tmux select-window -t %7', 'tmux select-pane -t %7'])
  }))

  test('a tmux pane Buracle did not open is still marked (the user sees the question) but never recorded; BURACLE_NO_NOTIFY=1 marks and focuses nothing', () => sandbox(async root => {
    const { repo } = await published(root, { n: 2 })
    const tty = join(root, 'pane.tty')
    const t = fakeTmux(tty)
    const worker = { ...TMUX_LEAD, TMUX_PANE: '%42', BURACLE_NO_NOTIFY: '0', BURACLE_TTY_PATH: join(root, 'osc.out') }
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW, worker), A)).data['pane']).toBeNull()
    const ask = await workAsk('hand-opened?', ctxAt(repo, NOW + 1, worker), A, { exec: t.exec })
    expect(ask.data['pane']).toEqual({ marked: true, focused: false })
    expect(t.lines()[0]).toBe('tmux select-pane -t %42 -T Task 1 needs you')
    t.reset()
    expect((await workResume(ctxAt(repo, NOW + 2, worker), A, { exec: t.exec })).data).toMatchObject({ pane: { cleared: true } })
    expect(t.lines()).toEqual(['tmux select-pane -t %42 -T ', 'tmux display-message -p -t %42 #{pane_marked}', 'tmux select-pane -M'])
    t.reset()
    const quiet = { ...TMUX_LEAD, TMUX_PANE: '%42' }
    const b = W('opencode', 'worker-b')
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW + 3, quiet), b)).code).toBe(0)
    expect((await workAsk('quiet?', ctxAt(repo, NOW + 4, quiet), b, { exec: t.exec })).data['pane']).toEqual({ marked: false, focused: false })
    expect((await workResume(ctxAt(repo, NOW + 5, quiet), b, { exec: t.exec })).data).toMatchObject({ pane: { cleared: false } })
    expect(t.calls).toEqual([])
  }))
})

describe('lead side: merge and close close the panes, status lists them', () => {
  async function finish(repo: string, worker: ResolvedSession, n: number, at: number): Promise<void> {
    const b = readBoard(muxStorePath(join(repo, '.git'), 'rate-limit').replace(join('mux', 'rate-limit.json'), 'rate-limit.json'))
    const wt = String(b?.tasks.find(t => t.n === n)?.worktree?.path)
    write(join(wt, `src/s${n}.ts`), `export const s${n} = ${n}\n`)
    await g(wt, 'add', '-A')
    await g(wt, 'commit', '-q', '-m', `task ${n}: step ${n}`)
    const d = await workDone({ verify: `bun test tests/s${n}.test.ts → pass` }, ctxAt(repo, at), worker)
    if (d.code !== 0) throw new Error(`done ${n}: ${d.errors.join('; ')}`)
  }

  test('a merge closes nothing while a task is open; once none is open, the panes of idle workers close; close removes the rest and the sidecar', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 3, dep: true })
    const live = new Set<string>()
    const h = fakeHerdr({ live })
    const lead = ctxAt(repo, NOW, HERDR_ENV)
    expect((await workSpawn({ workers: 2 }, lead, LEAD, { exec: h.exec, which })).code).toBe(0)
    const B = W('opencode', 'worker-b')
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p1' }), A)).data['pane']).toMatchObject({ bound: true })
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p2' }), B)).data['pane']).toMatchObject({ bound: true })
    await finish(repo, A, 1, NOW + 1)
    await finish(repo, B, 2, NOW + 2)
    const status = await workStatus('rate-limit', ctxAt(repo, NOW + 2), undefined)
    expect(status.data['panes']).toEqual({ mux: 'herdr', list: [
      { id: 'w2:p1', harness: 'claude', title: 'buracle rate-limit claude 1', session: { harness: 'codex', session: 'worker-a' } },
      { id: 'w2:p2', harness: 'claude', title: 'buracle rate-limit claude 2', session: { harness: 'opencode', session: 'worker-b' } },
    ] })
    expect(status.lines.at(-1)).toBe('Panes (herdr): w2:p1 claude [worker-a], w2:p2 claude [worker-b]')

    h.reset()
    const m1 = await workMerge({}, ctxAt(repo, NOW + 3, HERDR_ENV), LEAD, { exec: h.exec })
    expect(m1.data).toMatchObject({ merged: true, task: 1, panes: { closed: [] } })
    expect(h.lines().filter(l => l.includes('pane close'))).toEqual([])
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW + 4, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p1' }), A)).data).toMatchObject({ task: { n: 3 } })
    const m2 = await workMerge({}, ctxAt(repo, NOW + 5, HERDR_ENV), LEAD, { exec: h.exec })
    expect(m2.data).toMatchObject({ merged: true, task: 2, panes: { closed: ['w2:p2'] } })
    expect(h.lines().filter(l => l.includes('pane close'))).toEqual(['herdr pane close w2:p2'])
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes.map(p => p.id)).toEqual(['w2:p1'])
    await finish(repo, A, 3, NOW + 6)
    const m3 = await workMerge({}, ctxAt(repo, NOW + 7, HERDR_ENV), LEAD, { exec: h.exec })
    expect(m3.data).toMatchObject({ merged: true, task: 3, panes: { closed: ['w2:p1'] } })
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes).toEqual([])
    const closed = await workClose({}, ctxAt(repo, NOW + 8, HERDR_ENV), LEAD, { exec: h.exec })
    expect(closed.data).toMatchObject({ closed: true, panes: { closed: [], kept: [] } })
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))).toBeUndefined()
  }))

  test('close closes every recorded pane, keeps them with --keep-panes, never runs a command for a pane from another server, and drops the sidecar', () => sandbox(async root => {
    const { repo, plan, commonDir } = await published(root, { n: 2 })
    const live = new Set<string>()
    const h = fakeHerdr({ live })
    expect((await workSpawn({ workers: 2 }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
    const path = muxStorePath(commonDir, 'rate-limit')
    const store = readMuxStore(path)
    if (store === undefined) throw new Error('no store')
    writeMuxStore(path, { ...store, panes: [...store.panes, { id: 'w2:p9', harness: 'omp', title: 'stranger', server: '/elsewhere/herdr.sock', openedAt: NOW }] })
    h.reset()
    const kept = await workClose({ force: true, keepPanes: true }, ctxAt(repo, NOW + 1, HERDR_ENV), LEAD, { exec: h.exec })
    expect(kept.data).toMatchObject({ closed: true, panes: { closed: [], kept: ['w2:p1', 'w2:p2', 'w2:p9'] } })
    expect(h.calls).toEqual([])
    expect(readMuxStore(path)).toBeUndefined()

    expect((await workPublish({ planPath: plan }, ctxAt(repo, NOW + 2, HERDR_ENV), LEAD)).code).toBe(0)
    writeMuxStore(path, { ...store, panes: [...store.panes, { id: 'w2:p9', harness: 'omp', title: 'stranger', server: '/elsewhere/herdr.sock', openedAt: NOW }] })
    h.reset()
    const closed = await workClose({ force: true }, ctxAt(repo, NOW + 3, HERDR_ENV), LEAD, { exec: h.exec })
    expect(closed.data).toMatchObject({ panes: { closed: ['w2:p1', 'w2:p2'], kept: [], stale: ['w2:p9'] } })
    expect(h.lines().filter(l => l.includes('pane close'))).toEqual(['herdr pane close w2:p1', 'herdr pane close w2:p2'])
    expect(readMuxStore(path)).toBeUndefined()
  }))
})

describe('review fixes: unbound panes, dry-run with a foreign board, an unreachable multiplexer', () => {
  test('a recorded pane nobody joined from is not closed after a merge (its worker may still be starting); close takes it', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 2 })
    const live = new Set<string>()
    const h = fakeHerdr({ live })
    expect((await workSpawn({ workers: 2 }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
    // Worker A joined from pane w2:p1; worker B joined with no pane in its environment (bind failed), so w2:p2 stays unbound.
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p1' }), A)).code).toBe(0)
    const B = W('opencode', 'worker-b')
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW), B)).data['pane']).toBeNull()
    for (const [w, n] of [[A, 1], [B, 2]] as const) {
      const b = readBoard(join(commonDir, 'buracle', 'board', 'rate-limit.json'))
      const wt = String(b?.tasks.find(t => t.n === n)?.worktree?.path)
      write(join(wt, `src/s${n}.ts`), `export const s${n} = ${n}\n`)
      await g(wt, 'add', '-A')
      await g(wt, 'commit', '-q', '-m', `task ${n}: step ${n}`)
      expect((await workDone({ verify: 'x' }, ctxAt(repo, NOW + n), w)).code).toBe(0)
    }
    h.reset()
    const m1 = await workMerge({}, ctxAt(repo, NOW + 3, HERDR_ENV), LEAD, { exec: h.exec })
    expect(m1.data).toMatchObject({ merged: true, task: 1, panes: { closed: ['w2:p1'] } })
    const m2 = await workMerge({}, ctxAt(repo, NOW + 4, HERDR_ENV), LEAD, { exec: h.exec })
    expect(m2.data).toMatchObject({ merged: true, task: 2, panes: { closed: [] } })
    expect(h.lines().filter(l => l.includes('pane close'))).toEqual(['herdr pane close w2:p1'])
    const closed = await workClose({}, ctxAt(repo, NOW + 5, HERDR_ENV), LEAD, { exec: h.exec })
    expect(closed.data).toMatchObject({ panes: { closed: ['w2:p2'] } })
  }))

  test('--dry-run exits 0 and reports the multiplexer even when the only board belongs to another lead', () => sandbox(async root => {
    const { repo } = await published(root, { n: 2 })
    const other = W('codex', 'other-lead')
    const r = await workSpawn({ dryRun: true }, ctxAt(repo, NOW, HERDR_ENV), other, { exec: fakeHerdr().exec, which })
    expect(r.code).toBe(0)
    expect(r.data).toMatchObject({ ok: true, dryRun: true, mux: 'herdr', board: null })
    expect(r.lines[0]).toContain('belongs to the lead claude lead-1')
  }))

  test('when the multiplexer does not answer, merge and close keep the records and report the panes as kept, never as closed or stale', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 1 })
    const live = new Set<string>()
    const h = fakeHerdr({ live })
    expect((await workSpawn({ workers: 2 }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p1' }), A)).code).toBe(0)
    const b = readBoard(join(commonDir, 'buracle', 'board', 'rate-limit.json'))
    const wt = String(b?.tasks[0]?.worktree?.path)
    write(join(wt, 'src/s1.ts'), 'export const s1 = 1\n')
    await g(wt, 'add', '-A')
    await g(wt, 'commit', '-q', '-m', 'task 1: step 1')
    expect((await workDone({ verify: 'x' }, ctxAt(repo, NOW + 1), A)).code).toBe(0)
    let asked = 0
    const down: MuxExec = async () => { asked++; return { code: 124, stdout: '', stderr: 'timed out' } }
    const m = await workMerge({}, ctxAt(repo, NOW + 2, HERDR_ENV), LEAD, { exec: down })
    expect(m.data).toMatchObject({ merged: true, task: 1, panes: { closed: [], kept: ['w2:p1'], stale: [] } })
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes.map(p => p.id)).toEqual(['w2:p1', 'w2:p2'])
    asked = 0
    const c = await workClose({}, ctxAt(repo, NOW + 3, HERDR_ENV), LEAD, { exec: down })
    expect(c.data).toMatchObject({ panes: { closed: [], kept: ['w2:p1', 'w2:p2'], stale: [] } })
    // After the first pane timed out, the second is kept without another 10 s wait.
    expect(asked).toBe(1)
    expect(c.errors.join('\n')).toContain('could not be checked or closed')
  }))
})

describe('re-review fixes: pruning, multiplexer switch, unreadable sidecar, mux_mismatch dry run', () => {
  const TMUX_LEAD = { TMUX: '/private/tmp/tmux-501/default,812,0', TMUX_PANE: '%3' }

  test('a second spawn drops only panes that are gone; records the multiplexer could not answer for stay and keep their slots', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 4 })
    const o: { live: Set<string>, getCode?: number } = { live: new Set<string>() }
    const h = fakeHerdr(o)
    expect((await workSpawn({ workers: 2 }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
    o.getCode = 124
    const again = await workSpawn({}, ctxAt(repo, NOW + 1, HERDR_ENV), LEAD, { exec: h.exec, which })
    expect(again.code).toBe(2)
    expect(again.errors.join('\n')).toContain('2 recorded pane(s) could not be checked')
    expect(again.data).toMatchObject({ workers: { requested: 4, opened: 4, active: 0, max: 6 } })
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes.map(p => p.id)).toEqual(['w2:p1', 'w2:p2', 'w2:p3', 'w2:p4', 'w2:p5', 'w2:p6'])
  }))

  test('once every pane of a board is gone, the next spawn may use another multiplexer and its panes are recorded under it', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 1 })
    const live = new Set<string>()
    const herdr = fakeHerdr({ live })
    const exec: MuxExec = async (argv, o) => {
      if (argv[0] !== 'tmux') return herdr.exec(argv, o)
      const r: MuxExecResult = { code: 0, stdout: '', stderr: '' }
      if (argv[1] === 'has-session') return { ...r, code: 1 }
      if (argv[1] === 'split-window' || argv[1] === 'new-session') return { ...r, stdout: '%7\n' }
      if (argv[1] === 'display-message') return { ...r, stdout: '4242 /tmp/s\n' }
      return r
    }
    expect((await workSpawn({ workers: 1 }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec, which })).code).toBe(0)
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p1' }), A)).code).toBe(0)
    const b = readBoard(join(commonDir, 'buracle', 'board', 'rate-limit.json'))
    const wt = String(b?.tasks[0]?.worktree?.path)
    write(join(wt, 'src/s1.ts'), 'export const s1 = 1\n')
    await g(wt, 'add', '-A')
    await g(wt, 'commit', '-q', '-m', 'task 1: step 1')
    expect((await workDone({ verify: 'x' }, ctxAt(repo, NOW + 1), A)).code).toBe(0)
    expect((await workMerge({}, ctxAt(repo, NOW + 2, HERDR_ENV), LEAD, { exec })).data).toMatchObject({ panes: { closed: ['w2:p1'] } })
    const path = muxStorePath(commonDir, 'rate-limit')
    expect(readMuxStore(path)).toEqual({ v: 1, slug: 'rate-limit', mux: 'herdr', panes: [] })
    const switched = await workSpawn({ mux: 'tmux', workers: 1 }, ctxAt(repo, NOW + 3, { ...HERDR_ENV, ...TMUX_LEAD }), LEAD, { exec, which })
    expect(switched.errors).toEqual([])
    expect(switched.data).toMatchObject({ mux: 'tmux', opened: [{ id: '%7' }] })
    expect(readMuxStore(path)).toMatchObject({ mux: 'tmux', panes: [{ id: '%7', harness: 'claude' }] })
  }))

  test('an unreadable sidecar is removed by close, so the next spawn records its panes again; a mux_mismatch dry run exits 0', () => sandbox(async root => {
    const { repo, plan, commonDir } = await published(root, { n: 2 })
    const path = muxStorePath(commonDir, 'rate-limit')
    const live = new Set<string>()
    const h = fakeHerdr({ live })
    expect((await workSpawn({ workers: 1 }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
    const dry = await workSpawn({ dryRun: true, mux: 'tmux' }, ctxAt(repo, NOW + 1, { ...HERDR_ENV, ...TMUX_LEAD }), LEAD, { exec: h.exec, which })
    expect(dry.code).toBe(0)
    expect(dry.data).toMatchObject({ ok: true, dryRun: true, mux: 'tmux', board: 'rate-limit', panes: [] })
    expect(dry.lines[0]).toContain('were opened in herdr')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{broken')
    const closed = await workClose({ force: true }, ctxAt(repo, NOW + 2, HERDR_ENV), LEAD, { exec: h.exec })
    expect(closed.code).toBe(0)
    expect(closed.data).toMatchObject({ panes: { unreadable: true } })
    expect(closed.errors.join('\n')).toContain('pane record file was unreadable')
    expect(existsSync(path)).toBe(false)
    expect((await workPublish({ planPath: plan }, ctxAt(repo, NOW + 3, HERDR_ENV), LEAD)).code).toBe(0)
    const r = await workSpawn({ workers: 1 }, ctxAt(repo, NOW + 4, HERDR_ENV), LEAD, { exec: h.exec, which })
    expect(r.errors).toEqual([])
    expect(readMuxStore(path)?.panes).toHaveLength(1)
  }))
})
