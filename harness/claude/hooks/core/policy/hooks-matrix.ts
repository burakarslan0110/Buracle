import type { Harness, HookId } from '../events'
import { HARNESSES, HOOK_IDS } from '../events'
import { harnessTable, type HarnessProfile } from '../harness/index'

export const BLOCKING_HOOKS: readonly HookId[] = ['H01', 'H02', 'H03', 'H08', 'H11', 'H20', 'H23']
const BLOCKING_KIND: Partial<Record<HookId, 'deny' | 'stop'>> = { H01: 'deny', H02: 'deny', H03: 'deny', H08: 'stop', H11: 'stop', H20: 'deny', H23: 'stop' }

export const CODEX_MATCHER_EVENTS: readonly string[] = ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop']

import { CLAUDE_CLASSIC_EVENTS } from '../harness/native-events'

export { CLAUDE_CLASSIC_EVENTS, CLAUDE_ENGINE_EVENTS, CODEX_EVENTS, OMP_EVENTS, OPENCODE_EVENTS } from '../harness/native-events'

const nativeOf = (pick: (map: HarnessProfile['events']['map']) => readonly string[] | null) => harnessTable(p => pick(p.events.map) ?? [])

export const HOOK_EVENTS: Readonly<Record<Harness, readonly string[]>> = harnessTable(p => p.events.native)
export const DENY_EVENTS: Readonly<Record<Harness, readonly string[]>> = nativeOf(m => m.preTool)
export const STOP_EVENTS: Readonly<Record<Harness, readonly string[]>> = nativeOf(m => m.stop)

const BINDING_KEYS = ['event', 'matcher', 'async', 'timeoutMs', 'also', 'fallback']
const HOOK_KEYS = ['id', 'name', 'description', 'blocking', 'failure', 'bindings', 'contract_test']

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function checkMatcher(m: unknown, h: Harness | 'fallback', at: string, errors: string[], event?: unknown): void {
  if (m === undefined) return
  const nonEmptyStr = (s: unknown): boolean => typeof s === 'string' && s.trim() !== ''
  if (h === 'claude' && typeof event === 'string' && event.startsWith('classic.')) {
    if (!nonEmptyStr(m)) errors.push(`${at}.matcher: a Claude command hook matcher is a string such as Bash|Monitor`)
    return
  }
  if (h === 'claude') {
    if (!isObj(m) || Object.keys(m).length === 0) errors.push(`${at}.matcher: Claude mod matchers are partial objects such as { tool: Bash }`)
    return
  }
  if (h === 'codex' || h === 'fallback') {
    if (!nonEmptyStr(m)) errors.push(`${at}.matcher: expected a non-empty string`)
    return
  }
  if (!(nonEmptyStr(m) || (Array.isArray(m) && m.length > 0 && m.every(nonEmptyStr)))) errors.push(`${at}.matcher: expected a tool name or a list of tool names`)
}

function checkBinding(b: unknown, h: Harness, at: string, errors: string[], nested: boolean): void {
  if (!isObj(b)) { errors.push(`${at}: expected a binding or { unsupported: reason }`); return }
  if ('unsupported' in b) {
    if (nested) errors.push(`${at}: unsupported is not allowed here`)
    if (Object.keys(b).length !== 1) errors.push(`${at}: unsupported must be the only key`)
    if (typeof b['unsupported'] !== 'string' || b['unsupported'].trim().length < 10) errors.push(`${at}.unsupported: give the reason in words`)
    return
  }
  for (const k of Object.keys(b)) if (!BINDING_KEYS.includes(k)) errors.push(`${at}.${k}: unknown key`)
  const ev = b['event']
  if (typeof ev !== 'string' || !HOOK_EVENTS[h].includes(ev)) errors.push(`${at}.event: ${JSON.stringify(ev)} is not a ${h} event`)
  checkMatcher(b['matcher'], h, at, errors, ev)
  if (h === 'codex' && b['matcher'] !== undefined && typeof ev === 'string' && !CODEX_MATCHER_EVENTS.includes(ev)) errors.push(`${at}.matcher: Codex ignores matchers on ${ev}`)
  if (b['async'] !== undefined && typeof b['async'] !== 'boolean') errors.push(`${at}.async: expected true or false`)
  const t = b['timeoutMs']
  if (t !== undefined && !(typeof t === 'number' && Number.isInteger(t) && t > 0 && t <= 600_000)) errors.push(`${at}.timeoutMs: expected a whole number of milliseconds up to 600000`)
  if (h === 'codex' && ev === 'SessionEnd') {
    if (b['async'] === true) errors.push(`${at}: Codex runs SessionEnd synchronously`)
    if (typeof t !== 'number' || t > 3000) errors.push(`${at}.timeoutMs: Codex clamps SessionEnd to at most 3000 ms`)
  }
  const also = b['also']
  if (also !== undefined) {
    if (nested) errors.push(`${at}.also: not allowed inside also`)
    else if (!Array.isArray(also) || also.length === 0) errors.push(`${at}.also: expected a non-empty list of bindings`)
    else also.forEach((x, i) => checkBinding(x, h, `${at}.also[${i}]`, errors, true))
  }
  const fb = b['fallback']
  if (fb !== undefined) {
    if (h !== 'claude' || nested) errors.push(`${at}.fallback: only Claude bindings have a classic fallback`)
    else if (Array.isArray(fb) && fb.length === 0) errors.push(`${at}.fallback: expected { event, matcher?, timeoutMs? } or a non-empty list of them`)
    else {
      const list: unknown[] = Array.isArray(fb) ? fb : [fb]
      const seen = new Set<string>()
      list.forEach((f, i) => {
        const fat = Array.isArray(fb) ? `${at}.fallback[${i}]` : `${at}.fallback`
        if (!isObj(f)) { errors.push(`${fat}: expected { event, matcher?, timeoutMs? }`); return }
        for (const k of Object.keys(f)) if (!['event', 'matcher', 'timeoutMs', 'async'].includes(k)) errors.push(`${fat}.${k}: unknown key`)
        if (typeof f['event'] !== 'string' || !CLAUDE_CLASSIC_EVENTS.includes(f['event'])) errors.push(`${fat}.event: ${JSON.stringify(f['event'])} is not a Claude classic hook event`)
        checkMatcher(f['matcher'], 'fallback', fat, errors)
        const ft = f['timeoutMs']
        if (ft !== undefined && !(typeof ft === 'number' && Number.isInteger(ft) && ft > 0 && ft <= 600_000)) errors.push(`${fat}.timeoutMs: expected a whole number of milliseconds`)
        const id = `${String(f['event'])}\0${String(f['matcher'] ?? '')}`
        if (seen.has(id)) errors.push(`${fat}: duplicate fallback ${String(f['event'])}`)
        seen.add(id)
      })
    }
  }
}

export function validateHooksMatrix(x: unknown): string[] {
  const errors: string[] = []
  if (!isObj(x) || !Array.isArray(x['hooks'])) return ['(root): expected { hooks: [...] }']
  for (const k of Object.keys(x)) if (k !== 'hooks') errors.push(`(root).${k}: unknown key`)
  const hooks = x['hooks'] as unknown[]
  const ids = hooks.map(h => (isObj(h) ? h['id'] : undefined))
  if (ids.length !== HOOK_IDS.length || ids.some((id, i) => id !== HOOK_IDS[i])) errors.push(`hooks: expected exactly ${HOOK_IDS[0]}…${HOOK_IDS[HOOK_IDS.length - 1]} in order (got ${ids.map(String).join(', ')})`)
  hooks.forEach((hk, i) => {
    const at = `hooks[${i}]`
    if (!isObj(hk)) { errors.push(`${at}: expected a mapping`); return }
    const id = hk['id'] as HookId
    const where = `${at}(${String(id)})`
    for (const k of Object.keys(hk)) if (!HOOK_KEYS.includes(k)) errors.push(`${where}.${k}: unknown key`)
    if (typeof hk['name'] !== 'string' || !/^[a-z]+(?:\.[a-z-]+)+$/.test(hk['name'])) errors.push(`${where}.name: expected a dotted name such as guard.bash`)
    if (hk['description'] !== undefined && (typeof hk['description'] !== 'string' || hk['description'].trim() === '')) errors.push(`${where}.description: expected a string`)
    const blocking = hk['blocking']
    if (blocking !== 'none' && blocking !== 'deny' && blocking !== 'stop') errors.push(`${where}.blocking: expected none | deny | stop`)
    const kind = BLOCKING_KIND[id]
    if (kind === undefined && blocking !== 'none') errors.push(`${where}.blocking: only ${BLOCKING_HOOKS.join(', ')} may block`)
    if (kind !== undefined && blocking !== kind) errors.push(`${where}.blocking: expected ${kind}`)
    if (hk['failure'] !== 'open' && hk['failure'] !== 'closed') errors.push(`${where}.failure: expected open | closed`)
    if (typeof hk['contract_test'] !== 'string' || !/^tests\/[\w./-]+\.test\.ts$/.test(hk['contract_test'])) errors.push(`${where}.contract_test: expected a tests/**/*.test.ts path`)
    const bindings = hk['bindings']
    if (!isObj(bindings)) { errors.push(`${where}.bindings: expected a mapping per harness`); return }
    for (const k of Object.keys(bindings)) if (!(HARNESSES as readonly string[]).includes(k)) errors.push(`${where}.bindings.${k}: unknown harness`)
    for (const h of HARNESSES) {
      const b = bindings[h]
      if (b === undefined) { errors.push(`${where}.bindings.${h}: missing (give a binding or unsupported: reason)`); continue }
      checkBinding(b, h, `${where}.bindings.${h}`, errors, false)
      if (kind !== undefined && isObj(b) && !('unsupported' in b)) {
        const ev = b['event']
        const allowed = kind === 'deny' ? DENY_EVENTS[h] : STOP_EVENTS[h]
        if (typeof ev === 'string' && !allowed.includes(ev)) errors.push(`${where}.bindings.${h}.event: ${ev} cannot ${kind === 'deny' ? 'deny a tool call' : 'keep a turn going'} on ${h}`)
        if (b['async'] === true) errors.push(`${where}.bindings.${h}: a blocking hook cannot be async`)
      }
    }
  })
  return errors
}
