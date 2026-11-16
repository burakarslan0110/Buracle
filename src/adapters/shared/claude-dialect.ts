import { contextJson } from './pipeline/types'

// The command-hook dialect Claude Code and Qwen Code share: the payload is one JSON object on stdin, the answer is
// JSON on stdout with exit 0 (a non-zero exit is the host's own error path, never Buracle Stack's way to block).

export interface HookOutcome { stdout: string; exitCode: number }

export const QUIET: HookOutcome = { stdout: '', exitCode: 0 }

export function out(obj: unknown): HookOutcome {
  return { stdout: JSON.stringify(obj) + '\n', exitCode: 0 }
}

export function str(x: unknown): string | undefined {
  return typeof x === 'string' && x !== '' ? x : undefined
}

export function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export function parsePayload(stdin: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(stdin) as unknown
    return isObj(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** An event's context for the model: `hookSpecificOutput.additionalContext`, clipped to the budget; nothing when there is none. */
export function contextOut(event: string, parts: readonly string[], systemMessage?: string): HookOutcome {
  const o = contextJson(event, parts, systemMessage)
  return o === undefined ? QUIET : out(o)
}

export function denyOut(reason: string): HookOutcome {
  return out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
}

/** The answer of a Stop hook that keeps the agent working: the reason goes back to the model. */
export function blockOut(reason: string): HookOutcome {
  return out({ decision: 'block', reason })
}
