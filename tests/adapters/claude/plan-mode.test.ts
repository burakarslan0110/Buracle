import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { claudeHook, type HookDeps } from '../../../src/adapters/claude/hook'
import type { AdapterContext } from '../../../src/adapters/registry'
import { defaultConfig } from '../../../src/core/config'
import type { CanonicalBundle } from '../../../src/core/catalog'
import * as paths from '../../../src/engine/paths'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import { freshState, loadState, saveState } from '../../../src/workflow/session-store'
import { withSandbox } from '../../helpers/sandbox'

const SID = 'sess-plan-mode-1'
const NOW = 1_800_000_000_000
const REPO = join(import.meta.dir, '..', '..', '..')
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

function deps(): Partial<HookDeps> {
  return {
    now: () => NOW,
    importModule: async () => undefined,
    branch: async () => 'main',
    project: async () => 'demo',
    sessionMaint: () => undefined,
    env: () => undefined,
    buracleRepo: async () => undefined,
    realpath: () => undefined,
    run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    prepareWorkspace: async () => undefined,
    cmForward: async () => ({ action: 'none', skipped: 'test' }),
  }
}

function payload(event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: SID, cwd: '/tmp/project', hook_event_name: event, transcript_path: '/tmp/t.jsonl', permission_mode: 'bypassPermissions', ...extra })
}

function context(stdout: string): string {
  if (stdout === '') return ''
  return String(((JSON.parse(stdout) as Record<string, unknown>)['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['additionalContext'] ?? '')
}

describe('UserPromptSubmit: a workflow started in plan mode', () => {
  test('a file-writing workflow started in plan mode is told to have the user leave it first', async () => {
    await withSandbox(async () => {
      const inPlan = await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: '/buracle:plan-build add rate limits', permission_mode: 'plan' }), ctx(), deps())
      expect(context(inPlan.stdout)).toContain("plan-build was started while the session is in Claude Code's plan mode")
      const normal = await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: '/buracle:plan-build add rate limits' }), ctx(), deps())
      expect(context(normal.stdout)).not.toContain('plan mode')
      const research = await claudeHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'what is a token bucket?', permission_mode: 'plan' }), ctx(), deps())
      expect(context(research.stdout)).not.toContain('was started while')
    })
  })
})

describe('PreToolUse: an edit before the plan is approved', () => {
  test('the first edit of another file gets one note per plan; the plan file and approved plans get none', async () => {
    await withSandbox(async () => {
      const draft = { path: '/tmp/project/docs/plans/p.md', slug: 'p', status: 'PENDING' as const, type: 'Feature' as const, phase: 'plan' as const, registeredAt: NOW - 1000 }
      saveState('claude', SID, { ...freshState(), plan: draft })
      const edit = (file: string) => payload('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } })
      expect(context((await claudeHook('PreToolUse', edit('/tmp/project/docs/plans/p.md'), ctx(), deps())).stdout)).not.toContain('plan phase')
      const first = context((await claudeHook('PreToolUse', edit('/tmp/project/src/app.ts'), ctx(), deps())).stdout)
      expect(first).toContain('this edit changes /tmp/project/src/app.ts while the plan /tmp/project/docs/plans/p.md is still in its plan phase')
      expect(loadState('claude', SID).guard.earlyEditNoted).toBe(true)
      expect(context((await claudeHook('PreToolUse', edit('/tmp/project/src/other.ts'), ctx(), deps())).stdout)).not.toContain('plan phase')
      saveState('claude', SID, { ...freshState(), plan: { ...draft, status: 'APPROVED' } })
      expect(context((await claudeHook('PreToolUse', edit('/tmp/project/src/app.ts'), ctx(), deps())).stdout)).not.toContain('plan phase')
    })
  })
})
