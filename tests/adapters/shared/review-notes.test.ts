import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { claudeHook, type HookDeps } from '../../../src/adapters/claude/hook'
import { handleCodexHook } from '../../../src/adapters/codex/hook'
import type { AdapterContext } from '../../../src/adapters/registry'
import { reviewNotesNotice } from '../../../src/adapters/shared/review-notes'
import type { CanonicalBundle } from '../../../src/core/catalog'
import { defaultConfig } from '../../../src/core/config'
import type { NotesInboxEntry } from '../../../src/core/plan/notes'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'
import { freshState, saveState } from '../../../src/workflow/session-store'
import { withSandbox } from '../../helpers/sandbox'
import { ctx as codexCtx, deps as codexDeps, payload as codexPayload, SID as CODEX_SID } from '../codex/hook-helpers'

const NOW = 1_800_000_000_000
const REPO = join(import.meta.dir, '..', '..', '..')
let bundle: CanonicalBundle | undefined

function inbox(entries: NotesInboxEntry[]): void {
  mkdirSync(dirname(paths.reviewInboxFile()), { recursive: true })
  writeFileSync(paths.reviewInboxFile(), JSON.stringify({ v: 1, entries }))
}

function bind(h: 'claude' | 'codex' | 'omp' | 'opencode', sid: string, plan: string): void {
  saveState(h, sid, { ...freshState(), plan: { path: plan, slug: 'p', status: 'PENDING', type: 'Feature', phase: 'plan', registeredAt: NOW } })
}

const PLAN = '/work/app/docs/plans/p.md'
const entry: NotesInboxEntry = { at: NOW - 5000, root: '/work/app', key: 'app-1/plans--p.md', open: 2, doc: PLAN, rel: 'docs/plans/p.md' }

describe('the notice about new notes from the review page', () => {
  test('a session hears once about notes on its plan, and again only after the user writes more', async () => {
    await withSandbox(async () => {
      inbox([entry])
      const first = reviewNotesNotice('claude', 's-notes-1', { plan: PLAN, roots: ['/work/app'], now: NOW })
      expect(first).toContain('the user left 2 open notes in the review page on docs/plans/p.md')
      expect(first).toContain('`buracle plan notes --json`')
      expect(reviewNotesNotice('claude', 's-notes-1', { plan: PLAN, roots: ['/work/app'], now: NOW })).toBeUndefined()
      expect(reviewNotesNotice('claude', 's-notes-2', { plan: '/work/app/docs/plans/other.md', roots: ['/work/app'], now: NOW })).toBeUndefined()
      inbox([{ ...entry, at: NOW, open: 3 }])
      expect(reviewNotesNotice('claude', 's-notes-1', { plan: PLAN, roots: [], now: NOW })).toContain('3 open notes')
      expect(reviewNotesNotice('claude', '../bad', { plan: PLAN, roots: [], now: NOW })).toBeUndefined()
    })
  })

  test('Claude Code: the prompt hook adds the notice to the prompt context', async () => {
    await withSandbox(async () => {
      const sid = 'sess-review-notes-1'
      bind('claude', sid, PLAN)
      inbox([entry])
      const ctx: AdapterContext = { repoRoot: REPO, config: defaultConfig(), paths, buracleBin: paths.shimPath(), get canonical(): CanonicalBundle { return (bundle ??= loadCanonicalSync(join(REPO, 'canonical'))) } }
      const deps: Partial<HookDeps> = {
        now: () => NOW, importModule: async () => undefined, branch: async () => 'main', project: async () => 'demo', sessionMaint: () => undefined, env: () => undefined,
        buracleRepo: async () => undefined, realpath: () => undefined, run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }), prepareWorkspace: async () => undefined,
        cmForward: async () => ({ action: 'none', skipped: 'test' }),
      }
      const prompt = () => JSON.stringify({ session_id: sid, cwd: '/work/app', hook_event_name: 'UserPromptSubmit', transcript_path: '/tmp/t.jsonl', permission_mode: 'bypassPermissions', prompt: 'I left notes on the plan' })
      const context = (stdout: string) => (stdout === '' ? '' : String((JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? ''))
      expect(context((await claudeHook('UserPromptSubmit', prompt(), ctx, deps)).stdout)).toContain('open notes in the review page on docs/plans/p.md')
      expect(context((await claudeHook('UserPromptSubmit', prompt(), ctx, deps)).stdout)).not.toContain('review page')
    })
  })

  test('Codex: the prompt hook adds the notice to the prompt context', async () => {
    await withSandbox(async () => {
      bind('codex', CODEX_SID, PLAN)
      inbox([entry])
      const additional = (stdout: string): string => (stdout === '' ? '' : String(JSON.parse(stdout).hookSpecificOutput?.additionalContext ?? ''))
      const r = await handleCodexHook('UserPromptSubmit', codexPayload('UserPromptSubmit', { prompt: 'see my notes' }), codexCtx(), codexDeps())
      expect(additional(r.stdout)).toContain('open notes in the review page on docs/plans/p.md')
    })
  })
})
