import { RESTORE_TODOS_MAX } from '../../../core/compact'
import { laneReviewsInFlight } from '../../../core/plan/reviews'
import * as paths from '../../../engine/paths'
import type { LiveConfig } from './config'
import type { CmBridge } from './context-mode'
import type { ExtensionDeps } from './deps'
import type { SpoolEntry } from './memory'
import type { OmpCompactEvent, OmpCompactingEvent, OmpCompactingResult, OmpContext, OmpExtensionAPI } from './types'
import { clip, isMain, sessionOf, strAt, withDeadline } from './util'

export const COMPACT_RESTORE_TYPE = 'buracle.compact-restore'

export interface CompactionHost {
  deps: Pick<ExtensionDeps, 'now' | 'state' | 'compact' | 'branch' | 'memory'>
  live(): LiveConfig
  slugOf(sid: string, cwd: string): Promise<string | undefined>
  guarded<T>(what: string, fn: () => T): T | undefined
  report(what: string, e: unknown): void
  spool(sid: string, entries: SpoolEntry[]): void
  cm: CmBridge
  todos?(sid: string): string[]
  handoff(sid: string, cwd: string, note: { slug: string, markdown: string, branch?: string }): Promise<string | undefined>
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

async function compactSave(sid: string, ctx: OmpContext, host: CompactionHost): Promise<OmpCompactingResult | undefined> {
  const { deps } = host
  host.guarded('memory tick', () => { deps.memory.compactSeen?.(sid) })
  const state = deps.state.load(sid)
  const todo = host.guarded('H06 todos', () => host.todos?.(sid)) ?? []
  let handoff: string | undefined
  const slug = await withDeadline(host.slugOf(sid, ctx.cwd), 2_000, undefined)
  if (slug !== undefined) {
    const branch = await withDeadline(deps.branch(ctx.cwd).catch(() => undefined), 2_000, undefined)
    const note = host.guarded('H06 handoffNote', () => deps.compact.handoffNote({ state, project: slug, harness: 'omp', sessionId: sid, now: deps.now(), ...(branch !== undefined ? { branch } : {}), ...(todo.length > 0 ? { todo } : {}) }))
    if (note !== undefined) {
      const id = await withDeadline(host.handoff(sid, ctx.cwd, { slug: note.slug, markdown: note.markdown, ...(branch !== undefined ? { branch } : {}) }).catch(e => { host.report('H06 write handoff', e); return undefined }), 9_000, undefined)
      if (id !== undefined) handoff = id
    }
  }
  if (state.plan === undefined && state.interaction === undefined && todo.length === 0 && laneReviewsInFlight(state).length === 0) return undefined
  const result: OmpCompactingResult = {}
  const instructions = host.guarded('H06 compactInstructions', () => deps.compact.compactInstructions(undefined, state))
  if (instructions && instructions.trim() !== '') result.context = [instructions]
  const preserve: Record<string, unknown> = { v: 1, sessionId: sid }
  if (state.plan !== undefined) preserve['plan'] = state.plan.path
  if (handoff !== undefined) preserve['handoff'] = handoff
  else if (todo.length > 0) preserve['todos'] = todo.slice(0, RESTORE_TODOS_MAX)
  result.preserveData = { buracle: preserve }
  return result
}

function withRestore(result: OmpCompactingResult, sid: string, text: string): OmpCompactingResult {
  const out: OmpCompactingResult = { ...result }
  const kept = out.preserveData?.['buracle']
  const preserve: Record<string, unknown> = isRecord(kept) ? { ...kept } : { v: 1, sessionId: sid }
  preserve['contextMode'] = text
  out.preserveData = { ...(out.preserveData ?? {}), buracle: preserve }
  return out
}

export function registerCompaction(pi: OmpExtensionAPI, host: CompactionHost): void {
  pi.on('session.compacting', async (event: OmpCompactingEvent, ctx: OmpContext): Promise<OmpCompactingResult | undefined> => {
    try {
      if (!isMain(ctx)) return undefined
      const sid = paths.isValidSessionId(event.sessionId) ? event.sessionId : sessionOf(ctx)
      if (sid === undefined) return undefined
      const restore = host.cm.beforeCompaction(sid)
      let result: OmpCompactingResult | undefined
      try {
        result = await compactSave(sid, ctx, host)
      } catch (e) {
        host.report('session.compacting', e)
      }
      const text = await restore
      return text !== undefined && result !== undefined ? withRestore(result, sid, text) : result
    } catch (e) {
      host.report('session.compacting', e)
      return undefined
    }
  })

  pi.on('session_compact', (event: OmpCompactEvent, ctx: OmpContext): undefined => {
    try {
      if (!isMain(ctx)) return undefined
      const sid = sessionOf(ctx)
      if (sid === undefined) return undefined
      const summary = event.compactionEntry?.summary
      if (typeof summary === 'string' && summary.trim() !== '') host.spool(sid, [{ ts: host.deps.now(), ev: 'compact', excerpt: clip(summary, 8000) }])
      const preserved = event.compactionEntry?.preserveData?.['buracle']
      const handoff = strAt(preserved, 'handoff')
      const restore = strAt(preserved, 'contextMode')
      const kept = isRecord(preserved) ? preserved['todos'] : undefined
      const todos = handoff === undefined && Array.isArray(kept) ? kept.filter((t): t is string => typeof t === 'string').slice(0, RESTORE_TODOS_MAX) : []
      const plan = host.guarded('H07 restoreContext', () => host.deps.compact.restoreContext(host.deps.state.load(sid), handoff, todos))
      const parts = [plan, restore].filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      if (parts.length > 0) pi.sendMessage({ customType: COMPACT_RESTORE_TYPE, content: parts.join('\n\n'), display: false }, { deliverAs: 'nextTurn' })
      host.cm.afterCompaction(sid, restore !== undefined && restore.trim() !== '')
    } catch (e) {
      host.report('session_compact', e)
    }
    return undefined
  })
}
