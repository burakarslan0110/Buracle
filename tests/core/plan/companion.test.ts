import { describe, expect, test } from 'bun:test'
import {
  acceptReview, chooseCompanion, claudeResultText, companionInputs, companionPrompt, companionSetting, extractReview, modelFamily, repairReview, type CompanionCandidate,
} from '../../../src/core/plan/companion'
import type { Harness } from '../../../src/core/events'

function cand(h: Harness, o: Partial<CompanionCandidate> = {}): CompanionCandidate {
  return { harness: h, enabled: true, onPath: true, recent: false, ...o }
}

const ALL = (o: Partial<Record<Harness, Partial<CompanionCandidate>>> = {}): CompanionCandidate[] => (['claude', 'codex', 'opencode', 'omp'] as const).map(h => cand(h, o[h]))

describe('chooseCompanion', () => {
  test('off picks nothing; a named harness is used when it is on PATH, even when its window is busy', () => {
    expect(chooseCompanion('off', 'claude', ALL())).toEqual({ picks: [], skipped: ['plan.reviews.companion is off'] })
    expect(chooseCompanion('omp', 'claude', ALL())).toEqual({ picks: ['omp'], skipped: [] })
    expect(chooseCompanion('codex', 'claude', ALL({ codex: { held: '5-hour window at 96% (limit 90%)' } }))).toEqual({ picks: ['codex'], skipped: ['codex: 5-hour window at 96% (limit 90%) (tried anyway: it was named)'] })
    expect(chooseCompanion('codex', 'claude', ALL({ codex: { onPath: false } }))).toEqual({ picks: [], skipped: ['codex: its command is not on PATH'] })
    expect(chooseCompanion('codex', 'claude', ALL({ codex: { enabled: false } }))).toEqual({ picks: [], skipped: ['codex is switched off (harnesses.codex.enabled: false)'] })
  })

  test('auto never picks the caller, prefers another model family, then recent use and headroom, and keeps two picks for the retry', () => {
    expect(chooseCompanion('auto', 'claude', ALL()).picks).toEqual(['codex', 'opencode'])
    expect(chooseCompanion('auto', 'codex', ALL()).picks).toEqual(['claude', 'opencode'])
    const fam = ALL({ codex: { family: 'openai' }, opencode: { family: 'anthropic', recent: true }, omp: { family: 'google' } })
    expect(chooseCompanion('auto', 'claude', fam, 'anthropic').picks).toEqual(['codex', 'omp'])
    const busy = ALL({ codex: { held: '7-day window at 99% (limit 95%)' }, opencode: { recent: true, used: 40 }, omp: { recent: true, used: 10 } })
    expect(chooseCompanion('auto', 'claude', busy)).toEqual({ picks: ['omp', 'opencode'], skipped: ['codex: 7-day window at 99% (limit 95%)'] })
    expect(chooseCompanion('auto', 'claude', ALL({ codex: { onPath: false }, opencode: { onPath: false }, omp: { enabled: false } }))).toEqual({
      picks: [], skipped: ['codex: its command is not on PATH', 'opencode: its command is not on PATH', 'omp is switched off (harnesses.omp.enabled: false)'],
    })
    expect(chooseCompanion('auto', 'claude', [cand('claude')])).toEqual({ picks: [], skipped: ['no harness other than claude is set up'] })
  })

  test('settings and model families', () => {
    expect(companionSetting(' Codex ')).toBe('codex')
    expect(companionSetting('gemini')).toBeUndefined()
    expect([modelFamily('claude-opus-5-5'), modelFamily('anthropic/claude-sonnet-4-5'), modelFamily('gpt-5.2-codex'), modelFamily('openai/o3'), modelFamily('google/gemini-3-pro'), modelFamily('qwen3'), modelFamily(undefined)])
      .toEqual(['anthropic', 'anthropic', 'openai', 'openai', 'google', undefined, undefined])
  })
})

describe('companionInputs', () => {
  test('Buracle\'s own scope lines win; the agent\'s other lines stay, multi-line values included; the closing instruction is dropped', () => {
    const raw = ['changes-review', 'plan_file: /wrong.md', 'diff_range: main...HEAD', '  continued range text', 'user_request: limit the API', 'clarifications: Q1 per IP? yes', '  Q2 headers? Retry-After', 'Return only your JSON report.'].join('\n')
    expect(companionInputs(raw, [['plan_file', '/repo/plan.md'], ['base_ref', 'abc123'], ['changed_files', 'a.ts, b.ts']])).toBe([
      'plan_file: /repo/plan.md', 'base_ref: abc123', 'changed_files: a.ts, b.ts', 'changes-review', 'user_request: limit the API', 'clarifications: Q1 per IP? yes', '  Q2 headers? Retry-After',
    ].join('\n'))
    expect(companionInputs(undefined, [['goal', 'Given x\nThen y'], ['slug', '']])).toBe('goal: Given x Then y')
  })
})

describe('companionPrompt', () => {
  const base = { role: 'changes' as const, body: '## Inputs\nYou review a finished change.', caller: 'claude' as const, repo: '/r', inputs: 'plan_file: /r/p.md' }

  test('names both harnesses, keeps the reviewer body and the inputs, and tells each target how it reads the repository', () => {
    const codex = companionPrompt({ ...base, target: 'codex', shell: true, scratch: false })
    expect(codex).toStartWith('You are a second-opinion reviewer running on Codex. A Claude Code session asked for this review; its own changes-review runs at the same time')
    expect(codex).toContain('- Do not run `buracle` commands: the review scope below is already resolved.')
    expect(codex).toContain('Your working folder is the repository.')
    expect(codex).toContain('You review a finished change.')
    expect(codex.trimEnd()).toEndWith('plan_file: /r/p.md\n\nReturn only your JSON report.')
    expect(companionPrompt({ ...base, target: 'opencode', shell: true, scratch: true })).toContain('Your working folder is an empty scratch folder; the repository is `/r`. Pass absolute paths under it to the read, grep and glob tools, and run git as `git -C "/r" ...`.')
    expect(companionPrompt({ ...base, target: 'omp', shell: false, scratch: false })).toContain('You have no shell in this run, so the diff is included below')
  })

  test('the diff is fenced with more backticks than it holds and marked when cut', () => {
    const p = companionPrompt({ ...base, target: 'omp', shell: false, scratch: false, diff: { text: '+const s = ```x```\n', truncated: true } })
    expect(p).toContain('````diff\n+const s = ```x```\n````')
    expect(p).toContain('The diff is longer than this; it is cut here.')
  })
})

describe('reading the answer', () => {
  const report = { verdict: 'pass', summary: 'docs/plans/p.md: fine.', findings: [{ severity: 'suggestion', category: 'risk', title: 'Name the cap', file: '', line: null, evidence: 'x', suggested_fix: 'y' }], goal_score: null }

  test('extractReview takes the last object with verdict and findings out of tool chatter and fences, and drops empty optional fields', () => {
    const noisy = `Read {"path":"a.ts"}\nmy draft {"verdict":"needs_changes","findings":[]}\nfinal:\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`\n`
    expect(JSON.parse(extractReview(noisy) as string)).toEqual({ verdict: 'pass', summary: 'docs/plans/p.md: fine.', findings: [{ severity: 'suggestion', category: 'risk', title: 'Name the cap', evidence: 'x', suggested_fix: 'y' }] })
    expect(extractReview('the summary says {"a": "}"} but no report')).toBeUndefined()
    expect(extractReview('')).toBeUndefined()
  })

  test('acceptReview passes a valid report as is and repairs a foreign shape into the review schema', () => {
    const ok = acceptReview(JSON.stringify({ ...report, findings: [] }), 'plan-build-review', '/repo/docs/plans/p.md')
    expect(ok).toEqual({ ok: true, report: { verdict: 'pass', summary: 'docs/plans/p.md: fine.', findings: [] }, repaired: false })
    const foreign = {
      verdict: 'reject', summary: 'Unsafe.',
      findings: [
        { severity: 'info', title: 'Style', body: 'b', recommendation: 'r' },
        { severity: 'critical', category: 'bug', title: 'Crash on empty list', body: 'src/a.ts:3 reads [0]', file: 'src/a.ts', line_start: '3', recommendation: 'Guard it.' },
      ],
      truths: [{ truth: 'Empty input works', status: 'FAILED', evidence: 'throws' }],
      next_steps: ['x'],
    }
    const fixed = acceptReview(JSON.stringify(foreign), 'changes-review', 'goal')
    expect(fixed).toEqual({
      ok: true, repaired: true,
      report: {
        verdict: 'needs_changes', summary: 'goal: Unsafe.',
        findings: [
          { severity: 'must_fix', category: 'correctness', title: 'Crash on empty list', evidence: 'src/a.ts:3 reads [0]', suggested_fix: 'Guard it.', file: 'src/a.ts', line: 3 },
          { severity: 'suggestion', category: 'correctness', title: 'Style', evidence: 'b', suggested_fix: 'r' },
        ],
        truths: [{ truth: 'Empty input works', status: 'failed', evidence: 'throws' }],
      },
    })
    expect(acceptReview('no json here', 'changes-review', 'goal')).toEqual({ ok: false, errors: ['the answer holds no JSON report (an object with verdict and findings)'] })
  })

  test('repairReview backs a failed truth with a must_fix finding and caps the findings', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ severity: 'suggestion', category: 'maintainability', title: `t${i}`, evidence: 'e', suggested_fix: 'f' }))
    const r = repairReview({ verdict: 'pass', summary: 's', findings: many, truths: [{ truth: 'Totals add tax once', status: 'failed', evidence: 'adds twice' }] }, 'changes-review')
    const findings = r['findings'] as Array<Record<string, unknown>>
    expect(findings).toHaveLength(15)
    expect(findings[0]).toEqual({ severity: 'must_fix', category: 'goal_gap', title: 'Failed truth: Totals add tax once', evidence: 'adds twice', suggested_fix: 'Make this truth hold, then re-run the checks that cover it.' })
    expect(r['verdict']).toBe('needs_changes')
  })

  test('claudeResultText reads print mode JSON output', () => {
    expect(claudeResultText('{"type":"result","is_error":false,"result":"hi"}')).toEqual({ ok: true, text: 'hi' })
    expect(claudeResultText('{"type":"result","is_error":true,"result":"Credit balance is too low"}')).toEqual({ ok: false, text: 'Credit balance is too low' })
    expect(claudeResultText('not json')).toBeUndefined()
  })
})
