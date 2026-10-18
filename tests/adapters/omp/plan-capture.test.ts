import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBuracleExtension, type ExtensionDeps } from '../../../src/adapters/omp/runtime/extension'
import { approvedPlanOf, approvingResult, ompAutosaveDir, planFileOf, STAGED_PLAN_MAX_AGE_MS, STAGED_PLAN_STALE_MS, USER_PLAN_MAX_AGE_MS } from '../../../src/adapters/omp/runtime/plan-capture'
import { parsePlan } from '../../../src/core/plan/format'
import { detectIntent, isGuardContinuation } from '../../../src/core/policy/intents'
import * as paths from '../../../src/engine/paths'
import { loadState } from '../../../src/workflow/session-store'
import { withSandbox, type Sandbox } from '../../helpers/sandbox'
import { NATIVE_PLAN_BODY, prepareNativePlan } from '../../workflow/fixture'
import { fakeCtx, fakePi, testDeps, testGenerated } from './fakes'

const SID = '01a118a8-8d01-740c-9360-f4f796699f4b'
const PLAN = '# Add a cache\n\n1. Cache the index\n2. Test it'

const approvalPrompt = (plan: string, preserved = false): string => [
  'Plan approved.',
  ...(preserved ? ['- History usable; the plan below authoritative if it conflicts with earlier exploration.'] : []),
  '',
  '<instruction>',
  'Full plan inlined below; durable copy at `local://CACHE_PLAN.md` (identical content).',
  'Execute plan step-by-step with full tool access; MUST verify each step before next.',
  '</instruction>',
  '',
  '<plan path="local://CACHE_PLAN.md">',
  plan,
  '</plan>',
  '',
  '<critical>',
  'Inline plan compressed, expired, or unrecoverable: NEVER stop; read `local://CACHE_PLAN.md`.',
  '</critical>',
].join('\n')

function setup(sb: Sandbox, ctxOpts: Partial<Parameters<typeof fakeCtx>[0]> = {}, overrides: Partial<ExtensionDeps> = {}) {
  const cwd = join(sb.root, 'work')
  mkdirSync(cwd, { recursive: true })
  const policy = { ...testDeps().deps.policy!, capabilityCard: () => '', detectIntent, isGuardContinuation }
  const t = testDeps({ policy, ...overrides })
  const fp = fakePi({ thinking: 'high' })
  createBuracleExtension(testGenerated(), t.deps)(fp.pi)
  const ctx = fakeCtx({ cwd, sid: SID, ...ctxOpts })
  const now = (t.deps.now as () => number)()
  return { ...t, fp, ctx, cwd, now }
}

function stage(name: string, text: string, mtimeMs: number, dir = paths.ompPlanStagingDir()): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, text)
  utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
  return file
}

function saved(cwd: string): string[] {
  const dir = join(cwd, 'docs', 'plans')
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

const agentStart = (prompt: string) => ({ type: 'before_agent_start', prompt, systemPrompt: [] as string[] })
const proposeResult = (text: string, planExists = true) => ({
  type: 'tool_result', toolCallId: 'p1', toolName: 'write', input: { path: 'xd://propose', content: 'Add a cache' }, isError: false,
  content: [{ type: 'text', text }],
  details: { xdev: { tool: 'propose', mode: 'execute', args: { title: 'Add a cache' }, inner: { planFilePath: 'local://CACHE_PLAN.md', title: 'Add a cache', planExists } } },
})

describe('omp H12: an approved plan reaches docs/plans/', () => {
  test('the execution prompt omp sends after "Approve and execute" carries the plan: saved once, the agent and the TUI are told, the identical autosave copy is dropped', () => withSandbox(async sb => {
    const s = setup(sb)
    const copy = stage('CACHE_PLAN.md', `${PLAN}\n`, s.now)
    const r = await s.fp.emit('before_agent_start', agentStart(approvalPrompt(PLAN)), s.ctx) as { message?: { content: string } } | undefined
    const files = saved(s.cwd)
    expect(files.map(f => f.replace(/^\d{4}-\d{2}-\d{2}-/, ''))).toEqual(['add-a-cache.md'])
    const text = readFileSync(join(s.cwd, 'docs', 'plans', files[0] as string), 'utf8')
    expect(parsePlan(text).header).toMatchObject({ status: 'SAVED', approved: true, type: 'Plan' })
    expect(text).toContain('harness: omp')
    expect(text).toContain('> 2. Test it')
    expect(r?.message?.content).toContain(`docs/plans/${files[0]} (H12)`)
    expect(s.ctx.uiCalls.some(c => c.method === 'notify' && String(c.args[0]).includes('(H12)'))).toBe(true)
    expect(existsSync(copy)).toBe(false)
    expect(s.memory.spool.flatMap(x => x.entries).some(e => e.ev === 'note' && e.paths?.[0]?.endsWith(files[0] as string) === true)).toBe(true)
    await s.fp.emit('before_agent_start', agentStart('thanks, go on'), s.ctx)
    expect(saved(s.cwd)).toEqual(files)
  }))

  test('plan-yolo and ACP: the approving tool result reads the plan file it names from the session\'s local:// folder, whatever the autosave settings; only the identical staged copy is dropped', () => withSandbox(async sb => {
    const artifacts = join(sb.root, 'session-artifacts')
    const s = setup(sb, { artifacts })
    mkdirSync(paths.ompAgentDir(), { recursive: true })
    writeFileSync(join(paths.ompAgentDir(), 'config.yml'), 'plan:\n  autosave: false\n')
    stage('CACHE_PLAN.md', `${PLAN}\n`, s.now - 1_000, join(artifacts, 'local'))
    const same = stage('ADD_A_CACHE_PLAN.md', `${PLAN}\n`, s.now - 1_000)
    const other = stage('OTHER_PROJECT_PLAN.md', '# Other project\n\n1. Elsewhere\n2. Not here\n', s.now - 2_000)
    const r = await s.fp.emit('tool_result', proposeResult('Plan approved at local://CACHE_PLAN.md. Plan mode exited; proceed with the implementation.'), s.ctx) as { additionalContext?: string } | undefined
    const files = saved(s.cwd)
    expect(files.map(f => f.replace(/^\d{4}-\d{2}-\d{2}-/, ''))).toEqual(['add-a-cache.md'])
    expect(readFileSync(join(s.cwd, 'docs', 'plans', files[0] as string), 'utf8')).toContain('> 1. Cache the index')
    expect(r?.additionalContext).toContain('(H12)')
    expect([existsSync(same), existsSync(other)]).toEqual([false, true])
  }))

  test('plan-yolo and ACP send no prompt: the approving tool result saves omp\'s autosave copy from the staging folder; a refinement saves nothing', () => withSandbox(async sb => {
    const s = setup(sb)
    const copy = stage('ADD_A_CACHE_PLAN.md', `${PLAN}\n`, s.now - 5_000)
    expect(await s.fp.emit('tool_result', proposeResult('Plan refinement requested. Update the plan file, then write Add a cache to xd://propose again when ready.'), s.ctx)).toBeUndefined()
    expect(saved(s.cwd)).toEqual([])
    expect(existsSync(copy)).toBe(true)
    const r = await s.fp.emit('tool_result', proposeResult('Plan approved. Implementing now with gpt-5.5.'), s.ctx) as { additionalContext?: string } | undefined
    expect(saved(s.cwd).length).toBe(1)
    expect(r?.additionalContext).toContain('(H12)')
    expect(existsSync(copy)).toBe(false)
  }))

  test('plan.nativePlanMode: the execution prompt after the approval fills the prepared plan-build plan, marked approved; the agent and the TUI are told', () => withSandbox(async sb => {
    const s = setup(sb)
    const path = await prepareNativePlan(s.cwd, 'omp', SID)
    const r = await s.fp.emit('before_agent_start', agentStart(approvalPrompt(NATIVE_PLAN_BODY.trim())), s.ctx) as { message?: { content: string } } | undefined
    expect(r?.message?.content).toContain('the plan the user approved in Oh My Pi plan mode was written into the registered plan')
    expect(s.ctx.uiCalls.some(c => c.method === 'notify' && String(c.args[0]).includes('plan.nativePlanMode'))).toBe(true)
    const text = readFileSync(path, 'utf8')
    expect(parsePlan(text).header).toMatchObject({ type: 'Feature', status: 'PENDING', approved: true })
    expect(saved(s.cwd)).toEqual([path.split('/').at(-1) as string])
    expect(loadState('omp', SID).approvals?.planApprovedAt).toBe(s.now)
  }))

  test('a subagent never saves; an ordinary prompt reads no staged copy and only removes a day-old one; an approval skips a copy older than the window', () => withSandbox(async sb => {
    const sub = setup(sb, { kind: 'sub', name: 'worker' })
    await sub.fp.emit('before_agent_start', agentStart(approvalPrompt(PLAN)), sub.ctx)
    expect(saved(sub.cwd)).toEqual([])
    const s = setup(sb)
    const fresh = stage('OTHER_PROJECT_PLAN.md', '# Other project\n\n1. Elsewhere\n2. Not here\n', s.now - 5_000)
    const old = stage('OLD_PLAN.md', `${PLAN}\n`, s.now - STAGED_PLAN_MAX_AGE_MS - 60_000)
    const stale = stage('STALE_PLAN.md', `${PLAN}\n`, s.now - STAGED_PLAN_STALE_MS - 60_000)
    await s.fp.emit('before_agent_start', agentStart('what does this repo do?'), s.ctx)
    expect(saved(s.cwd)).toEqual([])
    expect([existsSync(fresh), existsSync(old), existsSync(stale)]).toEqual([true, true, false])
    await s.fp.emit('tool_result', proposeResult('Plan approved. Implementing now with gpt-5.5.'), s.ctx)
    expect(saved(s.cwd).map(f => f.replace(/^\d{4}-\d{2}-\d{2}-/, ''))).toEqual(['other-project.md'])
    expect([existsSync(fresh), existsSync(old)]).toEqual([false, true])
  }))

  test('with the user\'s own plan.autosave, the approving tool result saves omp\'s recent copy from the user\'s folder once and leaves the folder alone', () => withSandbox(async sb => {
    const s = setup(sb)
    const mine = join(sb.root, 'my-plans')
    mkdirSync(paths.ompAgentDir(), { recursive: true })
    writeFileSync(join(paths.ompAgentDir(), 'config.yml'), `plan:\n  autosave: true\n  autosaveDir: ${mine}\n`)
    const copy = stage('ADD_A_CACHE_PLAN.md', `${PLAN}\n`, s.now - 5_000, mine)
    const older = stage('LAST_WEEK_PLAN.md', '# Last week\n\n1. Old\n2. Done\n', s.now - USER_PLAN_MAX_AGE_MS - 60_000, mine)
    await s.fp.emit('before_agent_start', agentStart('what does this repo do?'), s.ctx)
    await s.fp.emit('tool_result', proposeResult('Plan refinement requested. Update the plan file, then write Add a cache to xd://propose again when ready.'), s.ctx)
    expect(saved(s.cwd)).toEqual([])
    const r = await s.fp.emit('tool_result', proposeResult('Plan approved at local://CACHE_PLAN.md. Plan mode exited; proceed with the implementation.'), s.ctx) as { additionalContext?: string } | undefined
    const files = saved(s.cwd)
    expect(files.map(f => f.replace(/^\d{4}-\d{2}-\d{2}-/, ''))).toEqual(['add-a-cache.md'])
    expect(readFileSync(join(s.cwd, 'docs', 'plans', files[0] as string), 'utf8')).toContain('> 2. Test it')
    expect(r?.additionalContext).toContain('(H12)')
    expect([existsSync(copy), existsSync(older)]).toEqual([true, true])
    await s.fp.emit('tool_result', proposeResult('Plan approved. Implementing now with gpt-5.5.'), s.ctx)
    expect(saved(s.cwd)).toEqual(files)
  }))

  test('omp\'s default autosave folder is <cwd>/.omp/plans; a plan the execution prompt already saved is not saved again from it', () => withSandbox(async sb => {
    const s = setup(sb)
    mkdirSync(paths.ompAgentDir(), { recursive: true })
    writeFileSync(join(paths.ompAgentDir(), 'config.yml'), 'plan:\n  autosave: true\n')
    stage('ADD_A_CACHE_PLAN.md', `${PLAN}\n`, s.now - 5_000, join(s.cwd, '.omp', 'plans'))
    await s.fp.emit('before_agent_start', agentStart(approvalPrompt(PLAN)), s.ctx)
    expect(saved(s.cwd).length).toBe(1)
    await s.fp.emit('tool_result', proposeResult('Plan approved. Implementing now with gpt-5.5.'), s.ctx)
    expect(saved(s.cwd).length).toBe(1)
  }))

  test('the plan file is found the way omp resolves it: local:// under <artifacts>/local (decoded), a plain path against the cwd; nothing it cannot place', () => {
    const art = '/s/2026/abc'
    const at = (planFilePath: unknown, dir: string | null | undefined = art) => planFileOf({ xdev: { tool: 'propose', inner: { planFilePath } } }, dir, '/work/app')
    expect(planFileOf({ planFilePath: 'local://CACHE_PLAN.md' }, art, '/work/app')).toBe(join(art, 'local', 'CACHE_PLAN.md'))
    expect(at('local://CACHE_PLAN.md')).toBe(join(art, 'local', 'CACHE_PLAN.md'))
    expect(at('local://plans/My%20Plan.md')).toBe(join(art, 'local', 'plans', 'My Plan.md'))
    expect(at('local://CACHE_PLAN.md', null)).toBeUndefined()
    expect(at('local://../escape.md')).toBeUndefined()
    expect(at('local://%E0%A4%A.md')).toBeUndefined()
    expect(at('local://')).toBeUndefined()
    expect(at('xd://propose')).toBeUndefined()
    expect(at('/abs/PLAN.md')).toBe('/abs/PLAN.md')
    expect(at('notes/PLAN.md')).toBe(join('/work/app', 'notes', 'PLAN.md'))
    expect(at(42)).toBeUndefined()
    expect(planFileOf(undefined, art, '/work/app')).toBeUndefined()
  })

  test('the autosave folder is found the way omp finds it: ~, absolute and cwd-relative paths, the project default (also for YAML null); none while autosave is off', () => {
    const cwd = '/work/app'
    const home = '/home/me'
    expect(ompAutosaveDir('plan:\n  autosave: true\n', cwd, home)).toBe(join(cwd, '.omp', 'plans'))
    expect(ompAutosaveDir('plan:\n  autosave: true\n  autosaveDir: "  "\n', cwd, home)).toBe(join(cwd, '.omp', 'plans'))
    expect(ompAutosaveDir('plan:\n  autosave: true\n  autosaveDir: ~/plans\n', cwd, home)).toBe(join(home, 'plans'))
    expect(ompAutosaveDir('plan:\n  autosave: true\n  autosaveDir: "~"\n', cwd, home)).toBe(home)
    expect(ompAutosaveDir('plan:\n  autosave: true\n  autosaveDir: ~\n', cwd, home)).toBe(join(cwd, '.omp', 'plans'))
    expect(ompAutosaveDir('plan:\n  autosave: true\n  autosaveDir: /srv/plans/../plans\n', cwd, home)).toBe('/srv/plans')
    expect(ompAutosaveDir('plan:\n  autosave: true\n  autosaveDir: notes/plans\n', cwd, home)).toBe(join(cwd, 'notes', 'plans'))
    expect(ompAutosaveDir('plan:\n  autosave: false\n  autosaveDir: /srv/plans\n', cwd, home)).toBeUndefined()
    expect(ompAutosaveDir('plan:\n  autosaveDir: /srv/plans\n', cwd, home)).toBeUndefined()
    expect(ompAutosaveDir('plan: [', cwd, home)).toBeUndefined()
    expect(ompAutosaveDir(undefined, cwd, home)).toBeUndefined()
  })

  test('the host text is matched exactly: omp\'s own execution prompt and its approving tool results', () => {
    expect(approvedPlanOf(approvalPrompt(PLAN))).toBe(PLAN)
    expect(approvedPlanOf(approvalPrompt(PLAN, true))).toBe(PLAN)
    expect(approvedPlanOf(approvalPrompt('Use `</plan>` tags\n</plan>\nmore'))).toBe('Use `</plan>` tags\n</plan>\nmore')
    expect(approvedPlanOf('Please review: Plan approved.\n<plan path="x">\nA\n</plan>')).toBeUndefined()
    expect(approvedPlanOf('Plan approved.\nno plan block')).toBeUndefined()
    expect(approvingResult(proposeResult('Plan approved at local://CACHE_PLAN.md. Plan mode exited; proceed with the implementation.'))).toBe(true)
    expect(approvingResult(proposeResult('Plan approved. Implementing now with x.', false))).toBe(false)
    expect(approvingResult({ ...proposeResult('Plan approved.'), isError: true })).toBe(false)
    expect(approvingResult({ ...proposeResult('Plan approved. Implementing now with x.'), details: { planFilePath: 'local://CACHE_PLAN.md', title: 'Add a cache', planExists: true } })).toBe(true)
    expect(approvingResult({ ...proposeResult('Plan approved. Implementing now with x.'), details: { xdev: { tool: 'other', inner: { planExists: true } } } })).toBe(false)
  })
})
