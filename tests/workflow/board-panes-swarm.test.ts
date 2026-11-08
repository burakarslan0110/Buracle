// `work spawn` and `work join` with the swarm settings: the harnesses plan.board.harnesses leaves on, tasks reserved for one
// harness (`**Harness:**` in the plan), and the Herdr desktop app as the lead's multiplexer.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { userConfigFile } from '../../src/engine/paths'
import { workJoin, workPublish } from '../../src/workflow/board'
import { workSpawn } from '../../src/workflow/board-panes'
import type { MuxExec } from '../../src/workflow/mux'
import { workerCommand } from '../../src/workflow/mux'
import { muxStorePath, readMuxStore } from '../../src/workflow/mux-store'
import type { ResolvedSession } from '../../src/workflow/session-store'
import { HERDR_ENV, LEAD, NOW, fakeHerdr, published, sandbox, which } from './board-panes-helpers'
import { ctxAt, makeRepo, planDoc, write } from './fixture'

const A: ResolvedSession = { harness: 'codex', sessionId: 'worker-a', source: '--session' }

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
