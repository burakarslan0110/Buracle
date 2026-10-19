import { describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { runPlan } from '../../src/cli/commands/plan'
import { looksLikePlan, parsePlan, planTitleOf, validatePlan } from '../../src/core/index'
import { userConfigFile } from '../../src/engine/paths'
import { capturePlanFile, shownPath } from '../../src/workflow/plan-capture'
import { localDate } from '../../src/workflow/plan-file'
import { captureSessionPlan } from '../../src/workflow/plan-native'
import { loadState } from '../../src/workflow/session-store'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { ctxAt, makeRepo, memIO, NATIVE_PLAN_BODY, prepareNativePlan, write } from './fixture'

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0)
const DAY = localDate(NOW)
const PLAN = '# Add a cache\n\n## Steps\n1. Cache the index\n2. Test it\n'

function withStdin(io: ReturnType<typeof memIO>, text: string): ReturnType<typeof memIO> {
  return { ...io, stdin: { isTTY: false, text: async () => text } }
}

describe('the shared plan writer (H12)', () => {
  test('saves at the checkout root as a valid SAVED Plan that names the harness, quoting the text', () => withSandbox(async ({ root }) => {
    const repo = await makeRepo(root)
    const r = await capturePlanFile({ plan: PLAN, cwd: join(repo, 'src'), now: NOW, harness: 'codex' })
    expect(r?.path).toBe(join(repo, 'docs', 'plans', `${DAY}-add-a-cache.md`))
    const text = readFileSync(r?.path as string, 'utf8')
    expect(validatePlan(text).filter(f => f.level === 'error')).toEqual([])
    expect(parsePlan(text).header).toMatchObject({ status: 'SAVED', approved: true, type: 'Plan', created: DAY })
    expect(parsePlan(text).title).toBe('Add a cache')
    expect(text).toContain('\nharness: codex\n')
    expect(text).toContain('Approved in Codex plan mode and saved by Buracle (H12)')
    expect(text).toContain('> 1. Cache the index')
    expect(parsePlan(text).tasks).toEqual([])
  }))

  test('never overwrites: a taken name gets -2, -3, and the earlier file keeps its bytes', () => withSandbox(async ({ root }) => {
    const repo = await makeRepo(root)
    const first = join(repo, 'docs', 'plans', `${DAY}-add-a-cache.md`)
    write(first, 'mine\n')
    const a = await capturePlanFile({ plan: PLAN, cwd: repo, now: NOW, harness: 'omp' })
    const b = await capturePlanFile({ plan: PLAN, cwd: repo, now: NOW, harness: 'omp' })
    expect([a?.slug, b?.slug]).toEqual(['add-a-cache-2', 'add-a-cache-3'])
    expect(readFileSync(first, 'utf8')).toBe('mine\n')
    expect(readdirSync(join(repo, 'docs', 'plans')).sort()).toEqual([`${DAY}-add-a-cache-2.md`, `${DAY}-add-a-cache-3.md`, `${DAY}-add-a-cache.md`])
  }))

  test('a draft is SAVED with approved false and says why; an empty plan writes nothing', () => withSandbox(async ({ root }) => {
    const r = await capturePlanFile({ plan: PLAN, cwd: root, now: NOW, harness: 'opencode', approved: false })
    const text = readFileSync(r?.path as string, 'utf8')
    expect(parsePlan(text).header).toMatchObject({ status: 'SAVED', approved: false, type: 'Plan' })
    expect(validatePlan(text).filter(f => f.level === 'error')).toEqual([])
    expect(text).toContain('OpenCode has no approval step, so this plan is not marked approved')
    expect(await capturePlanFile({ plan: '  \n', cwd: root, now: NOW, harness: 'opencode' })).toBeUndefined()
  }))

  test('the title is the first heading, else the first line without list marks; a plan has structure', () => {
    expect(planTitleOf('Intro line\n\n## Ship **v2**\n- a')).toBe('Ship v2')
    expect(planTitleOf('1. First step\n2. Second')).toBe('First step')
    expect(planTitleOf('   ')).toBe('Plan')
    expect(looksLikePlan(PLAN.repeat(2))).toBe(true)
    expect(looksLikePlan('Which file should I change? Tell me and I will plan it out in detail for you here.')).toBe(false)
    expect(looksLikePlan('# T\n- a')).toBe(false)
  })
})

describe('a plan path shown to the agent', () => {
  // The alias stands in for Windows' 8.3 spelling of the cwd next to git's long one.
  test('is relative to the cwd with / between the parts; on Windows also when the cwd is spelled another way', () => withSandbox(async ({ root }) => {
    const repo = join(root, 'repo')
    mkdirSync(join(repo, 'docs', 'plans'), { recursive: true })
    const plan = join(repo, 'docs', 'plans', 'p.md')
    expect(shownPath(plan, repo)).toBe('docs/plans/p.md')
    expect(shownPath(join(root, 'elsewhere.md'), repo)).toBe(join(root, 'elsewhere.md'))
    const alias = join(root, 'alias')
    symlinkSync(repo, alias)
    if (process.platform !== 'win32') expect(shownPath(plan, alias)).toBe(plan)
    await withEnv({ BURACLE_PLATFORM: 'win32' }, () => { expect(shownPath(plan, alias)).toBe('docs/plans/p.md') })
  }))
})

describe('buracle plan capture', () => {
  test('reads stdin, prints {path}, names the harness from --harness; --draft keeps approved false', () => withSandbox(async ({ root }) => {
    const repo = await makeRepo(root)
    const io = withStdin(memIO(true), PLAN)
    expect(await runPlan(['capture', '--harness', 'codex'], io, ctxAt(repo))).toBe(0)
    const out = io.json<{ path: string, approved: boolean, harness: string, title: string }>()
    expect(out).toMatchObject({ approved: true, harness: 'codex', title: 'Add a cache' })
    expect(readFileSync(out.path, 'utf8')).toContain('harness: codex')
    const draft = withStdin(memIO(true), PLAN)
    expect(await runPlan(['capture', '--harness', 'opencode', '--draft', '--title', 'Cache plan'], draft, ctxAt(repo))).toBe(0)
    expect(draft.json<{ path: string }>().path).toBe(join(repo, 'docs', 'plans', `${DAY}-cache-plan.md`))
    expect(parsePlan(readFileSync(draft.json<{ path: string }>().path, 'utf8')).header.approved).toBe(false)
  }))

  test('a hand-saved plan says it was saved with the command, never that a plan mode approved it or that the harness has no approval step', () => withSandbox(async ({ root }) => {
    const repo = await makeRepo(root)
    const text = async (args: string[]): Promise<string> => {
      const io = withStdin(memIO(true), PLAN)
      expect(await runPlan(['capture', ...args], io, ctxAt(repo))).toBe(0)
      return readFileSync(io.json<{ path: string }>().path, 'utf8')
    }
    const manual = await text(['--harness', 'codex'])
    expect(manual).toContain('Saved with `buracle plan capture` (Codex); the plan text is quoted under Captured Plan.')
    expect(manual).not.toContain('plan mode')
    const draft = await text(['--harness', 'codex', '--draft'])
    expect(draft).toContain('Saved with `buracle plan capture` (Codex) as a draft, not marked approved;')
    expect(draft).not.toContain('has no approval step')
    expect(draft).not.toContain('plan agent')
    expect(validatePlan(draft).filter(f => f.level === 'error')).toEqual([])
  }))

  test('--file reads a file; the session gives the harness; usage errors exit 1', () => withSandbox(async ({ root }) => {
    const repo = await makeRepo(root)
    writeFileSync(join(root, 'plan.md'), PLAN)
    const io = memIO(true)
    expect(await runPlan(['capture', '--file', join(root, 'plan.md'), '--session', 'sess-1', '--harness', 'omp'], io, ctxAt(repo))).toBe(0)
    expect(io.json<{ harness: string }>().harness).toBe('omp')
    const env = ctxAt(repo, NOW, { BURACLE_SESSION_ID: 'sess-2', BURACLE_HARNESS: 'claude' })
    const fromEnv = withStdin(memIO(true), PLAN)
    expect(await runPlan(['capture'], fromEnv, env)).toBe(0)
    expect(fromEnv.json<{ harness: string }>().harness).toBe('claude')
    expect(await runPlan(['capture'], withStdin(memIO(true), PLAN), ctxAt(repo))).toBe(1)
    expect(await runPlan(['capture', '--harness', 'vim'], withStdin(memIO(true), PLAN), ctxAt(repo))).toBe(1)
    expect(await runPlan(['capture', '--harness', 'codex'], withStdin(memIO(true), ''), ctxAt(repo))).toBe(1)
    expect(await runPlan(['capture', '--harness', 'codex', 'extra'], withStdin(memIO(true), PLAN), ctxAt(repo))).toBe(1)
    expect(await runPlan(['capture', '--harness', 'codex', '--file', join(root, 'missing.md')], memIO(true), ctxAt(repo))).toBe(1)
  }))
})

describe('native plan mode (plan.nativePlanMode): H12 fills the registered plan', () => {
  const SID = 'native-1'
  const session = ['--session', SID, '--harness', 'claude']
  const capture = (cwd: string, plan = NATIVE_PLAN_BODY, approved = true) => captureSessionPlan({ plan, cwd, now: NOW + 60_000, harness: 'claude', approved, sid: SID })

  test('the approved text replaces the body under the registered frontmatter, marked approved; the binding is used once, so the next plan is saved as usual', () => withSandbox(async ({ root }) => {
    const repo = await makeRepo(root)
    const path = await prepareNativePlan(repo, 'claude', SID)
    expect(loadState('claude', SID).native?.path).toBe(path)
    const status = memIO(true)
    expect(await runPlan(['status', ...session], status, ctxAt(repo))).toBe(0)
    expect(status.json<{ native?: { path: string } }>().native?.path).toBe(path)
    const before = readFileSync(path, 'utf8')
    const r = await capture(repo, `Here is the plan.\n\n${NATIVE_PLAN_BODY}`)
    expect(r).toMatchObject({ path, native: 'filled' })
    expect(r?.note).toContain(`the registered plan ${relative(repo, path).split(sep).join('/')} (H12, plan.nativePlanMode)`)
    expect(r?.note).toContain('marked approved')
    const text = readFileSync(path, 'utf8')
    expect(text.split('\n# ')[0]).toBe(before.split('\n# ')[0]?.replace('approved: false', 'approved: true'))
    expect(parsePlan(text).header).toMatchObject({ status: 'PENDING', approved: true, type: 'Feature', created: DAY })
    expect(parsePlan(text).title).toBe('Add a cache')
    expect(text).not.toContain('Here is the plan.')
    expect(validatePlan(text).filter(f => f.level === 'error')).toEqual([])
    const st = loadState('claude', SID)
    expect([st.native, st.approvals?.planApprovedAt, st.plan?.path]).toEqual([undefined, NOW + 60_000, path])
    const again = await capture(repo, PLAN)
    expect(again?.native).toBeUndefined()
    expect(again?.path).toBe(join(repo, 'docs', 'plans', `${DAY}-add-a-cache-2.md`))
  }))

  test('OpenCode\'s draft fills the plan without approving it; the note asks for the approval gate', () => withSandbox(async ({ root }) => {
    const repo = await makeRepo(root)
    const path = await prepareNativePlan(repo, 'opencode', 'ses_native1')
    const r = await captureSessionPlan({ plan: NATIVE_PLAN_BODY, cwd: repo, now: NOW, harness: 'opencode', approved: false, sid: 'ses_native1' })
    expect(r?.native).toBe('filled')
    expect(r?.note).toContain('OpenCode has no approval step, so it is not approved yet')
    expect(parsePlan(readFileSync(path, 'utf8')).header.approved).toBe(false)
    expect(loadState('opencode', 'ses_native1').approvals?.planApprovedAt).toBeUndefined()
  }))

  test('a registered file that changed after the preparation is left as it is, and the plan is saved beside it with a note to merge', () => withSandbox(async ({ root }) => {
    const repo = await makeRepo(root)
    const path = await prepareNativePlan(repo, 'claude', SID)
    writeFileSync(path, `${readFileSync(path, 'utf8')}\nmy own edit\n`)
    const mine = readFileSync(path, 'utf8')
    const r = await capture(repo)
    expect(r?.native).toBe('conflict')
    expect(r?.path).toBe(join(repo, 'docs', 'plans', `${DAY}-add-a-cache-2.md`))
    expect(r?.note).toContain('changed after `buracle plan prepare-native`')
    expect(readFileSync(path, 'utf8')).toBe(mine)
    expect(parsePlan(readFileSync(r?.path as string, 'utf8')).header.status).toBe('SAVED')
    expect(loadState('claude', SID).native).toBeUndefined()
  }))

  test('the on-approval steps after a plan approved in plan mode still warn about a missing plan review', () => withSandbox(async ({ root }) => {
    const repo = await makeRepo(root)
    const path = await prepareNativePlan(repo, 'claude', SID)
    expect((await capture(repo))?.native).toBe('filled')
    expect(parsePlan(readFileSync(path, 'utf8')).header.approved).toBe(true)
    const approve = memIO(true)
    expect(await runPlan(['set', 'approved', 'true', ...session], approve, ctxAt(repo))).toBe(0)
    expect(approve.err()).toContain('no collected plan-build-review is recorded for this plan')
  }))

  test('a collected plan review that no longer matches the approved text is named in the note', () => withSandbox(async ({ root }) => {
    const repo = await makeRepo(root)
    await prepareNativePlan(repo, 'claude', SID)
    for (const args of [['review', 'start', '--role', 'plan'], ['review', 'done', '--role', 'plan', '--verdict', 'pass']]) expect(await runPlan([...args, ...session], memIO(true), ctxAt(repo))).toBe(0)
    expect((await capture(repo))?.note).toContain('does not match this text: run it again')
  }))

  test('prepare-native refuses with the reasons: switch off, approval off, another plan, a bugfix, an approved plan; --cancel drops the binding', () => withSandbox(async ({ root }) => {
    const repo = await makeRepo(root)
    const path = await prepareNativePlan(repo, 'claude', SID)
    const prepare = async (args: string[]): Promise<{ code: number, reasons: string[] }> => {
      const io = memIO(true)
      const code = await runPlan(['prepare-native', ...args, ...session], io, ctxAt(repo))
      return { code, reasons: (io.json<{ reasons?: string[] }>().reasons ?? []) }
    }
    write(userConfigFile(), 'version: 1\nplan:\n  nativePlanMode: "off"\n  planApproval: false\n')
    const off = await prepare([path])
    expect(off.code).toBe(2)
    expect(off.reasons.join('\n')).toContain('plan.nativePlanMode is off')
    expect(off.reasons.join('\n')).toContain('plan.planApproval is off')
    write(userConfigFile(), 'version: 1\nplan:\n  nativePlanMode: "on"\n')
    expect((await prepare([join(repo, 'docs', 'plans', 'other.md')])).reasons.join('\n')).toContain('prepare the registered plan')
    const cancel = memIO(true)
    expect(await runPlan(['prepare-native', '--cancel', ...session], cancel, ctxAt(repo))).toBe(0)
    expect(cancel.json<{ cancelled: boolean }>().cancelled).toBe(true)
    expect(loadState('claude', SID).native).toBeUndefined()
    expect(await runPlan(['prepare-native', ...session], memIO(true), ctxAt(repo))).toBe(1)
    expect(await runPlan(['prepare-native', path, '--lane', 'x', ...session], memIO(true), ctxAt(repo))).toBe(1)
    expect(await runPlan(['set', 'approved', 'true', ...session], memIO(true), ctxAt(repo))).toBe(0)
    expect((await prepare([path])).reasons.join('\n')).toContain('already approved')
    const bug = memIO(true)
    expect(await runPlan(['init', '--type', 'bugfix', '--title', 'Fix: crash', ...session], bug, ctxAt(repo))).toBe(0)
    const bugPath = bug.json<{ path: string }>().path
    expect(await runPlan(['register', bugPath, '--phase', 'plan', ...session], memIO(true), ctxAt(repo))).toBe(0)
    expect((await prepare([bugPath])).reasons.join('\n')).toContain('only a Feature plan is planned in plan mode')
  }))

  test('the binding ends with the plan: registering another plan, unregistering or approving by hand drops it, and the stop guard checks the plan again', () => withSandbox(async ({ root }) => {
    const repo = await makeRepo(root)
    const path = await prepareNativePlan(repo, 'claude', SID)
    expect(await runPlan(['set', 'approved', 'true', ...session], memIO(true), ctxAt(repo))).toBe(0)
    expect(loadState('claude', SID).native).toBeUndefined()
    expect(await runPlan(['set', 'approved', 'false', ...session], memIO(true), ctxAt(repo))).toBe(0)
    expect(await runPlan(['prepare-native', path, ...session], memIO(true), ctxAt(repo))).toBe(0)
    expect(await runPlan(['unregister', ...session], memIO(true), ctxAt(repo))).toBe(0)
    expect(loadState('claude', SID).native).toBeUndefined()
    const other = await prepareNativePlan(repo, 'claude', SID, { title: 'Second plan' })
    expect(loadState('claude', SID).native?.path).toBe(other)
    expect(await runPlan(['register', path, '--phase', 'plan', ...session], memIO(true), ctxAt(repo))).toBe(0)
    expect(loadState('claude', SID).native).toBeUndefined()
  }))
})
