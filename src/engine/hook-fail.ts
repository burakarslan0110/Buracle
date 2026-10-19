export const GUARD_EVENTS: Readonly<Record<string, readonly string[]>> = {
  claude: ['PreToolUse'],
  codex: ['PreToolUse'],
}

export function isGuardEvent(harness: string, event: string): boolean {
  return (GUARD_EVENTS[harness] ?? []).includes(event)
}

export function shortError(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  const line = (text.split('\n')[0] ?? '').trim()
  return line.length > 200 ? `${line.slice(0, 197)}...` : line
}

export function failClosedReason(detail: string): string {
  return `Buracle blocked this tool call: its guard hook could not run (${detail}). The guards (H01, H02, H20) must check every call, so calls stay blocked until Buracle works again. Ask the user to run \`! buracle doctor\` and then \`! buracle install\` in this session; the log is ~/.buracle/logs/buracle.log.`
}

export function denyJson(reason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n'
}

export function failClosedOutcome(harness: string, event: string, detail: string): { stdout: string, exitCode: number } | undefined {
  return isGuardEvent(harness, event) ? { stdout: denyJson(failClosedReason(detail)), exitCode: 0 } : undefined
}

export function isFailClosedReason(reason: unknown): boolean {
  return typeof reason === 'string' && reason.startsWith('Buracle blocked this tool call: ')
}
