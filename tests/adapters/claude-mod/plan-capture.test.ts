import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildClaude } from '../../../src/adapters/claude/build'
import { devContext } from '../../../src/adapters/claude/dev-build'
import { claudeHook, type HookDeps } from '../../../src/adapters/claude/hook'
import type { AdapterContext } from '../../../src/adapters/registry'
import type { CanonicalBundle, HookBinding } from '../../../src/core/catalog'
import { defaultConfig } from '../../../src/core/config'
import { parsePlan, planSkeleton, slugify, validatePlan } from '../../../src/core/index'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'
import { run } from '../../../src/engine/proc'
import { localDate } from '../../../src/workflow/plan-file'
import { loadState } from '../../../src/workflow/session-store'
import { withSandbox } from '../../helpers/sandbox'
import { NATIVE_PLAN_BODY, prepareNativePlan } from '../../workflow/fixture'

const REPO = paths.repoRoot()
const SID = 'sess-h12'
const NOW = Date.UTC(2026, 9, 8, 12)
const DAY = localDate(NOW)
let bundle: CanonicalBundle | undefined

function ctx(): AdapterContext {
  return {
    repoRoot: REPO,
    config: defaultConfig(),
    paths,
    buracleBin: paths.shimPath(),
    get canonical(): CanonicalBundle { return (bundle ??= loadCanonicalSync(join(REPO, 'canonical'))) },
  }
}

const deps: Partial<HookDeps> = {
  now: () => NOW,
  importModule: async () => undefined,
  branch: async () => 'main',
  project: async () => 'demo',
  sessionMaint: () => undefined,
  env: () => undefined,
  buracleRepo: async () => undefined,
  realpath: () => undefined,
  prepareWorkspace: async () => undefined,
}

const PLAN = '# Giriş sayfası ekle\n\n## Tasks\n### Task 1: form\n\n1. Formu yaz\n2. Test et\n'

async function exitPlan(cwd: string, extra: Record<string, unknown> = {}): Promise<string> {
  const payload = { session_id: SID, cwd, hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: PLAN }, tool_response: { plan: PLAN, isAgent: false }, ...extra }
  const r = await claudeHook('PostToolUse', JSON.stringify(payload), ctx(), deps)
  if (r.stdout === '') return ''
  const out = (JSON.parse(r.stdout) as Record<string, unknown>)['hookSpecificOutput'] as Record<string, unknown> | undefined
  return String(out?.['additionalContext'] ?? '')
}

async function repoWithSub(root: string): Promise<{ repo: string, sub: string }> {
  const repo = join(root, 'repo')
  const sub = join(repo, 'src', 'deep')
  mkdirSync(sub, { recursive: true })
  await run(['git', 'init', '-q', repo])
  return { repo, sub }
}

describe('H12 plan.capture', () => {
  test('the saved form is a valid Buracle plan: type Plan, status SAVED, approved', () => {
    const skeleton = planSkeleton({ type: 'Plan', title: 'Giriş sayfası ekle', created: DAY })
    const plan = parsePlan(skeleton)
    expect(plan.header).toMatchObject({ created: DAY, status: 'SAVED', approved: true, type: 'Plan' })
    expect(plan.title).toBe('Giriş sayfası ekle')
    expect(validatePlan(skeleton).filter(f => f.level === 'error')).toEqual([])
    const saved = `${skeleton.trimEnd()}\n\n## Captured Plan\n\n> ## Tasks\n> ### Task 1: not a card of this file\n`
    expect(validatePlan(saved).filter(f => f.level === 'error')).toEqual([])
    expect(parsePlan(saved).tasks).toEqual([])
    expect(slugify('Giriş sayfası ekle')).toBe('giris-sayfasi-ekle')
  })

  test('an approved main-loop exit is saved at the checkout root and the hook says where', async () => {
    await withSandbox(async ({ root }) => {
      const { repo, sub } = await repoWithSub(root)
      const said = await exitPlan(sub)
      expect(said).toContain('(H12)')
      const file = join(repo, 'docs', 'plans', `${DAY}-giris-sayfasi-ekle.md`)
      expect(said).toContain(file)
      const text = readFileSync(file, 'utf8')
      expect(validatePlan(text).filter(f => f.level === 'error')).toEqual([])
      const plan = parsePlan(text)
      expect(plan.header).toMatchObject({ status: 'SAVED', approved: true, type: 'Plan', created: DAY })
      expect(plan.title).toBe('Giriş sayfası ekle')
      expect(plan.tasks).toEqual([])
      expect(text).toContain('> 1. Formu yaz')
      await exitPlan(sub)
      expect(readdirSync(join(repo, 'docs', 'plans')).sort()).toEqual([`${DAY}-giris-sayfasi-ekle-2.md`, `${DAY}-giris-sayfasi-ekle.md`])
    })
  })

  test('the approved text wins: tool_response.plan (it carries the user\'s edits) over tool_input.plan; the header names Claude Code', async () => {
    await withSandbox(async ({ root }) => {
      const { repo } = await repoWithSub(root)
      const edited = '# Edited plan\n\n1. Changed step\n'
      expect(await exitPlan(repo, { tool_input: { plan: PLAN }, tool_response: { plan: edited, filePath: '/x/plan.md' } })).toContain(`docs/plans/${DAY}-edited-plan.md`)
      const text = readFileSync(join(repo, 'docs', 'plans', `${DAY}-edited-plan.md`), 'utf8')
      expect(text).toContain('> 1. Changed step')
      expect(text).not.toContain('Formu yaz')
      expect(text).toContain('\nharness: claude\n')
      expect(text).toContain('Approved in Claude Code plan mode and saved by Buracle (H12)')
      expect(await exitPlan(repo, { tool_response: { isAgent: false } })).toContain(`${DAY}-giris-sayfasi-ekle.md`)
    })
  })

  test('plan.nativePlanMode: the exit approves the prepared plan-build plan, filling the registered file with the approved text (the user\'s edits included) instead of saving a new one', async () => {
    await withSandbox(async ({ root }) => {
      const { repo, sub } = await repoWithSub(root)
      const path = await prepareNativePlan(repo, 'claude', SID)
      const edited = NATIVE_PLAN_BODY.replace('Clients get 429', 'Clients get a cached answer')
      const said = await exitPlan(sub, { tool_input: {}, tool_response: { plan: edited, filePath: '/home/u/.claude/plans/quiet-fox.md' } })
      expect(said).toContain('was written into the registered plan')
      expect(said).toContain('plan.nativePlanMode')
      const text = readFileSync(path, 'utf8')
      expect(parsePlan(text).header).toMatchObject({ type: 'Feature', status: 'PENDING', approved: true })
      expect(text).toContain('\nharness: claude\n')
      expect(text).toContain('Clients get a cached answer')
      expect(readdirSync(join(repo, 'docs', 'plans'))).toEqual([path.split('/').at(-1) as string])
      expect(loadState('claude', SID).approvals?.planApprovedAt).toBe(NOW)
      expect(await exitPlan(sub)).toContain('the approved plan was saved to')
    })
  })

  test('a subagent exit, one still awaiting the leader, and a failed one save nothing', async () => {
    await withSandbox(async ({ root }) => {
      const { repo } = await repoWithSub(root)
      expect(await exitPlan(repo, { agent_id: 'a1', agent_type: 'Plan' })).toBe('')
      expect(await exitPlan(repo, { tool_response: { plan: PLAN, awaitingLeaderApproval: true } })).toBe('')
      expect(await exitPlan(repo, { tool_response: { success: false, error: 'rejected' } })).toBe('')
      expect(existsSync(join(repo, 'docs', 'plans'))).toBe(false)
    })
  })

  test('H12 is the PostToolUse command hook for ExitPlanMode, in hooks.yaml and in the built plugin', async () => {
    const spec = ctx().canonical.hooks.hooks.find(h => h.id === 'H12')
    const binding = spec?.bindings.claude as HookBinding | undefined
    expect(binding).toMatchObject({ event: 'classic.PostToolUse', matcher: 'ExitPlanMode' })
    expect(spec?.failure).toBe('open')
    const files = await buildClaude(devContext(REPO))
    const hooksJson = files.find(f => f.path === 'hooks/hooks.json')
    expect(hooksJson).toBeDefined()
    const groups = ((JSON.parse(String(hooksJson?.content)) as { hooks: Record<string, { matcher?: string, hooks: { args?: string[], command?: string }[] }[]> }).hooks['PostToolUse']) ?? []
    const group = groups.find(g => g.matcher !== undefined && new RegExp(`^(?:${g.matcher})$`).test('ExitPlanMode'))
    expect(group).toBeDefined()
    const hook = group?.hooks[0]
    expect([...(hook?.args ?? []), hook?.command ?? ''].join(' ')).toContain('hook claude PostToolUse')
  })
})
