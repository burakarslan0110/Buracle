export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function asRecord(x: unknown): Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {}
}

export function str(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined
}

export function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined
}

export function tokenTotal(t: unknown): number | undefined {
  const r = asRecord(t)
  const cache = asRecord(r['cache'])
  const parts = [num(r['input']), num(r['output']), num(r['reasoning']), num(cache['read']), num(cache['write'])]
  if (parts.every(p => p === undefined)) return undefined
  return parts.reduce<number>((a, b) => a + (b ?? 0), 0)
}

export function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === undefined || output === null) return ''
  try { return JSON.stringify(output, null, 2) ?? '' } catch { return String(output) }
}

export function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<T>(res => { timer = setTimeout(() => res(fallback), ms) })
  return Promise.race([p.catch(() => fallback), late]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
}

export function skillIdsOf(res: unknown): ReadonlySet<string> | undefined {
  const list = Array.isArray(res) ? res : asRecord(res)['data']
  if (!Array.isArray(list)) return undefined
  return new Set(list.map(s => str(asRecord(s)['id'])).filter((id): id is string => id !== undefined))
}

export function actionMatchesTool(action: string, tool: string): boolean {
  switch (action) {
    case 'shell': return tool === 'shell' || tool === 'bash'
    case 'edit': return tool === 'edit' || tool === 'write' || tool === 'patch' || tool === 'apply_patch' || tool === 'multiedit'
    case 'subagent': return tool === 'subagent' || tool === 'task'
    default: return action === tool
  }
}
