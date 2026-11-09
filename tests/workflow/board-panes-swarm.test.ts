// `work spawn` and `work join` with the swarm settings: the harnesses plan.board.harnesses leaves on, tasks reserved for one
// harness (`**Harness:**` in the plan), and the Herdr desktop app as the lead's multiplexer.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setStandby } from '../../src/core/board/model'
import { userConfigFile } from '../../src/engine/paths'
import { workDone, workJoin, workMerge, workPublish } from '../../src/workflow/board'
import { readBoard, updateBoard } from '../../src/workflow/board-store'
import { workSpawn } from '../../src/workflow/board-panes'
import type { MuxExec } from '../../src/workflow/mux'
import { workerCommand } from '../../src/workflow/mux'
import { muxStorePath, readMuxStore } from '../../src/workflow/mux-store'
import type { ResolvedSession } from '../../src/workflow/session-store'
import { HERDR_ENV, LEAD, NOW, fakeHerdr, published, sandbox, which } from './board-panes-helpers'
import { ctxAt, g, makeRepo, planDoc, write } from './fixture'

const A: ResolvedSession = { harness: 'codex', sessionId: 'worker-a', source: '--session' }
const W = (harness: ResolvedSession['harness'], id: string): ResolvedSession => ({ harness, sessionId: id, source: '--session' })

/** The worker commits its task's file in its lane worktree and reports done. */
async function finish(repo: string, path: string, worker: ResolvedSession, n: number, at: number): Promise<void> {
  const wt = String(readBoard(path)?.tasks.find(t => t.n === n)?.worktree?.path)
  write(join(wt, `src/s${n}.ts`), `export const s${n} = ${n}\n`)
  await g(wt, 'add', '-A')
  await g(wt, 'commit', '-q', '-m', `task ${n}: step ${n}`)
  const d = await workDone({ verify: `bun test tests/s${n}.test.ts → pass` }, ctxAt(repo, at), worker)
  if (d.code !== 0) throw new Error(`done ${n}: ${d.errors.join('; ')}`)
}

describe('the tick: standby workers, publish and merge open panes', () => {
  test('spawn subtracts the standby workers from the ready tasks and counts them in the cap; --dry-run prints them; starting panes count too', () => sandbox(async root => {
    const { repo, path } = await published(root, { n: 5, maxWorkers: 4 })
    updateBoard(path, NOW, b => ({ ok: true, board: setStandby(setStandby(b, { harness: 'codex', session: 'x' }, NOW), { harness: 'omp', session: 'y' }, NOW) }))
    const h = fakeHerdr()
    const dry = await workSpawn({ dryRun: true, harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })
    // 5 ready − 2 standby = 3 needed; 4 slots − 2 standby = 2 free.
    expect(dry.data).toMatchObject({ workers: { requested: 2, opened: 0, active: 0, standby: 2, max: 4 } })
    expect(dry.lines[0]).toBe('Dry run: 2 pane(s) would open in herdr for rate-limit (5 ready task(s), 0 active worker(s), 2 standby worker(s), 0 idle pane(s), 0 pane(s) starting, limit 4).')
    expect(h.calls).toEqual([])
    const r = await workSpawn({ harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })
    expect(r.errors).toEqual([])
    expect(r.data).toMatchObject({ workers: { requested: 2, opened: 2, active: 0, standby: 2, max: 4 } })
    // The two panes are starting now: they cover two more tasks and hold the last two slots.
    const again = await workSpawn({ dryRun: true, harness: 'claude' }, ctxAt(repo, NOW + 1000, HERDR_ENV), LEAD, { exec: h.exec, which })
    expect(again.data).toMatchObject({ workers: { requested: 0, standby: 2 } })
    expect(again.lines[0]).toContain('2 pane(s) starting')
  }))

  test('publish with Panes: and Swarm harnesses: opens the first wave itself, dealt to the plan\'s harnesses; a merge opens a pane for a task that becomes ready while no worker waits, and keeps the pane of a worker whose harness may still take one', () => sandbox(async root => {
    const h = fakeHerdr({ live: new Set<string>() })
    const deps = { exec: h.exec, which }
    const { repo, plan, path, commonDir, pub } = await published(root, { n: 3, dep: true, assumptions: ['Swarm: on', 'Swarm harnesses: codex, claude', 'Panes: herdr'], env: HERDR_ENV, deps })
    expect(pub.errors).toEqual([])
    expect(pub.data).toMatchObject({ harnesses: ['codex', 'claude'], panes: 'herdr', scale: { closed: [], opened: [
      { id: 'w2:p1', harness: 'codex', title: 'Worker 1 (codex) · waiting for a task' },
      { id: 'w2:p2', harness: 'claude', title: 'Worker 2 (claude) · waiting for a task' },
    ] } })
    expect(pub.lines.join('\n')).toContain('Opened 2 pane(s) in herdr for rate-limit: w2:p1 codex, w2:p2 claude')
    expect(pub.lines.join('\n')).not.toContain('buracle work spawn --json')
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes.map(p => [p.id, p.harness])).toEqual([['w2:p1', 'codex'], ['w2:p2', 'claude']])
    // A re-publish a second later opens nothing: the two panes are starting and cover the two ready tasks.
    const again = await workPublish({ planPath: plan }, ctxAt(repo, NOW + 1000, HERDR_ENV), LEAD, deps)
    expect(again.data).toMatchObject({ scale: { opened: [], closed: [] } })
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes).toHaveLength(2)
    const B = W('claude', 'worker-b')
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW + 2000, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p1' }), A)).data).toMatchObject({ task: { n: 1 }, pane: { bound: true } })
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW + 2000, { ...HERDR_ENV, HERDR_PANE_ID: 'w2:p2' }), B)).data).toMatchObject({ task: { n: 2 }, pane: { bound: true } })
    await finish(repo, path, A, 1, NOW + 3000)
    h.reset()
    // Task 3 becomes ready. A finished without waiting (an idle pane), so the merge opens a pane for Task 3 and keeps A's: Task 3 may still come for codex.
    const m1 = await workMerge({}, ctxAt(repo, NOW + 4000, HERDR_ENV), LEAD, deps)
    expect(m1.errors).toEqual([])
    expect(m1.data).toMatchObject({ merged: true, task: 1, panes: { closed: [] }, scale: { closed: [], opened: [{ id: 'w2:p3', harness: 'codex', title: 'Worker 3 (codex) · waiting for a task' }] } })
    expect(m1.lines.join('\n')).toContain('Opened 1 pane(s) in herdr for rate-limit: w2:p3 codex')
    expect(h.lines().filter(l => l.includes('pane close'))).toEqual([])
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))?.panes.map(p => p.id)).toEqual(['w2:p1', 'w2:p2', 'w2:p3'])
  }))

  test('plan.board.mux off: a publish with a Panes: line opens nothing and advises the terminals to open instead', () => sandbox(async root => {
    mkdirSync(dirname(userConfigFile()), { recursive: true })
    writeFileSync(userConfigFile(), 'version: 1\nplan:\n  board:\n    mux: "off"\n')
    const h = fakeHerdr()
    const { pub, commonDir } = await published(root, { n: 2, assumptions: ['Swarm: on', 'Panes: herdr'], env: HERDR_ENV, deps: { exec: h.exec, which } })
    expect(pub.data).toMatchObject({ panes: 'herdr', scale: { opened: [], closed: [], advice: '2 task(s) ready, 0 worker(s) waiting: open 2 terminal(s) in this repository and run `/buracle-join rate-limit` in each (`$buracle-join rate-limit` in Codex).' } })
    expect(h.calls.filter(c => c[2] === 'split')).toEqual([])
    expect(readMuxStore(muxStorePath(commonDir, 'rate-limit'))).toBeUndefined()
  }))
})

describe('work spawn: the swarm harnesses and reserved tasks', () => {
  test('without --harness the panes are dealt to the installed harnesses plan.board.harnesses leaves on; an off harness named in --harness is dropped with a warning; all off is harness_off', () => sandbox(async root => {
    const { repo } = await published(root, { n: 4 })
    mkdirSync(dirname(userConfigFile()), { recursive: true })
    writeFileSync(userConfigFile(), 'version: 1\nplan:\n  board:\n    harnesses:\n      omp: false\n')
    // Only claude and codex are installed here; opencode is on but missing, so the rotation is claude, codex.
    const installed = (bin: string): boolean => ['claude', 'codex'].includes(bin)
    const dry = await workSpawn({ dryRun: true }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: fakeHerdr().exec, which: installed })
    expect(dry.data).toMatchObject({ mux: 'herdr', harnesses: ['claude', 'codex'] })
    const h = fakeHerdr()
    const r = await workSpawn({}, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which: installed })
    expect(r.errors).toEqual([])
    expect((r.data['opened'] as Array<{ harness: string }>).map(p => p.harness)).toEqual(['claude', 'codex', 'claude', 'codex'])
    const { repo: repo2 } = await published(root, { n: 2, name: 'repo2' })
    const g = fakeHerdr()
    const w = await workSpawn({ harness: 'omp,claude' }, ctxAt(repo2, NOW, HERDR_ENV), LEAD, { exec: g.exec, which: installed })
    expect(w.code).toBe(2)
    expect(w.errors.join('\n')).toContain('plan.board.harnesses.omp')
    expect((w.data['opened'] as Array<{ harness: string }>).map(p => p.harness)).toEqual(['claude', 'claude'])
    const { repo: repo3 } = await published(root, { n: 1, name: 'repo3' })
    const off = await workSpawn({ harness: 'omp' }, ctxAt(repo3, NOW, HERDR_ENV), LEAD, { exec: fakeHerdr().exec, which: installed })
    expect(off.code).toBe(1)
    expect(off.data).toMatchObject({ error: 'harness_off' })
  }))

  test('a task reserved for a harness gets a pane of that harness whatever the rotation says; a reservation for an uninstalled harness opens no pane and warns', () => sandbox(async root => {
    const repo = await makeRepo(root, 'repo')
    const plan = join(repo, 'docs', 'plan-build', '2026-11-08-rate-limit.md')
    write(plan, planDoc({ n: 3, status: 'IN_PROGRESS', approved: true }).replace('**Objective:** Do step 2.', '**Objective:** Do step 2.\n\n**Harness:** codex'))
    expect((await workPublish({ planPath: plan }, ctxAt(repo, NOW), LEAD)).code).toBe(0)
    const h = fakeHerdr()
    const r = await workSpawn({ harness: 'claude' }, ctxAt(repo, NOW, HERDR_ENV), LEAD, { exec: h.exec, which })
    expect(r.errors).toEqual([])
    // The reserved task's pane comes first, so it opens even when fewer panes open than tasks are ready.
    expect((r.data['opened'] as Array<{ harness: string, title: string }>).map(p => `${p.harness} ${p.title}`)).toEqual([
      'codex Worker 1 (codex) · waiting for a task',
      'claude Worker 2 (claude) · waiting for a task',
      'claude Worker 3 (claude) · waiting for a task',
    ])
    const repo1b = await makeRepo(root, 'repo1b')
    const plan1b = join(repo1b, 'docs', 'plan-build', '2026-11-08-rate-limit.md')
    write(plan1b, planDoc({ n: 3, status: 'IN_PROGRESS', approved: true }).replace('**Objective:** Do step 3.', '**Objective:** Do step 3.\n\n**Harness:** codex'))
    expect((await workPublish({ planPath: plan1b }, ctxAt(repo1b, NOW), LEAD)).code).toBe(0)
    const one = await workSpawn({ harness: 'claude', workers: 1 }, ctxAt(repo1b, NOW, HERDR_ENV), LEAD, { exec: fakeHerdr().exec, which })
    expect((one.data['opened'] as Array<{ harness: string }>).map(p => p.harness)).toEqual(['codex'])
    const repo2 = await makeRepo(root, 'repo2')
    const plan2 = join(repo2, 'docs', 'plan-build', '2026-11-08-rate-limit.md')
    write(plan2, planDoc({ n: 2, status: 'IN_PROGRESS', approved: true }).replace('**Objective:** Do step 1.', '**Objective:** Do step 1.\n\n**Harness:** omp'))
    expect((await workPublish({ planPath: plan2 }, ctxAt(repo2, NOW), LEAD)).code).toBe(0)
    const g = fakeHerdr()
    const w = await workSpawn({ harness: 'claude' }, ctxAt(repo2, NOW, HERDR_ENV), LEAD, { exec: g.exec, which: (bin: string) => bin === 'claude' })
    expect(w.code).toBe(2)
    expect(w.errors.join('\n')).toMatch(/Task 1 .*omp.* not installed/)
    expect((w.data['opened'] as Array<{ harness: string }>).map(p => p.harness)).toEqual(['claude'])
  }))

  test('inside the Herdr app the panes are herdr-core terminals in the lead\'s tab: hc starts them, the sidecar records them under herdr-app, the layout line says the app places them', () => sandbox(async root => {
    const { repo, commonDir } = await published(root, { n: 2 })
    const HC_ENV = { HC_TERMINAL_ID: 't2', HC_TERMINAL_SOCKET: '/Users/me/.local/state/herdr-core/default/default.sock', SHELL: '/bin/zsh' }
    const calls: string[][] = []
    let next = 8
    const exec: MuxExec = async argv => {
      calls.push(argv)
      if (argv[0] === 'hc' && argv[1] === 'get') return { code: 0, stdout: JSON.stringify({ address: argv[2], state: 'live', pid: 4100, labels: { 'herdr.space': 'spe1', 'herdr.tab': 'tb1' } }), stderr: '' }
      if (argv[0] === 'hc' && argv[1] === 'run') return { code: 0, stdout: JSON.stringify({ address: `t${next++}`, state: 'live' }), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const r = await workSpawn({ harness: 'claude,codex' }, ctxAt(repo, NOW, HC_ENV), LEAD, { exec, which, hcBin: 'hc' })
    expect(r.errors).toEqual([])
    expect(r.data).toMatchObject({ mux: 'herdr-app', workers: { requested: 2, opened: 2 } })
    expect((r.data["opened"] as Array<{ id: string, harness: string, title: string }>)).toEqual([{ id: "t8", harness: 'claude', title: 'Worker 1 (claude) · waiting for a task' }, { id: 't9', harness: 'codex', title: 'Worker 2 (codex) · waiting for a task' }])
    const cwd = String(r.data['cwd'])
    expect(calls.map(c => c.join(' '))).toEqual([
      'hc get t2 --json',
      `hc run --json --bg --keep --outlive-parent --no-parent --no-notify --cwd ${cwd} --name worker-1-claude-rate-limit --label herdr.space=spe1 --label herdr.tab=tb1 -- /bin/zsh -lc ${workerCommand('claude', 'rate-limit', cwd, 'herdr-app')}`,
      'hc get t2 --json',
      `hc run --json --bg --keep --outlive-parent --no-parent --no-notify --cwd ${cwd} --name worker-2-codex-rate-limit --label herdr.space=spe1 --label herdr.tab=tb1 -- /bin/zsh -lc ${workerCommand('codex', 'rate-limit', cwd, 'herdr-app')}`,
    ])
    expect(r.lines).toContain('Layout: the Herdr app places the worker panes in the lead\'s tab.')
    const store = readMuxStore(muxStorePath(commonDir, 'rate-limit'))
    expect(store?.mux).toBe('herdr-app')
    expect(store?.panes.map(p => [p.id, p.server])).toEqual([['t8', HC_ENV.HC_TERMINAL_SOCKET], ['t9', HC_ENV.HC_TERMINAL_SOCKET]])
    // A worker in such a terminal is found by HC_TERMINAL_ID.
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW, { ...HC_ENV, HC_TERMINAL_ID: 't9', BURACLE_NO_NOTIFY: '0' }), A, { exec, hcBin: 'hc' })
    expect(j.data['pane']).toEqual({ mux: 'herdr-app', id: 't9', bound: true })
    expect(calls.at(-1)?.join(' ')).toBe('hc label t9 buracle.label=Worker 2 (codex) · Task 1: Step 1')
  }))
})
