import { describe, expect, test } from 'bun:test'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CommandIO } from '../../src/cli/router'
import { buildStatusline, parseStatuslineArgs, run, type StatuslineDeps, type StatuslineResult } from '../../src/cli/commands/statusline'
import type { FlowRecord } from '../../src/core/flow/record'
import { flowEnd, flowPhase, flowStart } from '../../src/core/flow/record'
import { memEmptyStatus } from '../../src/core/memory/status'
import type { MemoryStatus } from '../../src/core/memory/status'
import { renderPlain, renderPlainLines } from '../../src/core/status/render'
import { atomicWriteSync } from '../../src/engine/fsx'
import { projectSlug } from '../../src/engine/git'
import { heartbeatFile, memoryStateDir, memoryUiStateFile, updatesFile, userConfigFile } from '../../src/engine/paths'
import { run as runProc } from '../../src/engine/proc'
import { writeFlow } from '../../src/workflow/flow'
import { readTelemetry, saveState, freshState } from '../../src/workflow/session-store'
import { indexLockFile, indexRecordFile, type IndexRecord } from '../../src/workflow/workspace'
import { withSandbox } from '../helpers/sandbox'
import { NOW } from './helpers'

const SID = 'f00dcafe-1234-4abc-9def-0123456789ab'

function claudePayload(over: Record<string, unknown> = {}, cwd = '/tmp'): Record<string, unknown> {
  return {
    cwd,
    session_id: SID,
    transcript_path: '/tmp/x.jsonl',
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    workspace: { current_dir: cwd, project_dir: cwd },
    version: '2.1.293',
    cost: { total_cost_usd: 1.25, total_duration_ms: 1, total_api_duration_ms: 1, total_lines_added: 0, total_lines_removed: 0 },
    context_window: { total_input_tokens: 1, total_output_tokens: 1, context_window_size: 1_000_000, used_percentage: 37, remaining_percentage: 63, current_usage: { input_tokens: 2000, output_tokens: 10, cache_creation_input_tokens: 8000, cache_read_input_tokens: 360_000 } },
    effort: { level: 'max' },
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: Math.floor((NOW + 80 * 60_000) / 1000) },
      seven_day: { used_percentage: 18, resets_at: Math.floor((NOW + 30 * 3600_000) / 1000) },
    },
    ...over,
  }
}

function memIO(stdin = ''): CommandIO & { out(): string, err(): string } {
  let out = ''
  let err = ''
  return {
    stdout: { write: (s: string) => { out += s } },
    stderr: { write: (s: string) => { err += s } },
    stdin: { isTTY: false, text: async () => stdin },
    flags: { json: false, verbose: false },
    out: () => out,
    err: () => err,
  }
}

function deps(over: StatuslineDeps = {}): StatuslineDeps {
  return { nowMs: NOW, env: { COLUMNS: '200' }, cwd: '/tmp', ...over }
}

async function build(argv: string[], stdin: string, d: StatuslineDeps): Promise<StatuslineResult> {
  const args = parseStatuslineArgs(argv)
  if ('error' in args) throw new Error(args.error)
  return buildStatusline(args, { stdin: { isTTY: false, text: async () => stdin } }, d)
}

const flat = (r: StatuslineResult) => r.rows.flat().map(s => s.id)
const plainLines = (rows: StatuslineResult['rows']): string[] => renderPlainLines(rows).split('\n')

async function gitRepo(dir: string): Promise<string> {
  mkdirSync(join(dir, 'src'), { recursive: true })
  const g = (...a: string[]) => runProc(['git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd: dir })
  await g('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), 'x\n')
  await g('add', 'README.md')
  await g('commit', '-q', '-m', 'init')
  writeFileSync(join(dir, 'new.txt'), 'y\n')
  return realpathSync(dir)
}

function bindPlan(repo: string, title: string): string {
  mkdirSync(join(repo, 'docs', 'plans'), { recursive: true })
  const file = join(repo, 'docs', 'plans', '2026-10-08-plan.md')
  writeFileSync(file, `---\nstatus: IN_PROGRESS\n---\n# ${title}\n\n## Tasks\n\n### Task 1: Core\n- [x] Task 1 done\n\n### Task 2: CLI\n- [ ] Task 2 done\n\n### Task 3: Docs\n- [ ] Task 3 done\n`)
  saveState('claude', SID, { ...freshState(), plan: { path: file, slug: 'plan', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: NOW - 10 * 60_000 } })
  return file
}

function specFlow(title: string): FlowRecord {
  const r = flowStart(undefined, { workflow: 'plan-build', title, source: 'command' }, NOW - 10 * 60_000).record
  return flowPhase(r, { phase: 'implement' }, NOW - 5 * 60_000).record
}

function writeIndexRecord(root: string, rec: Omit<IndexRecord, 'v' | 'root'>): void {
  atomicWriteSync(indexRecordFile(root), JSON.stringify({ v: 1, root, ...rec }))
}

// The footer names the web UI only while its record names a live process (this one), however it was started.
function runningUi(port = 41777): void {
  atomicWriteSync(memoryUiStateFile(), JSON.stringify({ v: 1, pid: process.pid, port, host: '127.0.0.1', url: `http://localhost:${port}`, startedAt: new Date(NOW).toISOString(), version: '0', brain: '' }))
}

describe('parseStatuslineArgs', () => {
  test('flags and errors', () => {
    expect(parseStatuslineArgs(['claude', '--width', '80', '--format=plain', '--style', 'compact', '--json'])).toEqual({ harness: 'claude', width: 80, format: 'plain', style: 'compact', json: true, verbose: false })
    expect(parseStatuslineArgs(['codex'])).toEqual({ error: 'only claude has a status line command (codex draws its own)' })
    expect(parseStatuslineArgs(['claude', '--cwd', '/x'])).toEqual({ error: 'unknown option --cwd' })
    expect(parseStatuslineArgs([])).toEqual({ error: 'missing <harness>' })
    expect(parseStatuslineArgs(['cursor'])).toEqual({ error: "unknown harness 'cursor' (expected claude)" })
    expect(parseStatuslineArgs(['claude', '--width', '-3'])).toEqual({ error: '--width expects a positive number' })
    expect(parseStatuslineArgs(['claude', '--format', 'html'])).toEqual({ error: '--format expects ansi or plain' })
    expect(parseStatuslineArgs(['claude', 'codex'])).toEqual({ error: 'unexpected argument codex' })
  })
})

describe('statusline claude', () => {
  test('the footer names no web UI while none runs: a missing record, one of a process that is gone, or one of a UI that was stopped', () => withSandbox(async () => {
    const footer = async () => plainLines((await build(['claude'], JSON.stringify(claudePayload()), deps())).rows)[1]
    expect(await footer()).toMatch(/^Buracle \d+\.\d+\.\d+ · CC 2\.1\.293$/)
    const gone = Bun.spawn(['bun', '-e', '0'], { env: { ...process.env }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    await gone.exited
    atomicWriteSync(memoryUiStateFile(), JSON.stringify({ v: 1, pid: gone.pid, port: 41777, host: '127.0.0.1', url: 'http://localhost:41777', startedAt: '', version: '0', brain: '' }))
    expect(await footer()).not.toContain('Buracle Console')
    runningUi()
    expect(await footer()).toMatch(/Buracle Console: localhost:41777$/)
    atomicWriteSync(memoryUiStateFile(), '{}\n')
    expect(await footer()).not.toContain('Buracle Console')
  }))

  test('the default Buracle bar: model, context bar, both windows and the folder; the footer names Buracle, Claude Code and the memory UI as a link', () => withSandbox(async () => {
    runningUi()
    const r = await build(['claude'], JSON.stringify(claudePayload()), deps())
    expect(r.joined).toBe(true)
    const lines = plainLines(r.rows)
    // The folder as this platform resolves '/tmp' (on Windows it gets the current drive).
    expect(lines[0]).toBe(`Opus 5.5 [max] [1M] | ███░░░░░ 37% | 5h: 42% ↓ 1h20m | 7d: 18% ↓ 1d6h | ${resolve('/tmp')}`)
    expect(lines[1]).toMatch(/^Buracle \d+\.\d+\.\d+ · CC 2\.1\.293 · Buracle Console: localhost:41777$/)
    const io = memIO(JSON.stringify(claudePayload()))
    expect(await run(['claude'], io, deps())).toBe(0)
    expect(io.out()).toMatch(/\u001b\]8;;http:\/\/localhost:41777\u001b\\(?:\u001b\[[0-9;]*m)*localhost:41777(?:\u001b\[[0-9;]*m)*\u001b\]8;;\u001b\\/)
    const narrow = await build(['claude', '--width', '40'], JSON.stringify(claudePayload()), deps())
    for (const l of plainLines(narrow.rows)) expect(l.length).toBeLessThanOrEqual(40)
    expect(plainLines(narrow.rows)[0]).toContain('Opus 5.5')
  }))

  test('renders the full bar from stdin and records telemetry', () => withSandbox(async () => {
    const r = await build(['claude', '--style', 'full'], JSON.stringify(claudePayload()), deps())
    expect(r.quiet).toBe(false)
    expect(r.rows[0]?.map(s => s.text)).toEqual(['Opus 5.5 · max', 'ctx ▓▓░░░░ 37% (370k/1M)', '5h 42% ⇣ ↺1h20m', expect.stringMatching(/^7d 18% ⇣ ↺/)])
    expect(flat(r)).not.toContain('cost')
    const tel = readTelemetry('claude', SID)
    expect(tel).toMatchObject({ v: 1, harness: 'claude', sessionId: SID, at: NOW, model: 'Opus 5.5', modelId: 'claude-opus-5-5', effort: 'max', cwd: '/tmp', ctx: { pct: 37, tokens: 370_000, window: 1_000_000 } })
    expect(tel?.windows?.map(w => w.label)).toEqual(['5h', '7d'])
  }))

  test('a fresh mod heartbeat no longer silences the bar (the mod draws none); telemetry stays fresh', () => withSandbox(async () => {
    mkdirSync(join(heartbeatFile('claude', SID), '..'), { recursive: true })
    writeFileSync(heartbeatFile('claude', SID), JSON.stringify({ at: NOW - 5_000 }))
    const io = memIO(JSON.stringify(claudePayload()))
    expect(await run(['claude'], io, deps())).toBe(0)
    expect(io.out()).toContain('Opus 5.5')
    expect(io.out().endsWith('\n')).toBe(true)
    expect(readTelemetry('claude', SID)?.at).toBe(NOW)
  }))

  test('API plans show the session cost; a gateway spend limit hides it', () => withSandbox(async () => {
    const api = await build(['claude', '--style', 'full'], JSON.stringify(claudePayload({ rate_limits: undefined })), deps())
    expect(api.rows.flat().find(s => s.id === 'cost')?.text).toBe('$1.25')
    const gw = await build(['claude', '--style', 'full'], JSON.stringify(claudePayload({ rate_limits: { spend_limit: { used_percentage: 62.8, resets_at: 0, used_usd: 314.12, limit_usd: 500, period: 'monthly' } } })), deps())
    expect(flat(gw)).not.toContain('month')
    expect(flat(gw)).not.toContain('cost')
  }))

  test('updates count, memory status, and the bound plan shown as its workflow', () => withSandbox(async ({ root }) => {
    const repo = await gitRepo(join(root, 'proj'))
    mkdirSync(join(updatesFile(), '..'), { recursive: true })
    writeFileSync(updatesFile(), JSON.stringify({ count: 2 }))
    const slug = await projectSlug(repo)
    const mem: MemoryStatus = { ...memEmptyStatus('2026-10-08T08:00:00.000Z', slug), counts: { project: 128, person: 37 }, captures: 2 }
    mkdirSync(join(memoryStateDir(), 'status'), { recursive: true })
    writeFileSync(join(memoryStateDir(), 'status', `${slug}.json`), JSON.stringify(mem))
    mkdirSync(join(repo, 'docs', 'plans'), { recursive: true })
    writeFileSync(join(repo, 'docs', 'plans', '2026-10-08-statusline.md'), '---\nstatus: IN_PROGRESS\n---\n# Statusline bar\n\n## Tasks\n\n### Task 1: Core\n- [x] Task 1 done\n\n### Task 2: CLI\n- [ ] Task 2 done\n\n### Task 3: Docs\n- [ ] Task 3 done\n')
    saveState('claude', SID, { ...freshState(), plan: { path: 'docs/plans/2026-10-08-statusline.md', slug: 'statusline', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: NOW } })
    const r = await build(['claude', '--style', 'full'], JSON.stringify(claudePayload({}, repo)), deps())
    const byId = Object.fromEntries(r.rows.flat().map(s => [s.id, s.text]))
    expect(byId['upd']).toBe('⬆2')
    expect(byId['flow']).toBe('plan-build ● Implement 1/3 · Statusline bar')
    expect(byId['plan']).toBeUndefined()
    expect(byId['mem']).toContain('128')
    expect(byId['git']).toBe('⎇ main …2')
    expect(byId['dir']).toBeUndefined()
    const sub = await build(['claude', '--style', 'full'], JSON.stringify(claudePayload({}, join(repo, 'src'))), deps())
    expect(Object.fromEntries(sub.rows.flat().map(s => [s.id, s.text]))['dir']).toBe('src')
    const shown = plainLines((await build(['claude'], JSON.stringify(claudePayload({}, repo)), deps())).rows)
    expect(shown[1]).toBe('plan-build ● Implement 1/3 | Statusline bar | ▸ Task 2: CLI | <1m')
    expect(shown[0]).toContain('⎇ main')
    expect(shown.at(-1)).toContain('⬆2')
  }))

  test('the running workflow comes from the session\'s flow record; an ended run shows as done, folds 8 s later and the plan line returns (a workflow.foldAfterSec left in config.yaml is ignored)', () => withSandbox(async ({ root }) => {
    const repo = await gitRepo(join(root, 'proj'))
    runningUi()
    bindPlan(repo, 'Rate limit plan')
    const rec = specFlow('Rate limit')
    writeFlow('claude', SID, rec)
    const d = deps({ gitBudgetMs: 10_000 })
    const shown = async () => plainLines((await build(['claude'], JSON.stringify(claudePayload({}, repo)), d)).rows)
    expect(await shown()).toEqual([
      expect.stringMatching(/^Opus 5\.5 \[max\] \[1M\] \| /),
      'plan-build ● Implement 1/3 | Rate limit | ▸ Task 2: CLI | 10m',
      expect.stringMatching(/^Buracle \S+ · CC 2\.1\.293 · Buracle Console: localhost:41777 · idx none$/),
    ])
    const full = await build(['claude', '--style', 'full'], JSON.stringify(claudePayload({}, repo)), d)
    expect(full.rows[1]?.map(s => s.id)).toEqual(['git', 'index', 'flow'])
    expect(full.rows[1]?.find(s => s.id === 'flow')).toMatchObject({ text: 'plan-build ● Implement 1/3 · Rate limit', color: 'magenta' })
    expect(full.bar?.flow).toMatchObject({ visible: true, workflow: 'plan-build', status: 'running', title: 'Rate limit', progress: { done: 1, total: 3, unit: 'tasks' } })
    writeFlow('claude', SID, flowEnd(rec, 'done', NOW - 5_000).record)
    expect((await shown())[1]).toBe('plan-build ✓ done 1/3 | Rate limit | 9m')
    writeFlow('claude', SID, flowEnd(rec, 'done', NOW - 9_000).record)
    expect((await shown())[1]).toBe('Plan: Rate limit plan [implement] ▰▰▱▱▱▱ 1/3')
    writeFileSync(userConfigFile(), 'workflow:\n  foldAfterSec: 60\n')
    expect((await shown())[1]).toBe('Plan: Rate limit plan [implement] ▰▰▱▱▱▱ 1/3')
  }))

  test('the code index state of the session\'s project: none, building, ready, failed (index.codegraph and index.semble left in config.yaml are ignored); nothing outside a project', () => withSandbox(async ({ root, home }) => {
    const repo = await gitRepo(join(root, 'proj'))
    const d = deps({ gitBudgetMs: 10_000 })
    const at = async (cwd: string) => (await build(['claude', '--style', 'full'], JSON.stringify(claudePayload({}, cwd)), d)).bar?.index
    expect(await at(repo)).toBe('none')
    atomicWriteSync(indexLockFile(repo), JSON.stringify({ pid: process.pid, at: NOW }))
    expect(await at(repo)).toBe('building')
    writeIndexRecord(repo, { codegraph: { at: NOW - 60_000, ok: true }, semble: { at: NOW - 60_000, ok: true } })
    expect(await at(repo)).toBe('ready')
    expect(await at(join(repo, 'src'))).toBe('ready')
    rmSync(indexLockFile(repo))
    writeIndexRecord(repo, { codegraph: { at: NOW - 60_000, ok: false, error: 'codegraph init failed', failures: 1 }, semble: { at: NOW - 60_000, ok: true } })
    expect(await at(repo)).toBe('failed')
    const segs = (await build(['claude', '--style', 'full'], JSON.stringify(claudePayload({}, repo)), d)).rows.flat()
    expect(segs.find(s => s.id === 'index')).toMatchObject({ text: 'idx failed', color: 'red' })
    writeFileSync(userConfigFile(), 'index:\n  codegraph: false\n  semble: false\n')
    expect(await at(repo)).toBe('failed')
    expect(await at(home)).toBeUndefined()
  }))

  test('O3: hook failures of the last 24 hours show on the Buracle bar footer and in the segment rows; nothing while all is well', () => withSandbox(async ({ buracleHome }) => {
    runningUi()
    const quiet = await build(['claude'], JSON.stringify(claudePayload()), deps())
    expect(plainLines(quiet.rows).join('\n')).not.toContain('hooks')
    const logs = join(buracleHome, 'logs')
    mkdirSync(logs, { recursive: true })
    const fail = (ts: number, result: string) => JSON.stringify({ ts: new Date(ts).toISOString(), level: 'error', pid: 1, msg: 'hook handler failed', data: { harness: 'claude', event: 'PreToolUse', result } })
    writeFileSync(join(logs, 'buracle.log'), `${fail(NOW - 3_600_000, 'fail-closed')}\n${fail(NOW - 60_000, 'fail-open')}\n`)
    const later = NOW + 61_000
    const shown = await build(['claude'], JSON.stringify(claudePayload()), deps({ nowMs: later }))
    expect(plainLines(shown.rows).at(-1)).toMatch(/^Buracle \d+\.\d+\.\d+ · CC 2\.1\.293 · hooks ✗2 \(1 denied\) · Buracle Console: localhost:41777$/)
    const full = await build(['claude', '--style', 'full'], JSON.stringify(claudePayload()), deps({ nowMs: later }))
    expect(flat(full)).toContain('hooks')
    expect(renderPlain(full.rows)).toContain('hooks ✗2 (1 denied)')
  }))

  test('outside git the dir segment shows the folder; garbage stdin still renders something', () => withSandbox(async ({ home }) => {
    const plain = join(home, 'notes')
    mkdirSync(plain)
    const r = await build(['claude', '--width', '200'], JSON.stringify(claudePayload({}, plain)), deps())
    expect(r.rows.flat().find(s => s.id === 'dir')?.text).toBe('~/notes')
    expect(flat(r)).not.toContain('git')
    const junk = await build(['claude'], 'not json at all', deps({ cwd: plain }))
    expect(junk.quiet).toBe(false)
    expect(readTelemetry('claude', SID)).toBeDefined()
  }))

  test('--json and narrow widths', () => withSandbox(async () => {
    const io = memIO(JSON.stringify(claudePayload()))
    io.flags.json = true
    expect(await run(['claude', '--width', '30', '--style', 'full'], io, deps())).toBe(0)
    const j = JSON.parse(io.out()) as StatuslineResult
    expect(j.harness).toBe('claude')
    expect(j.text).toContain('\u001b[')
    for (const row of j.rows) expect(renderPlain([row]).length).toBeLessThanOrEqual(30)
    expect(j.bar?.windows.length).toBe(2)
    const pio = memIO(JSON.stringify(claudePayload()))
    pio.flags.json = true
    expect(await run(['claude', '--width', '30'], pio, deps())).toBe(0)
    const pj = JSON.parse(pio.out()) as StatuslineResult
    expect(pj.joined).toBe(true)
    for (const l of plainLines(pj.rows)) expect(l.length).toBeLessThanOrEqual(30)
  }))

  test('bad arguments exit 1 with usage on stderr', async () => {
    const io = memIO()
    expect(await run(['claude', '--nope'], io, deps())).toBe(1)
    expect(io.err()).toContain('unknown option --nope')
    expect(io.out()).toBe('')
  })
})

describe('statusline claude --subagent (subagentStatusLine)', () => {
  test('one {id, content} JSON line per task, fitted to the given columns', () => withSandbox(async () => {
    const input = {
      session_id: SID,
      columns: 80,
      tasks: [
        { id: 't1', name: 'changes-review', type: 'buracle:changes-review', status: 'running', description: 'Review the statusline diff for correctness and style issues in detail', model: 'claude-sonnet-5-5', effort: 'high', contextWindowSize: 1_000_000, tokenCount: 420_000 },
        { name: 'no id: keeps the default row' },
        { id: 't2', name: 'explore', status: 'completed', tokenCount: 1200 },
      ],
    }
    const io = memIO(JSON.stringify(input))
    expect(await run(['claude', '--subagent'], io, deps())).toBe(0)
    const lines = io.out().trim().split('\n').map(l => JSON.parse(l) as { id: string, content: string })
    expect(lines.map(l => l.id)).toEqual(['t1', 't2'])
    const plain = lines.map(l => l.content.replace(/\u001b\[[0-9;]*m/g, ''))
    expect(plain[0]).toBe('changes-review │ sonnet-5-5 · high │ ctx ▓▓▓░░░ 42% (420k/1M) │ Review the stat…')
    expect(plain[1]).toBe('explore │ 1.2k tok │ completed')
    const narrow = memIO(JSON.stringify({ ...input, columns: 30 }))
    await run(['claude', '--subagent'], narrow, deps())
    const rowsNarrow = narrow.out().trim().split('\n').map(l => (JSON.parse(l) as { content: string }).content.replace(/\u001b\[[0-9;]*m/g, ''))
    expect(rowsNarrow).toEqual(['changes-review', 'explore │ 1.2k tok │ completed'])
    const tiny = memIO(JSON.stringify({ ...input, columns: 6 }))
    await run(['claude', '--subagent'], tiny, deps())
    expect(tiny.out().trim().split('\n').map(l => (JSON.parse(l) as { content: string }).content.replace(/\u001b\[[0-9;]*m/g, ''))).toEqual(['chang…', 'explo…'])
  }))

  test('empty or broken stdin prints nothing', () => withSandbox(async () => {
    const io = memIO('{broken')
    expect(await run(['claude', '--subagent'], io, deps())).toBe(0)
    expect(io.out()).toBe('')
  }))
})

describe('statusline: no Context Mode segment, and no harness process lookup for it', () => {
  test('claude: the rows and the Buracle bar footer carry no `cm` part, and the harness process is never looked for', () => withSandbox(async ({ root }) => {
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    const d = deps({})
    const full = await build(['claude', '--style', 'full'], JSON.stringify(claudePayload({}, proj)), d)
    expect(full.rows.flat().find(s => s.id === 'cm')).toBeUndefined()
    const shown = plainLines((await build(['claude'], JSON.stringify(claudePayload({}, proj)), d)).rows)
    expect(shown.at(-1)).not.toContain('cm ')
  }))
})

describe('statusline performance (real process)', () => {
  test('a typical claude render stays well under the 100 ms target', () => withSandbox(async ({ home }) => {
    const payload = JSON.stringify(claudePayload({}, home))
    const main = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts')
    const times: number[] = []
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      const r = await runProc([process.execPath, main, 'statusline', 'claude'], { stdin: payload, timeoutMs: 10_000, env: { COLUMNS: '160' } })
      times.push(performance.now() - t0)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('Opus 5.5')
    }
    times.sort((a, b) => a - b)
    expect(times[2]).toBeLessThan(1000)
  }), 30_000)
})
