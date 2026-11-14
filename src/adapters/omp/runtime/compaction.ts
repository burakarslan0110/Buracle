import { RESTORE_TODOS_MAX } from '../../../core/compact'
import { laneReviewsInFlight } from '../../../core/plan/reviews'
import * as paths from '../../../engine/paths'
import { compactRestore, preCompact, type PipelineDeps } from '../../shared/pipeline/index'
import type { ExtensionDeps } from './deps'
import type { SpoolEntry } from './memory'
import type { OmpCompactEvent, OmpCompactingEvent, OmpCompactingResult, OmpContext, OmpExtensionAPI } from './types'
import { clip, isMain, sessionOf, strAt } from './util'

export const COMPACT_RESTORE_TYPE = 'buracle.compact-restore'

export interface CompactionHost {
  deps: Pick<ExtensionDeps, 'now' | 'state' | 'compact'>
  /** What the shared pipeline needs for this session. */
  pipe(sid: string): PipelineDeps
  guarded<T>(what: string, fn: () => T): T | undefined
  report(what: string, e: unknown): void
  spool(sid: string, entries: SpoolEntry[]): Promise<void>
  todos?(sid: string): string[]
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

/**
 * session.compacting is omp's preCompact. The pipeline writes the handoff; omp keeps the compaction record in the
 * compaction entry itself (`preserveData`), and adds the instructions for the summary.
 */
async function compactSave(sid: string, ctx: OmpContext, host: CompactionHost): Promise<OmpCompactingResult | undefined> {
  const { deps } = host
  let saved: { handoff?: string, todo: string[] } = { todo: [] }
  await preCompact({ harness: 'omp', sessionId: sid, cwd: ctx.cwd, now: deps.now() }, {
    ...host.pipe(sid),
    openTodos: () => host.todos?.(sid) ?? [],
    compact: { save: (handoff, todo) => { saved = { todo, ...(handoff !== undefined ? { handoff } : {}) } } },
  })
  const state = deps.state.load(sid)
  if (state.plan === undefined && state.interaction === undefined && saved.todo.length === 0 && laneReviewsInFlight(state).length === 0) return undefined
  const result: OmpCompactingResult = {}
  const instructions = host.guarded('H06 compactInstructions', () => deps.compact.compactInstructions(undefined, state))
  if (instructions && instructions.trim() !== '') result.context = [instructions]
  const preserve: Record<string, unknown> = { v: 1, sessionId: sid }
  if (state.plan !== undefined) preserve['plan'] = state.plan.path
  if (saved.handoff !== undefined) preserve['handoff'] = saved.handoff
  else if (saved.todo.length > 0) preserve['todos'] = saved.todo
  result.preserveData = { buracle: preserve }
  return result
}

export function registerCompaction(pi: OmpExtensionAPI, host: CompactionHost): void {
  pi.on('session.compacting', async (event: OmpCompactingEvent, ctx: OmpContext): Promise<OmpCompactingResult | undefined> => {
    try {
      if (!isMain(ctx)) return undefined
      const sid = paths.isValidSessionId(event.sessionId) ? event.sessionId : sessionOf(ctx)
      if (sid === undefined) return undefined
      return await compactSave(sid, ctx, host)
    } catch (e) {
      host.report('session.compacting', e)
      return undefined
    }
  })

  // The system prompt survives a compaction in omp, so only the restore note (H07) follows it, as a message.
  pi.on('session_compact', async (event: OmpCompactEvent, ctx: OmpContext): Promise<undefined> => {
    try {
      if (!isMain(ctx)) return undefined
      const sid = sessionOf(ctx)
      if (sid === undefined) return undefined
      const now = host.deps.now()
      const summary = event.compactionEntry?.summary
      if (typeof summary === 'string' && summary.trim() !== '') await host.spool(sid, [{ ts: now, ev: 'compact', excerpt: clip(summary, 8000) }])
      const preserved = event.compactionEntry?.preserveData?.['buracle']
      const handoff = strAt(preserved, 'handoff')
      const kept = isRecord(preserved) ? preserved['todos'] : undefined
      const todo = Array.isArray(kept) ? kept.filter((t): t is string => typeof t === 'string').slice(0, RESTORE_TODOS_MAX) : []
      const d = host.pipe(sid)
      const note = await d.step('H07 restore', '', () => compactRestore({ sessionId: sid, cwd: ctx.cwd, now }, {
        ...d,
        compact: { read: () => ({ recent: isRecord(preserved), ...(handoff !== undefined ? { handoff } : {}), ...(todo.length > 0 ? { todo } : {}) }) },
      }))
      if (note.trim() !== '') pi.sendMessage({ customType: COMPACT_RESTORE_TYPE, content: note, display: false }, { deliverAs: 'nextTurn' })
    } catch (e) {
      host.report('session_compact', e)
    }
    return undefined
  })
}
