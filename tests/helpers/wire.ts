import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { run, type RunResult } from '../../src/engine/proc'
import { bunPath, shimPlanOps } from '../../src/engine/update/install-core'

// Helpers of the tests that run the command lines the generators write into the harness configs
// (tests/adapters/hook-wire.test.ts, tests/adapters/mcp-wire.test.ts).

export const REPO = join(import.meta.dir, '..', '..')
export const CLAUDE_PLUGIN = join(REPO, 'harness', 'claude')

/** Writes the shim `buracle install` writes (checkout mode: it runs this checkout) into the sandbox's BURACLE_HOME. */
export function installShim(): void {
  for (const op of shimPlanOps({ bun: bunPath(), repoRoot: REPO })) {
    if (op.kind !== 'file') continue
    mkdirSync(dirname(op.path), { recursive: true })
    writeFileSync(op.path, op.content)
    if (op.mode !== undefined) chmodSync(op.path, op.mode)
  }
}

/** The environment a harness gives its hook and MCP children: bun is found the way the harness's own PATH finds it. */
export function withBunOnPath(): Record<string, string> {
  return { PATH: `${dirname(process.execPath)}${delimiter}${process.env['PATH'] ?? ''}` }
}

export function preToolUsePayload(harness: 'claude' | 'codex', command: string, cwd: string): string {
  const base = { session_id: 'wire-test', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd, permission_mode: 'bypassPermissions' }
  return JSON.stringify(harness === 'codex' ? { ...base, turn_id: 't0', transcript_path: null, model: 'wire-test', tool_use_id: 'wire-test' } : base)
}

export function decisionOf(stdout: string): { decision?: unknown, reason?: unknown } {
  try {
    const o = JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: unknown, permissionDecisionReason?: unknown } }
    return { decision: o.hookSpecificOutput?.permissionDecision, reason: o.hookSpecificOutput?.permissionDecisionReason }
  } catch { return {} }
}

export type RunWire = (argv: string[], stdin: string) => Promise<RunResult>

export function runWire(cwd: string): RunWire {
  return (argv, stdin) => run(argv, { stdin, cwd, timeoutMs: 60_000, env: withBunOnPath() })
}
