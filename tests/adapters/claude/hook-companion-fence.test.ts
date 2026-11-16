import { describe, expect, test } from 'bun:test'
import { claudeHook, defaultHookDeps } from '../../../src/adapters/claude/hook'
import type { AdapterContext } from '../../../src/adapters/registry'
import { FENCE_FAILED } from '../../../src/adapters/shared/pipeline/index'
import { hookBundle } from '../../../src/cli/hook-data'
import type { CanonicalBundle } from '../../../src/core/catalog'
import { defaultConfig } from '../../../src/core/config'
import * as paths from '../../../src/engine/paths'
import { withEnv, withSandbox } from '../../helpers/sandbox'

function ctx(): AdapterContext {
  const routing = hookBundle(paths.repoRoot(), () => { throw new Error('the classic hooks must not load the canonical bundle') }).routing
  return { repoRoot: paths.repoRoot(), config: defaultConfig(), paths, buracleBin: paths.shimPath(), get canonical(): CanonicalBundle { return { routing } as CanonicalBundle } }
}

function payload(tool: string, input: Record<string, unknown>): string {
  return JSON.stringify({ session_id: 'sess-fence-1', cwd: '/tmp/project', hook_event_name: 'PreToolUse', permission_mode: 'dontAsk', tool_name: tool, tool_input: input, tool_use_id: 'toolu_01' })
}

async function decide(tool: string, input: Record<string, unknown>): Promise<{ decision?: string, reason: string }> {
  const r = await claudeHook('PreToolUse', payload(tool, input), ctx(), { ...defaultHookDeps, now: () => 1_800_000_000_000 })
  if (r.stdout === '') return { reason: '' }
  const hso = (JSON.parse(r.stdout) as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput ?? {}
  return { ...(typeof hso['permissionDecision'] === 'string' ? { decision: hso['permissionDecision'] } : {}), reason: String(hso['permissionDecisionReason'] ?? '') }
}

const FENCE = 'this run is a read-only second opinion (changes-review)'

describe('PreToolUse: the second-opinion fence holds when settings allow rules widen dontAsk', () => {
  test('with BURACLE_REVIEWER_AGENT set, a shell write, an edit tool and a memory write are denied; git diff and the codegraph tools pass', () => withSandbox(() => withEnv({ BURACLE_REVIEWER_AGENT: 'changes-review' }, async () => {
    for (const command of ['touch pwned.txt', 'git commit -am x', 'git diff > out.patch']) expect({ command, ...(await decide('Bash', { command })) }).toEqual({ command, decision: 'deny', reason: expect.stringContaining(FENCE) })
    expect(await decide('Write', { file_path: '/tmp/project/a.ts', content: 'x' })).toEqual({ decision: 'deny', reason: expect.stringContaining('`Write` changes files') })
    expect(await decide('mcp__plugin_buracle_buracle-memory__memory_write', { type: 'gotcha', title: 't', summary: 's', body: 'b' })).toEqual({ decision: 'deny', reason: expect.stringContaining('is not a codegraph, semble or context7 tool') })
    for (const [tool, input] of [['Bash', { command: 'git diff HEAD~1' }], ['mcp__plugin_buracle_codegraph__codegraph_explore', { query: 'x', projectPath: '/tmp/project' }]] as const) {
      const d = await decide(tool, input)
      expect({ tool, fenced: d.reason.includes('second opinion') }).toEqual({ tool, fenced: false })
    }
  })))

  test('a fence denial has the one shape of every denial: `Buracle Stack H01: …`, never a bare `Buracle Stack: …`', () => withSandbox(() => withEnv({ BURACLE_REVIEWER_AGENT: 'changes-review' }, async () => {
    const calls: Array<[string, Record<string, unknown>]> = [['Bash', { command: 'touch pwned.txt' }], ['Write', { file_path: '/tmp/project/a.ts', content: 'x' }], ['mcp__other__save', {}]]
    for (const [tool, input] of calls) {
      const d = await decide(tool, input)
      expect({ tool, decision: d.decision, reason: d.reason }).toEqual({ tool, decision: 'deny', reason: expect.stringMatching(/^Buracle Stack H01: this run is a read-only second opinion \(changes-review\) and /) })
      expect(d.reason).not.toContain('Buracle Stack: ')
    }
    expect(FENCE_FAILED).toBe('Buracle Stack H01: the read-only check of this second-opinion review failed, so the call was blocked.')
  })))

  test('without the marker (or with a name that is not a review agent) the fence stays out of the way', () => withSandbox(async () => {
    expect((await decide('Bash', { command: 'touch pwned.txt' })).reason).not.toContain('second opinion')
    await withEnv({ BURACLE_REVIEWER_AGENT: 'general-purpose' }, async () => {
      expect((await decide('Bash', { command: 'touch pwned.txt' })).reason).not.toContain('second opinion')
    })
  }))
})
