import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeHook, defaultHookDeps } from '../../../src/adapters/claude/hook'
import type { AdapterContext } from '../../../src/adapters/registry'
import { defaultConfig } from '../../../src/core/config'
import type { CanonicalBundle } from '../../../src/core/catalog'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'
import { freshState, saveState } from '../../../src/workflow/session-store'
import { withSandbox } from '../../helpers/sandbox'

const FIX = join(import.meta.dir, 'fixtures', 'hooks')
const SID = 'sess-hook-1'
const NOW = 1_800_000_000_000
const QUIET = { stdout: '', exitCode: 0 }
const REPO = join(import.meta.dir, '..', '..', '..')
let base: CanonicalBundle | undefined

function fixture(name: string, patch: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...(JSON.parse(readFileSync(join(FIX, name), 'utf8')) as Record<string, unknown>), ...patch })
}

function ctxWith(): AdapterContext {
  return { repoRoot: REPO, config: defaultConfig(), paths, buracleBin: paths.shimPath(), canonical: base ??= loadCanonicalSync(join(REPO, 'canonical')) }
}

const json = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>

describe('H19 subject binding with the real core', () => {
  test('H19 binds the report to the bound plans: the lead\'s plan and its plan lanes pass, a report about another file goes back once', async () => {
    await withSandbox(async () => {
      const lead = '/abs/repo/docs/plans/2026-10-08-login.md'
      const lane = '/abs/repo/.worktrees/billing/docs/plans/2026-10-08-billing.md'
      saveState('claude', SID, { ...freshState(), plan: { path: lead, slug: 'login', status: 'COMPLETE', type: 'Feature', phase: 'verify', registeredAt: 1 } })
      saveState('claude', `${SID}.lane-billing`, { ...freshState(), plan: { path: lane, slug: 'billing', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: 1 } })
      const ask = (summary: string, id: string) => claudeHook('SubagentStop', fixture('subagentstop.json', { agent_id: id, last_assistant_message: JSON.stringify({ verdict: 'pass', summary, findings: [] }) }), ctxWith(), { ...defaultHookDeps, now: () => NOW })
      expect(await ask('docs/plans/2026-10-08-login.md: the plan covers the request', 'r1')).toEqual(QUIET)
      expect(await ask('docs/plans/2026-10-08-billing.md: ok', 'r2')).toEqual(QUIET)
      const other = await ask('docs/plans/2026-09-01-old.md: ok', 'r3')
      expect(String((json(other.stdout)['hookSpecificOutput'] as Record<string, unknown>)['additionalContext'])).toContain(`must start with the reviewed path (${lead} or ${lane})`)
    })
  })


  test('SubagentHandback binds the report too: the bound plan\'s spaced absolute path passes, a report about another file is denied once', async () => {
    await withSandbox(async () => {
      const lead = '/Users/me/Desktop/Buracle Plugin/buracle/docs/plans/2026-10-08-login.md'
      saveState('claude', SID, { ...freshState(), plan: { path: lead, slug: 'login', status: 'IN_PROGRESS', type: 'Feature', phase: 'plan', registeredAt: 1 } })
      const hand = (summary: string, id: string) => claudeHook('PreToolUse', fixture('pretooluse-handback.json', { agent_id: id, tool_input: { message: JSON.stringify({ verdict: 'pass', summary, findings: [] }) } }), ctxWith(), { ...defaultHookDeps, now: () => NOW })
      expect(await hand(`\`${lead}\`: the plan covers the request`, 'h1')).toEqual(QUIET)
      const other = json((await hand('docs/plans/2026-09-01-old.md: ok', 'h2')).stdout)['hookSpecificOutput'] as Record<string, unknown>
      expect(other['permissionDecision']).toBe('deny')
      expect(String(other['permissionDecisionReason'])).toContain(`must start with the reviewed path (${lead})`)
    })
  })
})
