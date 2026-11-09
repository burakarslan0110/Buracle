import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { boardFromPlan, claim, markDone, setStandby, type Board, type BoardSession } from '../../src/core/board/model'
import { userConfigFile } from '../../src/engine/paths'
import { workAsk, workClose, workDone, workJoin, workMerge, workPublish, workRelease, workResume, workStatus } from '../../src/workflow/board'
import { readBoard, updateBoard } from '../../src/workflow/board-store'
import { panesLine, workSpawn, type PaneDeps } from '../../src/workflow/board-panes'
import type { MuxExec, MuxExecResult } from '../../src/workflow/mux'
import { workerCommand } from '../../src/workflow/mux'
import { muxStorePath, readMuxStore, writeMuxStore, type MuxStore } from '../../src/workflow/mux-store'
import type { ResolvedSession } from '../../src/workflow/session-store'
import { writeTelemetry } from '../../src/workflow/session-store'
import { fakeExe } from '../helpers/fake-exe'
import { CMUX_ENV, CU, HERDR_ENV, LEAD, NOW, fakeCmux, fakeHerdr, published, sandbox, which } from './board-panes-helpers'
import { ctxAt, g, makeRepo, planDoc, write } from './fixture'

const W = (harness: ResolvedSession['harness'], id: string): ResolvedSession => ({ harness, sessionId: id, source: '--session' })
const A = W('codex', 'worker-a')

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
      { id: 'w2:p1', harness: 'claude', title: 'Worker 1 (claude) · waiting for a task' },
      { id: 'w2:p2', harness: 'codex', title: 'Worker 2 (codex) · waiting for a task' },
      { id: 'w2:p3', harness: 'claude', title: 'Worker 3 (claude) · waiting for a task' },
      { id: 'w2:p4', harness: 'codex', title: 'Worker 4 (codex) · waiting for a task' },
    ])
    const cwd = String(r.data['cwd'])
    // The lead keeps the top half; the four workers share the bottom half as one row of four equal columns.
    expect(h.lines()).toEqual([
      `herdr pane split --current --direction down --ratio 0.5 --cwd ${cwd} --no-focus`,
      'herdr pane rename w2:p1 Worker 1 (claude) · waiting for a task',
      `herdr pane run w2:p1 ${workerCommand('claude', 'rate-limit', cwd, 'herdr')}`,
      `herdr pane split --pane w2:p1 --direction right --ratio 0.25 --cwd ${cwd} --no-focus`,
      'herdr pane rename w2:p2 Worker 2 (codex) · waiting for a task',
      `herdr pane run w2:p2 ${workerCommand('codex', 'rate-limit', cwd, 'herdr')}`,
      `herdr pane split --pane w2:p2 --direction right --ratio 0.333 --cwd ${cwd} --no-focus`,
      'herdr pane rename w2:p3 Worker 3 (claude) · waiting for a task',
      `herdr pane run w2:p3 ${workerCommand('claude', 'rate-limit', cwd, 'herdr')}`,
      `herdr pane split --pane w2:p3 --direction right --ratio 0.5 --cwd ${cwd} --no-focus`,
      'herdr pane rename w2:p4 Worker 4 (codex) · waiting for a task',
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
    // The lead reads which pane is which from this map, not from a guess.
    expect(r.lines).toContain('Pane map (herdr):')
    expect(r.lines).toContain('  w2:p1  Worker 1 (claude) · waiting for a task')
    expect(r.lines).toContain('  w2:p4  Worker 4 (codex) · waiting for a task')
  }))

  test('herdr writes its pane numbers in base 36: the worker panes past w2:p9 (w2:pA, w2:pG) open, are recorded and bind at join like any other', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 3 })
    const h = fakeHerdr({ from: 9 })
    const r = await workSpawn({ harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })
    expect(r.errors).toEqual([])
    expect(r.code).toBe(0)
    expect((r.data['opened'] as Array<{ id: string }>).map(p => p.id)).toEqual(['w2:p9', 'w2:pA', 'w2:pB'])
    expect(r.data['failed']).toEqual([])
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes.map(p => p.id)).toEqual(['w2:p9', 'w2:pA', 'w2:pB'])
    const third = await workJoin('rate-limit', {}, ctxAt(repo, NOW, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:pB' }), A)
    expect(third.data['pane']).toEqual({ mux: 'herdr', id: 'w2:pB', bound: true })

    // The real herdr went on past F: a board whose panes are numbered from 16 on (w2:pG …) works the same.
    const { repo: repo2 } = await published(join(root, 'two'), { n: 2 })
    const g = fakeHerdr({ from: 16 })
    const late = await workSpawn({ harness: 'claude' }, ctxAt(repo2, NOW, HERDR_ENV), LEAD, { exec: g.exec, which })
    expect((late.data['opened'] as Array<{ id: string }>).map(p => p.id)).toEqual(['w2:pG', 'w2:pH'])
    expect((await workJoin('rate-limit', {}, ctxAt(repo2, NOW, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:pH' }), A)).data['pane']).toEqual({ mux: 'herdr', id: 'w2:pH', bound: true })
  }))

  test('--workers above the free slots is clamped with a max_workers warning and never opens more than the ready tasks need; from the fourth worker on a hot rate window clamps to three (usage_low)', () => sandbox(async root => {
    const { repo } = await published(root, { n: 5 })
    const h = fakeHerdr()
    const r = await workSpawn({ workers: 9, harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })
    expect(r.code).toBe(2)
    expect(r.errors.join('\n')).toContain('max_workers')
    // 6 slots are free, but only 5 tasks are ready: --workers lowers the count, it never raises it.
    expect(r.data).toMatchObject({ workers: { requested: 5, opened: 5, active: 0, standby: 0, max: 6 } })

    const { repo: repo2 } = await published(join(root, 'hot'), { n: 5 })
    writeTelemetry('claude', 'lead-1', { at: NOW, windows: [{ pct: 95, label: '5h' }], windowsAt: NOW })
    const hot = await workSpawn({ harness: 'claude' }, ctxAt(repo2, NOW, HERDR_ENV), LEAD, { exec: fakeHerdr().exec, which })
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
      { harness: 'codex', command: workerCommand('codex', 'rate-limit', cwd, 'herdr'), title: 'Worker 1 (codex) · waiting for a task' },
      { harness: 'codex', command: workerCommand('codex', 'rate-limit', cwd, 'herdr'), title: 'Worker 2 (codex) · waiting for a task' },
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
    const none = await workSpawn({ harness: 'claude' }, ctxAt(repo, NOW), LEAD, { exec: h.exec, which })
    expect(none.data).toMatchObject({ error: 'no_mux' })
    expect(String(none.data['message'])).toContain('--mux tmux')
    expect((await workSpawn({ mux: 'screen', harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).data['error']).toBe('usage')
    expect((await workSpawn({ mux: 'herdr', harness: 'claude' }, ctxAt(repo, NOW), LEAD, { exec: h.exec, which })).data['error']).toBe('no_mux')
    expect((await workSpawn({ mux: 'cmux', harness: 'claude' }, ctxAt(repo, NOW), LEAD, { exec: h.exec, which })).data['error']).toBe('no_mux')
    expect((await workSpawn({ harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), A, { exec: h.exec, which })).data['error']).toBe('not_lead')
    expect((await workSpawn({ harness: 'claude,gemini' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).data['error']).toBe('usage')
    const missing = await workSpawn({ harness: 'omp' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which: b => b !== 'omp' })
    expect(missing.data).toMatchObject({ error: 'harness_missing' })
    const cmux = await workSpawn({ mux: 'cmux', harness: 'claude' }, ctxAt(repo, NOW, { CMUX_SURFACE_ID: '0f6b2e2a-1111-4222-8333-444455556666', PATH: join(root, 'empty') }), LEAD, { exec: h.exec, which, appBin: join(root, 'no-app', 'cmux') })
    expect(cmux.data).toMatchObject({ error: 'cmux_missing' })
    expect(h.calls).toEqual([])
  }))

  test('a pane that does not open is reported and the rest are recorded (exit 2); when none opens the result is mux_failed', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 3 })
    const h = fakeHerdr({ failSplit: 2 })
    const r = await workSpawn({ harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })
    expect(r.code).toBe(2)
    expect(r.data).toMatchObject({ workers: { requested: 3, opened: 2 } })
    expect(r.data['failed']).toEqual([{ index: 2, harness: 'claude', error: 'the multiplexer opened no pane' }])
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes.map(p => p.id)).toEqual(['w2:p1', 'w2:p3'])

    const { repo: repo2 } = await published(join(root, 'two'), { n: 1 })
    const broken = fakeHerdr({ failSplit: 1 })
    const none = await workSpawn({ harness: 'claude' }, ctxAt(repo2, NOW, HERDR_ENV), LEAD, { exec: broken.exec, which })
    expect(none.code).toBe(1)
    expect(none.data).toMatchObject({ error: 'mux_failed' })
  }))

  test('a second spawn drops dead panes, counts live idle panes as workers and keeps numbering the titles', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 5 })
    const live = new Set<string>()
    const h = fakeHerdr({ live })
    expect((await workSpawn({ workers: 2, harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
    live.delete('w2:p1')
    // One live idle pane holds a slot (5 free of 6) but takes no task by itself (it never started, minutes ago), so all 5 ready tasks get a pane.
    const later = 200_000
    const again = await workSpawn({ harness: 'claude' }, ctxAt(repo, NOW + later, HERDR_ENV), LEAD, { exec: h.exec, which })
    expect(again.errors).toEqual([])
    expect(again.data).toMatchObject({ workers: { requested: 5, opened: 5, active: 0, max: 6 } })
    const store = readMuxStore(muxStorePath(commonDir, 'rate-limit'))
    expect(store?.panes.map(p => p.id)).toEqual(['w2:p2', 'w2:p3', 'w2:p4', 'w2:p5', 'w2:p6', 'w2:p7'])
    expect(store?.panes.map(p => p.title)).toEqual(['Worker 2 (claude)', 'Worker 3 (claude)', 'Worker 4 (claude)', 'Worker 5 (claude)', 'Worker 6 (claude)', 'Worker 7 (claude)'])
    expect((await workSpawn({ harness: 'claude' }, ctxAt(repo, NOW + later + 1000, HERDR_ENV), LEAD, { exec: h.exec, which })).data).toMatchObject({ workers: { requested: 0, opened: 0 } })
    const other = await workSpawn({ mux: 'tmux', harness: 'claude' }, ctxAt(repo, NOW + later + 2000, { ...HERDR_ENV, TMUX: '/tmp/t,1,0', TMUX_PANE: '%1' }), LEAD, { exec: h.exec, which })
    expect(other.data).toMatchObject({ error: 'mux_mismatch' })
  }))

  test('a harness that PATH lacks but its installer put in ~/.bun/bin (omp) still starts: the pane runs it by its full path; one that is nowhere is harness_missing', () => sandbox(async root => {
    const { repo } = await published(root, { n: 1 })
    const home = process.env['HOME'] as string
    const omp = fakeExe(join(home, '.bun', 'bin', 'omp'), '')
    const bare = join(root, 'bare-path')
    mkdirSync(bare, { recursive: true })
    const h = fakeHerdr()
    const r = await workSpawn({ harness: 'omp' }, ctxAt(repo, NOW, { ...HERDR_ENV, PATH: bare }), LEAD, { exec: h.exec })
    expect(r.errors).toEqual([])
    expect(r.code).toBe(0)
    const cwd = String(r.data['cwd'])
    expect(h.lines()).toContain(`herdr pane run w2:p1 ${workerCommand('omp', 'rate-limit', cwd, 'herdr', omp)}`)
    expect(workerCommand('omp', 'rate-limit', cwd, 'herdr', omp)).toBe(`'${omp}' --cwd='${cwd}' '/buracle-join rate-limit'`)
    // On PATH, the pane finds it by name; the command stays short.
    const bin = join(root, 'bin')
    fakeExe(join(bin, 'claude'), '')
    const onPath = await workSpawn({ harness: 'claude', dryRun: false }, ctxAt(repo, NOW + 130_000, { ...HERDR_ENV, PATH: bin }), LEAD, { exec: h.exec })
    expect(onPath.code).toBe(0)
    expect(h.lines().at(-1)).toBe(`herdr pane run w2:p2 ${workerCommand('claude', 'rate-limit', cwd, 'herdr')}`)
    const none = await workSpawn({ harness: 'opencode' }, ctxAt(repo, NOW + 260_000, { ...HERDR_ENV, PATH: bare }), LEAD, { exec: h.exec })
    expect(none.data).toMatchObject({ error: 'harness_missing' })
  }))

  test('a second spawn does not open panes for tasks that panes still starting up are about to take; a pane that never started stops counting after two minutes', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 2 })
    const h = fakeHerdr({ live: new Set<string>() })
    expect((await workSpawn({ workers: 2, harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
    h.reset()
    // The lead ran spawn again after a hiccup: the two panes it opened a second ago will claim the two ready tasks.
    const soon = await workSpawn({ harness: 'claude' }, ctxAt(repo, NOW + 1000, HERDR_ENV), LEAD, { exec: h.exec, which })
    expect(soon.code).toBe(0)
    expect(soon.data).toMatchObject({ workers: { requested: 0, opened: 0 } })
    expect(soon.lines.join('\n')).toContain('2 pane(s) starting')
    expect(h.calls.filter(c => c[2] === 'split')).toEqual([])
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes).toHaveLength(2)
    // A pane that has not joined in two minutes is not starting: it never will, and the tasks get new panes.
    const late = await workSpawn({ harness: 'claude' }, ctxAt(repo, NOW + 130_000, HERDR_ENV), LEAD, { exec: h.exec, which })
    expect(late.data).toMatchObject({ workers: { requested: 2, opened: 2 } })
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

describe('panesLine: which task a pane holds', () => {
  const lead: BoardSession = { harness: 'claude', session: 'lead-1' }
  const A: BoardSession = { harness: 'claude', session: 'a' }
  const B: BoardSession = { harness: 'codex', session: 'b' }
  const tasks = [1, 2, 3, 4].map(n => ({ n, title: `Step ${n}`, done: false, objective: `o${n}`, dod: `d${n}`, files: [{ verb: 'Modify' as const, path: `src/s${n}.ts` }] }))

  function finish(b: Board, n: number, who: BoardSession, at: number): Board {
    const claimed = claim(b, n, who, at, `tok${n}`)
    if (!claimed.ok) throw new Error(claimed.message)
    const done = markDone(claimed.board, n, `tok${n}`, { branch: `lane-${n}`, commits: ['c'], verify: 'ok' }, at + 1)
    if (!done.ok) throw new Error(done.message)
    return done.board
  }

  test('a worker that finished several tasks the lead has not merged yet is shown with the one it finished last, not the one with the lowest number', () => {
    const made = boardFromPlan(tasks, { slug: 'rate-limit', plan: '/repo/docs/plan-build/2026-11-08-rate-limit.md', planType: 'Feature', base: 'main', lead, maxWorkers: 6, leaseSec: 300, constraints: [], context: '', now: 1000 })
    if (!made.ok) throw new Error(made.message)
    // A finishes Task 4 and then Task 2; B finishes Task 1 and then Task 3.
    let board = finish(made.board, 4, A, 2000)
    board = finish(board, 1, B, 3000)
    board = finish(board, 2, A, 4000)
    board = finish(board, 3, B, 5000)
    const rec = (id: string, who: BoardSession, title: string) => ({ id, harness: who.harness, title, server: 's', openedAt: 0, session: who })
    const store: MuxStore = { v: 1, slug: 'rate-limit', mux: 'herdr', panes: [rec('w2:p1', A, 'Worker 1 (claude)'), rec('w2:p2', B, 'Worker 2 (codex)')] }
    expect(panesLine(store, board)).toBe('Panes (herdr): w2:p1 Worker 1 (claude): Task 2 done, w2:p2 Worker 2 (codex): Task 3 done')
  })
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
    expect((await workSpawn({ workers: 2, harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
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

  /**
   * Codex runs shell commands with a shell snapshot it took at start, so a worker's HERDR_PANE_ID may name a pane of an
   * earlier herdr session. The pane is then found by its shell: `herdr pane process-info` names each pane's shell pid, and
   * the worker's process descends from exactly one of them.
   */
  function withPids(h: ReturnType<typeof fakeHerdr>, shells: Record<string, number>, chain: Record<number, number>): MuxExec {
    return async (argv, o) => {
      if (argv[0] === 'ps') {
        const pid = Number(argv[argv.length - 1])
        const ppid = chain[pid]
        return ppid === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: `${ppid}\n`, stderr: '' }
      }
      if (argv[1] === 'pane' && argv[2] === 'process-info') {
        const id = argv[argv.indexOf('--pane') + 1] ?? ''
        const shell = shells[id]
        if (shell === undefined) return { code: 1, stdout: '', stderr: '{"error":{"code":"not_found"}}' }
        return { code: 0, stdout: JSON.stringify({ result: { process_info: { pane_id: id, shell_pid: shell, foreground_processes: [] } } }), stderr: '' }
      }
      return h.exec(argv, o)
    }
  }

  test('join binds the pane whose shell is an ancestor of the worker when the env names a stale pane (Codex shell snapshot), and later calls find the pane by session', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 3 })
    const live = new Set<string>()
    const h = fakeHerdr({ live })
    expect((await workSpawn({ workers: 2, harness: 'codex' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
    // Pane w2:p1's shell is 500, pane w2:p2's shell is 600; the worker (pid 900) descends from 600 through 700.
    const exec = withPids(h, { 'w2:p1': 500, 'w2:p2': 600 }, { 900: 700, 700: 600, 600: 1 })
    const stale = { ...HERDR_ENV, HERDR_PANE_ID: 'w3:p3', BURACLE_NO_NOTIFY: '0' }
    h.reset()
    const a = await workJoin('rate-limit', {}, ctxAt(repo, NOW, stale), A, { exec, pid: 900 })
    expect(a.code).toBe(0)
    expect(a.data['pane']).toEqual({ mux: 'herdr', id: 'w2:p2', bound: true })
    expect(h.lines()).toContain('herdr pane rename w2:p2 Worker 2 (codex) · Task 1: Step 1')
    const store = readMuxStore(muxStorePath(commonDir, 'rate-limit'))
    expect(store?.panes.map(p => p.session)).toEqual([undefined, { harness: 'codex', session: 'worker-a' }])
    // The worker's later calls carry the same stale id: the pane is found by the session it is bound to.
    h.reset()
    expect((await workRelease({ reason: 'later' }, ctxAt(repo, NOW + 1, stale), A, { exec })).code).toBe(0)
    expect(h.lines()).toEqual(['herdr pane rename w2:p2 Worker 2 (codex) · waiting for a task'])
    // No pane id in the environment at all: the shell still names the pane.
    const noId = { ...HERDR_ENV, HERDR_PANE_ID: undefined, BURACLE_NO_NOTIFY: '0' }
    const c = await workJoin('rate-limit', {}, ctxAt(repo, NOW + 2, noId), W('codex', 'worker-c'), { exec: withPids(h, { 'w2:p1': 500, 'w2:p2': 600 }, { 800: 500, 500: 1 }), pid: 800 })
    expect(c.data['pane']).toEqual({ mux: 'herdr', id: 'w2:p1', bound: true })
    // A stale id that happens to name another worker's pane never takes that pane over.
    const steal = { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p2', BURACLE_NO_NOTIFY: '0' }
    const d = await workJoin('rate-limit', {}, ctxAt(repo, NOW + 3, steal), W('codex', 'worker-d'), { exec: withPids(h, { 'w2:p1': 500, 'w2:p2': 600 }, { 950: 1 }), pid: 950 })
    expect(d.data['pane']).toEqual({ mux: 'herdr', id: 'w2:p2', bound: false })
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes.map(p => p.session?.session)).toEqual(['worker-c', 'worker-a'])
    // The first worker joins again from the same pane: its own pane is found by the shell and relabelled.
    h.reset()
    const again = await workJoin('rate-limit', {}, ctxAt(repo, NOW + 4, stale), A, { exec, pid: 900 })
    expect(again.data['pane']).toEqual({ mux: 'herdr', id: 'w2:p2', bound: true })
    expect(h.lines()).toContain('herdr pane rename w2:p2 Worker 2 (codex) · Task 3: Step 3')
  }))

  test('the pane label follows the worker (Task n: title after join, waiting again after release) and status maps every pane to its task', () => sandbox(async root => {
    const { repo } = await published(root, { n: 2 })
    const h = fakeHerdr()
    expect((await workSpawn({ workers: 2, harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
    const at = (id: string) => ({ ...HERDR_ENV, HERDR_PANE_ID: id, BURACLE_NO_NOTIFY: '0' })
    h.reset()
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW, at('w2:p1')), A, { exec: h.exec })
    expect(j.data['pane']).toEqual({ mux: 'herdr', id: 'w2:p1', bound: true })
    // The join first asks which pane's shell this process descends from (ps, process-info); only the rename changes a pane.
    expect(h.lines().filter(l => l.includes('rename'))).toEqual(['herdr pane rename w2:p1 Worker 1 (claude) · Task 1: Step 1'])

    const status = await workStatus('rate-limit', ctxAt(repo, NOW + 1), undefined)
    expect(status.lines.find(l => l.startsWith('Task 1 '))).toMatch(/^Task 1 claimed by codex worker-a .*: Step 1 \[pane w2:p1\]$/)
    expect(status.lines.find(l => l.startsWith('Task 2 '))).toBe('Task 2 open: Step 2')
    expect(status.lines.at(-1)).toBe('Panes (herdr): w2:p1 Worker 1 (claude): Task 1 claimed, w2:p2 Worker 2 (claude): no worker yet')

    h.reset()
    const rel = await workRelease({ reason: 'wrong repo' }, ctxAt(repo, NOW + 2, at('w2:p1')), A, { exec: h.exec })
    expect(rel.code).toBe(0)
    expect(h.lines()).toEqual(['herdr pane rename w2:p1 Worker 1 (claude) · waiting for a task'])
    expect((await workStatus('rate-limit', ctxAt(repo, NOW + 3), undefined)).lines.at(-1)).toBe('Panes (herdr): w2:p1 Worker 1 (claude): idle, w2:p2 Worker 2 (claude): no worker yet')

    // A worker that leaves the board has no task to name, and a pane Buracle did not open is never renamed.
    h.reset()
    expect((await workRelease({}, ctxAt(repo, NOW + 4, at('w2:p1')), A, { exec: h.exec })).data).toMatchObject({ left: true })
    const stranger = W('omp', 'worker-x')
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW + 5, at('w2:p9')), stranger, { exec: h.exec })).data['pane']).toEqual({ mux: 'herdr', id: 'w2:p9', bound: false })
    // The lookup by shell may ask herdr about the recorded panes; it never renames one.
    expect(h.lines().filter(l => l.includes('rename'))).toEqual([])
  }))

  test('the ask note names the pane the question waits in, so the lead never has to guess it', () => sandbox(async root => {
    const { repo, path } = await published(root, { n: 2 })
    const t = fakeTmux(join(root, 'pane.tty'))
    expect((await workSpawn({ mux: 'tmux', workers: 1, harness: 'claude' }, ctxAt(repo, NOW, TMUX_LEAD), LEAD, { exec: t.exec, which })).code).toBe(0)
    const worker = { ...TMUX_LEAD, TMUX_PANE: '%7', BURACLE_NO_NOTIFY: '0', BURACLE_TTY_PATH: join(root, 'osc.out') }
    await workJoin('rate-limit', {}, ctxAt(repo, NOW, worker), A, { exec: t.exec })
    await workAsk('which port?', ctxAt(repo, NOW + 1, worker), A, { exec: t.exec })
    expect(readBoard(path)?.notes.map(n => n.text)).toContain('Task 1 waits for the user (pane %7): which port?')
  }))

  test('with a stale TMUX_PANE (Codex shell snapshot) the pane is found by #{pane_pid}; ask, the note and resume address that pane', () => sandbox(async root => {
    const { repo, path } = await published(root, { n: 2 })
    const t = fakeTmux(join(root, 'pane.tty'))
    // The fake tmux says every pane's shell is 4242; the worker (pid 7000) descends from it.
    const exec: MuxExec = async (argv, o) => (argv[0] === 'ps' ? { code: argv.at(-1) === '7000' ? 0 : 1, stdout: argv.at(-1) === '7000' ? '4242\n' : '', stderr: '' } : t.exec(argv, o))
    expect((await workSpawn({ mux: 'tmux', workers: 1, harness: 'claude' }, ctxAt(repo, NOW, TMUX_LEAD), LEAD, { exec: t.exec, which })).code).toBe(0)
    const worker = { ...TMUX_LEAD, TMUX_PANE: '%99', BURACLE_NO_NOTIFY: '0', BURACLE_TTY_PATH: join(root, 'osc.out') }
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW, worker), A, { exec, pid: 7000 })
    expect(j.data['pane']).toEqual({ mux: 'tmux', id: '%7', bound: true })
    t.reset()
    const ask = await workAsk('which port?', ctxAt(repo, NOW + 1, worker), A, { exec, pid: 7000 })
    expect(ask.data['pane']).toEqual({ marked: true, focused: false })
    expect(t.lines()[0]).toBe('tmux select-pane -t %7 -T Worker 1 (claude) · Task 1 · NEEDS YOU')
    expect(readBoard(path)?.notes.map(n => n.text)).toContain('Task 1 waits for the user (pane %7): which port?')
    t.reset()
    expect((await workResume(ctxAt(repo, NOW + 2, worker), A, { exec, pid: 7000 })).code).toBe(0)
    expect(t.lines()[0]).toBe('tmux select-pane -t %7 -T Worker 1 (claude) · Task 1: Step 1')
  }))

  test('ask marks the bound tmux pane (title, mark, bell) and focuses it only with plan.board.muxOnAsk focus; resume clears the mark, also after a hook resumed first', () => sandbox(async root => {
    const { repo } = await published(root, { n: 2 })
    const tty = join(root, 'pane.tty')
    const t = fakeTmux(tty)
    expect((await workSpawn({ mux: 'tmux', workers: 1, harness: 'claude' }, ctxAt(repo, NOW, TMUX_LEAD), LEAD, { exec: t.exec, which })).code).toBe(0)
    const worker = { ...TMUX_LEAD, TMUX_PANE: '%7', BURACLE_NO_NOTIFY: '0', BURACLE_TTY_PATH: join(root, 'osc.out') }
    t.reset()
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW, worker), A, { exec: t.exec })
    expect(j.data['pane']).toEqual({ mux: 'tmux', id: '%7', bound: true })
    // The pane now says which task it works on (the shell lookup before it only reads: ps and display-message).
    expect(t.lines().filter(l => !l.startsWith('ps ') && !l.includes('display-message'))).toEqual(['tmux select-pane -t %7 -T Worker 1 (claude) · Task 1: Step 1'])
    t.reset()
    const ask = await workAsk('which port?', ctxAt(repo, NOW + 1, worker), A, { exec: t.exec })
    expect(ask.code).toBe(0)
    expect(ask.data['pane']).toEqual({ marked: true, focused: false })
    expect(t.lines()).toEqual([
      'tmux select-pane -t %7 -T Worker 1 (claude) · Task 1 · NEEDS YOU',
      'tmux select-pane -m -t %7',
      'tmux display-message -p -t %7 #{pane_tty}',
    ])
    expect(readFileSync(tty, 'utf8')).toBe('\x07')
    t.reset()
    const res = await workResume(ctxAt(repo, NOW + 2, worker), A, { exec: t.exec })
    expect(res.data).toMatchObject({ status: 'claimed', already: false, pane: { cleared: true } })
    expect(t.lines()).toEqual(['tmux select-pane -t %7 -T Worker 1 (claude) · Task 1: Step 1', 'tmux display-message -p -t %7 #{pane_marked}', 'tmux select-pane -M'])
    t.reset()
    const again = await workResume(ctxAt(repo, NOW + 3, worker), A, { exec: t.exec })
    expect(again.data).toMatchObject({ already: true, pane: { cleared: true } })
    expect(t.lines()).toEqual(['tmux select-pane -t %7 -T Worker 1 (claude) · Task 1: Step 1', 'tmux display-message -p -t %7 #{pane_marked}', 'tmux select-pane -M'])

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

/** The worker commits its task's file in its lane worktree and reports done. */
async function finish(repo: string, worker: ResolvedSession, n: number, at: number, o: { env?: Record<string, string>, deps?: PaneDeps } = {}): Promise<void> {
  const b = readBoard(muxStorePath(join(repo, '.git'), 'rate-limit').replace(join('mux', 'rate-limit.json'), 'rate-limit.json'))
  const wt = String(b?.tasks.find(t => t.n === n)?.worktree?.path)
  write(join(wt, `src/s${n}.ts`), `export const s${n} = ${n}\n`)
  await g(wt, 'add', '-A')
  await g(wt, 'commit', '-q', '-m', `task ${n}: step ${n}`)
  const d = await workDone({ verify: `bun test tests/s${n}.test.ts → pass` }, ctxAt(repo, at, o.env), worker, o.deps)
  if (d.code !== 0) throw new Error(`done ${n}: ${d.errors.join('; ')}`)
}

describe('lead side: merge and close close the panes, status lists them', () => {

  test('done labels the worker pane, and the pane stays until its merge: Task n · done', () => sandbox(async root => {
    const { repo } = await published(root, { n: 1 })
    const h = fakeHerdr()
    expect((await workSpawn({ workers: 1, harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
    const env = { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p1', BURACLE_NO_NOTIFY: '0' }
    await workJoin('rate-limit', {}, ctxAt(repo, NOW, env), A, { exec: h.exec })
    h.reset()
    await finish(repo, A, 1, NOW + 1, { env, deps: { exec: h.exec } })
    expect(h.lines()).toEqual(['herdr pane rename w2:p1 Worker 1 (claude) · Task 1 · done'])
  }))

  test('a merge closes nothing while a task is open; once none is open, the panes of idle workers close; close removes the rest and the sidecar', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 3, dep: true })
    const live = new Set<string>()
    const h = fakeHerdr({ live })
    const lead = ctxAt(repo, NOW, HERDR_ENV)
    expect((await workSpawn({ workers: 2, harness: 'claude' }, lead, LEAD, { exec: h.exec, which })).code).toBe(0)
    const B = W('opencode', 'worker-b')
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p1' }), A)).data['pane']).toMatchObject({ bound: true })
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p2' }), B)).data['pane']).toMatchObject({ bound: true })
    await finish(repo, A, 1, NOW + 1)
    await finish(repo, B, 2, NOW + 2)
    const status = await workStatus('rate-limit', ctxAt(repo, NOW + 2), undefined)
    expect(status.data['panes']).toEqual({ mux: 'herdr', list: [
      { id: 'w2:p1', harness: 'claude', title: 'Worker 1 (claude)', session: { harness: 'codex', session: 'worker-a' }, task: 1 },
      { id: 'w2:p2', harness: 'claude', title: 'Worker 2 (claude)', session: { harness: 'opencode', session: 'worker-b' }, task: 2 },
    ] })
    expect(status.lines.at(-1)).toBe('Panes (herdr): w2:p1 Worker 1 (claude): Task 1 done, w2:p2 Worker 2 (claude): Task 2 done')

    // Both workers wait for their next task (`join --wait`): standby workers on the board.
    const boardFile = join(commonDir, 'buracle', 'board', 'rate-limit.json')
    updateBoard(boardFile, NOW + 2, b => ({ ok: true, board: setStandby(setStandby(b, { harness: 'codex', session: 'worker-a' }, NOW + 2), { harness: 'opencode', session: 'worker-b' }, NOW + 2) }))
    h.reset()
    // Task 3 is ready after this merge; the standby workers cover it, so the tick opens no pane and closes none.
    const m1 = await workMerge({}, ctxAt(repo, NOW + 3, HERDR_ENV), LEAD, { exec: h.exec })
    expect(m1.data).toMatchObject({ merged: true, task: 1, panes: { closed: [] }, scale: { opened: [], closed: [] } })
    expect(h.lines().filter(l => l.includes('pane close') || l.includes('pane split'))).toEqual([])
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW + 4, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p1' }), A)).data).toMatchObject({ task: { n: 3 } })
    const m2 = await workMerge({}, ctxAt(repo, NOW + 5, HERDR_ENV), LEAD, { exec: h.exec })
    expect(m2.data).toMatchObject({ merged: true, task: 2, panes: { closed: ['w2:p2'] }, scale: { opened: [], closed: ['w2:p2'] } })
    expect(h.lines().filter(l => l.includes('pane close'))).toEqual(['herdr pane close w2:p2'])
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes.map(p => p.id)).toEqual(['w2:p1'])
    // The closed pane took its worker with it: its standby entry left the board at once.
    expect(readBoard(boardFile)?.standby).toBeUndefined()
    await finish(repo, A, 3, NOW + 6)
    const m3 = await workMerge({}, ctxAt(repo, NOW + 7, HERDR_ENV), LEAD, { exec: h.exec })
    expect(m3.data).toMatchObject({ merged: true, task: 3, panes: { closed: ['w2:p1'] } })
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes).toEqual([])
    const closed = await workClose({}, ctxAt(repo, NOW + 8, HERDR_ENV), LEAD, { exec: h.exec })
    expect(closed.data).toMatchObject({ closed: true, panes: { closed: [], kept: [] } })
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))).toBeUndefined()
  }))

  test('a blocked task keeps the pane of a worker whose harness may still take it; the panes close once nothing remains for them', () => sandbox(async root => {
    // Task 3 shares a file with Task 2, so it cannot start while Task 2 is active: the worker that finished Task 1 waits for it.
    const { repo, commonDir } = await published(root, { n: 3, dep: 2 })
    const h = fakeHerdr({ live: new Set<string>() })
    expect((await workSpawn({ workers: 2, harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
    const B = W('opencode', 'worker-b')
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p1' }), A)).data).toMatchObject({ task: { n: 1 } })
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p2' }), B)).data).toMatchObject({ task: { n: 2 } })
    await finish(repo, A, 1, NOW + 1)
    // A waits for its next task (`join --wait`): Task 3 is blocked by Task 2, but it may still come for A's harness.
    const boardFile = join(commonDir, 'buracle', 'board', 'rate-limit.json')
    updateBoard(boardFile, NOW + 1, b => ({ ok: true, board: setStandby(b, { harness: 'codex', session: 'worker-a' }, NOW + 1) }))
    h.reset()
    const m1 = await workMerge({}, ctxAt(repo, NOW + 2, HERDR_ENV), LEAD, { exec: h.exec })
    expect(m1.data).toMatchObject({ merged: true, task: 1, panes: { closed: [] }, scale: { opened: [], closed: [] } })
    expect(h.lines().filter(l => l.includes('pane close'))).toEqual([])
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes.map(p => p.id)).toEqual(['w2:p1', 'w2:p2'])
    await finish(repo, B, 2, NOW + 3)
    // Task 2 is merged, so Task 3 is ready: the standby worker covers it, so no pane opens, and both panes stay.
    const m2 = await workMerge({}, ctxAt(repo, NOW + 4, HERDR_ENV), LEAD, { exec: h.exec })
    expect(m2.data).toMatchObject({ merged: true, task: 2, panes: { closed: [] }, scale: { opened: [], closed: [] } })
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW + 5, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p1' }), A)).data).toMatchObject({ task: { n: 3 } })
    await finish(repo, A, 3, NOW + 6)
    const m3 = await workMerge({}, ctxAt(repo, NOW + 7, HERDR_ENV), LEAD, { exec: h.exec })
    expect(m3.data).toMatchObject({ merged: true, task: 3, panes: { closed: ['w2:p1', 'w2:p2'] } })
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes).toEqual([])
  }))

  test('a Build board gets new tasks every round: its panes stay through the merges and close only at work close', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 2, type: 'Build' })
    const h = fakeHerdr({ live: new Set<string>() })
    expect((await workSpawn({ workers: 2, harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
    const B = W('opencode', 'worker-b')
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p1' }), A)).data).toMatchObject({ task: { n: 1 } })
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p2' }), B)).data).toMatchObject({ task: { n: 2 } })
    await finish(repo, A, 1, NOW + 1)
    await finish(repo, B, 2, NOW + 2)
    h.reset()
    expect((await workMerge({}, ctxAt(repo, NOW + 3, HERDR_ENV), LEAD, { exec: h.exec })).data).toMatchObject({ merged: true, task: 1, panes: { closed: [] } })
    expect((await workMerge({}, ctxAt(repo, NOW + 4, HERDR_ENV), LEAD, { exec: h.exec })).data).toMatchObject({ merged: true, task: 2, panes: { closed: [] } })
    expect(h.lines().filter(l => l.includes('pane close'))).toEqual([])
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes.map(p => p.id)).toEqual(['w2:p1', 'w2:p2'])
    const closed = await workClose({}, ctxAt(repo, NOW + 5, HERDR_ENV), LEAD, { exec: h.exec })
    expect(closed.data).toMatchObject({ closed: true, panes: { closed: ['w2:p1', 'w2:p2'] } })
  }))

  test('close closes every recorded pane, keeps them with --keep-panes, never runs a command for a pane from another server, and drops the sidecar', () => sandbox(async root => {
    const { repo, plan, commonDir } = await published(root, { n: 2 })
    const live = new Set<string>()
    const h = fakeHerdr({ live })
    expect((await workSpawn({ workers: 2, harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
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
    expect((await workSpawn({ workers: 2, harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
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

  test('cmux: a worker whose CMUX_SURFACE_ID is the UUID binds the pane new-split named by its ref; the label follows the task, the merge closes the idle pane with --force', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 2 })
    const c = fakeCmux()
    const deps = { exec: c.exec, cmuxBin: '/opt/cmux', which }
    expect((await workSpawn({ workers: 2, harness: 'claude' }, ctxAt(repo, NOW, CMUX_ENV), LEAD, deps)).errors).toEqual([])
    // What the real cmux gives: the record carries the ref and the UUID; the worker's pane knows the UUID only.
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes.map(p => [p.id, p.ids])).toEqual([[CU(2), ['surface:2', CU(2)]], [CU(3), ['surface:3', CU(3)]]])
    const B = W('claude', 'worker-b')
    const envA = { ...CMUX_ENV, CMUX_SURFACE_ID: CU(2), BURACLE_NO_NOTIFY: '0' }
    const envB = { ...CMUX_ENV, CMUX_SURFACE_ID: CU(3), BURACLE_NO_NOTIFY: '0' }
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW, envA), A, deps)
    expect(j.data).toMatchObject({ task: { n: 1 }, pane: { mux: 'cmux', id: CU(2), bound: true } })
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW, envB), B, deps)).data).toMatchObject({ task: { n: 2 }, pane: { bound: true } })
    expect(c.lines().filter(l => l.includes('rename-tab')).slice(-2)).toEqual([
      `/opt/cmux rename-tab --surface ${CU(2)} -- Worker 1 (claude) · Task 1: Step 1`,
      `/opt/cmux rename-tab --surface ${CU(3)} -- Worker 2 (claude) · Task 2: Step 2`,
    ])
    const st = await workStatus(undefined, ctxAt(repo, NOW + 1, CMUX_ENV), LEAD)
    expect(st.lines.find(l => l.startsWith('Panes (cmux)'))).toBe(`Panes (cmux): ${CU(2)} Worker 1 (claude): Task 1 claimed, ${CU(3)} Worker 2 (claude): Task 2 claimed`)
    c.reset()
    const asked = await workAsk('which color?', ctxAt(repo, NOW + 2, envA), A, deps)
    expect(asked.data).toMatchObject({ pane: { marked: true } })
    expect(c.lines()).toContain(`/opt/cmux rename-tab --surface ${CU(2)} -- Worker 1 (claude) · Task 1 · NEEDS YOU`)
    expect((await workResume(ctxAt(repo, NOW + 3, envA), A, deps)).code).toBe(0)
    await finish(repo, A, 1, NOW + 4, { env: envA, deps })
    await finish(repo, B, 2, NOW + 5, { env: envB, deps })
    c.reset()
    const m1 = await workMerge({}, ctxAt(repo, NOW + 6, CMUX_ENV), LEAD, deps)
    expect(m1.data).toMatchObject({ merged: true, task: 1, panes: { closed: [CU(2)], kept: [], stale: [] } })
    expect(c.lines().filter(l => l.includes('close-surface'))).toEqual([`/opt/cmux close-surface --surface ${CU(2)} --force`])
    const m2 = await workMerge({}, ctxAt(repo, NOW + 7, CMUX_ENV), LEAD, deps)
    expect(m2.data).toMatchObject({ merged: true, task: 2, panes: { closed: [CU(3)] } })
    expect(c.live.size).toBe(0)
  }))

  test('cmux: a record that holds only the surface ref (an older spawn) still binds, because the worker asks cmux for the handles of its UUID', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 1 })
    const c = fakeCmux()
    const deps = { exec: c.exec, cmuxBin: '/opt/cmux', which }
    expect((await workSpawn({ workers: 1, harness: 'claude' }, ctxAt(repo, NOW, CMUX_ENV), LEAD, deps)).errors).toEqual([])
    const path = muxStorePath(commonDir, 'rate-limit')
    const store = readMuxStore(path)
    if (store === undefined) throw new Error('no store')
    writeMuxStore(path, { ...store, panes: store.panes.map(p => ({ ...p, id: 'surface:2', ids: ['surface:2'] })) })
    // cmux may print the UUID in upper case (Swift does) while the listing shows it lower case: the pane still binds.
    const upper = CU(2).toUpperCase()
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW, { ...CMUX_ENV, CMUX_SURFACE_ID: upper, BURACLE_NO_NOTIFY: '0' }), A, deps)
    expect(j.data).toMatchObject({ task: { n: 1 }, pane: { id: upper, bound: true } })
    // The bind adds the UUID (as the worker and as the listing spell it) to the record, so the later label, mark and
    // close calls match it without asking cmux again.
    expect(readMuxStore(path)?.panes[0]).toMatchObject({ id: 'surface:2', ids: ['surface:2', upper, CU(2)], session: { harness: 'codex', session: 'worker-a' } })
    expect(c.lines()).toContain(`/opt/cmux rename-tab --surface surface:2 -- Worker 1 (claude) · Task 1: Step 1`)
    await finish(repo, A, 1, NOW + 1, { env: { ...CMUX_ENV, CMUX_SURFACE_ID: upper, BURACLE_NO_NOTIFY: '0' }, deps })
    c.reset()
    expect((await workMerge({}, ctxAt(repo, NOW + 2, CMUX_ENV), LEAD, deps)).data).toMatchObject({ merged: true, panes: { closed: ['surface:2'] } })
    expect(c.lines()).toContain(`/opt/cmux close-surface --surface surface:2 --force`)
  }))

  test('a close the multiplexer refuses is reported as refused with its reason, and the other panes are still asked; only a multiplexer that does not answer stops the round', () => sandbox(async root => {
    const { repo } = await published(root, { n: 2 })
    const c = fakeCmux()
    const deps = { exec: c.exec, cmuxBin: '/opt/cmux', which }
    expect((await workSpawn({ workers: 2, harness: 'claude' }, ctxAt(repo, NOW, CMUX_ENV), LEAD, deps)).errors).toEqual([])
    let closes = 0
    const refusing: MuxExec = async (argv, o) => (argv[1] === 'close-surface' ? (closes++, { code: 1, stdout: '', stderr: 'Error: surface is pinned' }) : c.exec(argv, o))
    const r = await workClose({ force: true }, ctxAt(repo, NOW + 1, CMUX_ENV), LEAD, { ...deps, exec: refusing })
    expect(r.data).toMatchObject({ panes: { closed: [], kept: [CU(2), CU(3)], stale: [], refused: [{ id: CU(2), message: 'Error: surface is pinned' }, { id: CU(3), message: 'Error: surface is pinned' }] } })
    // A refusal is an answer: the second pane was still asked.
    expect(closes).toBe(2)
    expect(r.errors.join('\n')).toContain('cmux refused to close')
    expect(r.errors.join('\n')).toContain('surface is pinned')
    expect(r.errors.join('\n')).not.toContain('did not answer')
  }))

  test('when the multiplexer does not answer, merge and close keep the records and report the panes as kept, never as closed or stale', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 2 })
    const live = new Set<string>()
    const h = fakeHerdr({ live })
    expect((await workSpawn({ workers: 2, harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
    const B = W('opencode', 'worker-b')
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p1' }), A)).code).toBe(0)
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p2' }), B)).code).toBe(0)
    await finish(repo, A, 1, NOW + 1)
    await finish(repo, B, 2, NOW + 2)
    let asked = 0
    const down: MuxExec = async () => { asked++; return { code: 124, stdout: '', stderr: 'timed out' } }
    // Task 2 is done, so nothing remains for A's pane: it should close, but herdr does not answer.
    const m = await workMerge({}, ctxAt(repo, NOW + 3, HERDR_ENV), LEAD, { exec: down })
    expect(m.data).toMatchObject({ merged: true, task: 1, panes: { closed: [], kept: ['w2:p1'], stale: [] } })
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes.map(p => p.id)).toEqual(['w2:p1', 'w2:p2'])
    asked = 0
    const c = await workClose({ force: true }, ctxAt(repo, NOW + 4, HERDR_ENV), LEAD, { exec: down })
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
    expect((await workSpawn({ workers: 2, harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
    o.getCode = 124
    const again = await workSpawn({ harness: 'claude' }, ctxAt(repo, NOW + 1, HERDR_ENV), LEAD, { exec: h.exec, which })
    expect(again.code).toBe(2)
    expect(again.errors.join('\n')).toContain('2 recorded pane(s) could not be checked')
    // Four ready tasks; the two recorded panes (opened a moment ago, so still starting) will take two of them.
    expect(again.data).toMatchObject({ workers: { requested: 2, opened: 2, active: 0, max: 6 } })
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes.map(p => p.id)).toEqual(['w2:p1', 'w2:p2', 'w2:p3', 'w2:p4'])
  }))

  test('once every pane of a board is gone, the next spawn may use another multiplexer and its panes are recorded under it', () => sandbox(async root => {
    // Task 2 is reserved for omp, which is not installed here at first: the claude pane has nothing left once Task 1 is merged.
    const { repo, commonDir } = await published(root, { n: 2, reserve: { n: 2, harness: 'omp' } })
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
    const first = await workSpawn({ harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec, which: b => b !== 'omp' })
    expect(first.data).toMatchObject({ opened: [{ id: 'w2:p1', harness: 'claude' }] })
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p1' }), A)).data).toMatchObject({ task: { n: 1 } })
    const b = readBoard(join(commonDir, 'buracle', 'board', 'rate-limit.json'))
    const wt = String(b?.tasks[0]?.worktree?.path)
    write(join(wt, 'src/s1.ts'), 'export const s1 = 1\n')
    await g(wt, 'add', '-A')
    await g(wt, 'commit', '-q', '-m', 'task 1: step 1')
    expect((await workDone({ verify: 'x' }, ctxAt(repo, NOW + 1), A)).code).toBe(0)
    // Nothing remains for the claude pane, and omp is still not installed, so the merge's tick opens nothing either.
    expect((await workMerge({}, ctxAt(repo, NOW + 2, HERDR_ENV), LEAD, { exec, which: b => b !== 'omp' })).data).toMatchObject({ panes: { closed: ['w2:p1'] }, scale: { opened: [], closed: ['w2:p1'] } })
    const path = muxStorePath(commonDir, 'rate-limit')
    expect(readMuxStore(path)).toEqual({ v: 1, slug: 'rate-limit', mux: 'herdr', panes: [] })
    // omp is installed now: the reserved task gets its pane, in tmux this time.
    const switched = await workSpawn({ mux: 'tmux', harness: 'claude' }, ctxAt(repo, NOW + 3, { ...HERDR_ENV, ...TMUX_LEAD }), LEAD, { exec, which })
    expect(switched.errors).toEqual([])
    expect(switched.data).toMatchObject({ mux: 'tmux', opened: [{ id: '%7', harness: 'omp' }] })
    expect(readMuxStore(path)).toMatchObject({ mux: 'tmux', panes: [{ id: '%7', harness: 'omp' }] })
  }))

  test('an unreadable sidecar is removed by close, so the next spawn records its panes again; a mux_mismatch dry run exits 0', () => sandbox(async root => {
    const { repo, plan, commonDir } = await published(root, { n: 2 })
    const path = muxStorePath(commonDir, 'rate-limit')
    const live = new Set<string>()
    const h = fakeHerdr({ live })
    expect((await workSpawn({ workers: 1, harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })).code).toBe(0)
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
    const r = await workSpawn({ workers: 1, harness: 'claude' }, ctxAt(repo, NOW + 4, HERDR_ENV), LEAD, { exec: h.exec, which })
    expect(r.errors).toEqual([])
    expect(readMuxStore(path)?.panes).toHaveLength(1)
  }))
})
