import type { BuracleConfig } from '../../../core/config'
import { cmCaptureBlocked, cmClaudeEvent, cmCodexEvent, type CmEvent } from '../../../core/context-mode'
import { cmPackage, cmProjectDir, type CmPackage } from '../../../engine/context-mode'
import { log } from '../../../engine/log'
import { isValidSessionId } from '../../../engine/paths'
import { cmSpawnSession, type CmChildRequest } from './client'
import { cmExclusion } from './exclusion'
import { loadCmLibrary } from './library'
import { cmRestoreOp, cmTargetProblem, type CmTarget } from './session'

export type CmBridgeHarness = 'claude' | 'codex'

export const CM_RESTORE_BUDGET_MS = 3000

export interface CmBridgeOptions {
  config: BuracleConfig
  env?: Readonly<Record<string, string | undefined>>
  pkg?: CmPackage | null
  spawn?: (req: CmChildRequest) => boolean
  restoreBudgetMs?: number
  maxBytes?: number
  now?: () => number
}

export interface CmForwardResult {
  action: 'capture' | 'startup' | 'snapshot' | 'restore' | 'none'
  skipped?: string
  text?: string
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' && x !== '' ? x : undefined
}

export function cmIsSubagentPayload(h: CmBridgeHarness, p: Record<string, unknown>): boolean {
  return str(p['agent_id']) !== undefined || (h === 'codex' && str(p['agent_type']) !== undefined)
}

export function cmBridgeProjectDir(h: CmBridgeHarness, p: Record<string, unknown>, env: Readonly<Record<string, string | undefined>>): string {
  return cmProjectDir(h, { claudeProjectDir: h === 'claude' ? env['CLAUDE_PROJECT_DIR'] : undefined, cwd: str(p['cwd']) ?? process.cwd() })
}

export function cmCaptureDetached(target: CmTarget, events: readonly CmEvent[], spawn: (req: CmChildRequest) => boolean = req => cmSpawnSession(req)): boolean {
  if (events.length === 0 || cmTargetProblem(target) !== undefined) return false
  return spawn({ op: 'capture', target, events })
}

export function cmStartupDetached(target: CmTarget, spawn: (req: CmChildRequest) => boolean = req => cmSpawnSession(req)): boolean {
  return cmTargetProblem(target) === undefined && spawn({ op: 'startup', target })
}

export function cmSnapshotDetached(target: CmTarget, spawn: (req: CmChildRequest) => boolean = req => cmSpawnSession(req)): boolean {
  return cmTargetProblem(target) === undefined && spawn({ op: 'snapshot', target })
}

async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([p, new Promise<undefined>(res => { timer = setTimeout(() => res(undefined), Math.max(0, ms)) })])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function cmRestore(target: CmTarget, source: 'compact' | 'resume', opts: { budgetMs?: number, maxBytes?: number, pkg?: CmPackage | null, now?: () => number } = {}): Promise<string | undefined> {
  try {
    if (cmTargetProblem(target) !== undefined) return undefined
    const now = opts.now ?? Date.now
    const deadline = now() + (opts.budgetMs ?? CM_RESTORE_BUDGET_MS)
    const pkg = opts.pkg === undefined ? cmPackage() : opts.pkg
    if (pkg === null || pkg === undefined) return undefined
    const lib = await within(loadCmLibrary(pkg.root), deadline - now())
    if (lib === undefined || now() > deadline) return undefined
    const r = cmRestoreOp(lib, target, source, { ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}), deadline, now })
    return r.text ?? ''
  } catch (e) {
    log('warn', 'context-mode: the session restore failed', { harness: target.harness, error: e })
    return undefined
  }
}

export async function cmForward(h: CmBridgeHarness, event: string, payload: Record<string, unknown>, opts: CmBridgeOptions): Promise<CmForwardResult> {
  const none = (skipped: string): CmForwardResult => ({ action: 'none', skipped })
  try {
    const sid = payload['session_id']
    if (!isValidSessionId(sid)) return none('invalid session id')
    if (cmIsSubagentPayload(h, payload)) return none('subagent')
    const env = opts.env ?? process.env
    const blocked = cmCaptureBlocked({ config: opts.config, env })
    if (blocked !== undefined) return none(blocked)
    const pkg = opts.pkg === undefined ? cmPackage() : opts.pkg
    if (pkg === null || pkg === undefined) return none('context-mode is not installed in the toolchain')
    const target: CmTarget = { harness: h, sessionId: sid, projectDir: cmBridgeProjectDir(h, payload, env) }
    const excluded = async (): Promise<CmForwardResult | undefined> => {
      const why = await cmExclusion(target.projectDir, opts.config)
      return why !== undefined ? none(why) : undefined
    }
    const spawn = opts.spawn ?? ((req: CmChildRequest) => cmSpawnSession(req))
    const started = (action: CmForwardResult['action'], ok: boolean): CmForwardResult => (ok ? { action } : { action, skipped: 'the child could not be started' })
    switch (event) {
      case 'SessionStart': {
        const out = await excluded()
        if (out !== undefined) return out
        const source = str(payload['source']) ?? 'startup'
        if (source === 'compact' || source === 'resume') {
          const text = await cmRestore(target, source, {
            budgetMs: opts.restoreBudgetMs ?? CM_RESTORE_BUDGET_MS, pkg,
            ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
            ...(opts.now !== undefined ? { now: opts.now } : {}),
          })
          return text === undefined ? { action: 'restore', skipped: 'the restore was unavailable or over its time budget' } : { action: 'restore', text }
        }
        return started('startup', cmStartupDetached(target, spawn))
      }
      case 'PreCompact':
        return (await excluded()) ?? started('snapshot', cmSnapshotDetached(target, spawn))
      case 'UserPromptSubmit':
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const ev = h === 'claude' ? cmClaudeEvent(event, payload) : cmCodexEvent(event, payload)
        if (ev === undefined) return none('nothing to record')
        return (await excluded()) ?? started('capture', cmCaptureDetached(target, [ev], spawn))
      }
      default:
        return none('not a bridged event')
    }
  } catch (e) {
    log('warn', 'context-mode: the session bridge failed', { harness: h, event, error: e })
    return none('failed')
  }
}
