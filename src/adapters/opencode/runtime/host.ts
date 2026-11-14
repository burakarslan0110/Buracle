import { join } from 'node:path'
import type { CanonicalBundle } from '../../../core/catalog'
import { RESTORE_RECORD_MAX_MS } from '../../../core/compact'
import { MEMORY_INJECT } from '../../../core/memory/budgets'
import type { ContextBand } from '../../../core/status/context'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../../../engine/fsx'
import * as paths from '../../../engine/paths'
import type { AdapterContext } from '../../registry'
import type { CompactStore, MemoryFns } from '../../shared/pipeline/index'
import type { UiSessionHooks } from '../../shared/ui-session'
import type { BakedData } from './baked'
import type { RuntimeSnapshot } from './env'
import type { MemoryBridge } from './memory-bridge'

// What an in-process harness hands the shared pipeline (src/adapters/shared/pipeline): the adapter context it
// cannot load from `canonical/`, the memory layer behind its bridge, and its session file.

const HARNESS = 'opencode' as const

/** The adapter context of the bundled plugin: the canonical data baked into it and the runtime snapshot's config. */
export function adapterContext(baked: Pick<BakedData, 'routing' | 'notices'>, snap: RuntimeSnapshot): AdapterContext {
  const repoRoot = snap.resolved?.repoRoot
  const canonical = { routing: baked.routing, notices: baked.notices ?? [] } as unknown as CanonicalBundle
  return { repoRoot: typeof repoRoot === 'string' ? repoRoot : '', config: snap.config, canonical, paths, buracleBin: paths.shimPath() }
}

/** The pipeline's memory entry points on the plugin's bridge; the bridge names the harness itself. */
export function memoryFns(bridge: MemoryBridge): MemoryFns {
  return {
    appendSpool: (_h, sid, entries) => bridge.append(sid, entries),
    sessionStart: (_h, sid, cwd) => bridge.start(sid, cwd),
    promptSeen: (_h, sid) => bridge.prompt?.(sid),
    spawnFinalizer: (_h, sid) => bridge.finalize(sid),
    contextText: async o => (await bridge.context(o.cwd, o.maxBytes ?? MEMORY_INJECT.maxBytes)) ?? '',
    writeHandoff: async i => {
      const id = await bridge.handoff({ sessionId: i.sessionId, cwd: i.cwd, slug: i.slug, markdown: i.markdown, now: i.now ?? 0, ...(i.branch !== undefined ? { branch: i.branch } : {}) })
      return id !== undefined ? { id, path: id, rel: id } : undefined
    },
  }
}

export const NO_UI: UiSessionHooks = { started: async () => undefined, seen: async () => undefined, ended: async () => undefined }

export function uiHooks(bridge: MemoryBridge): UiSessionHooks {
  return {
    started: async (_h, sid) => { bridge.ui?.started(sid) },
    seen: async (_h, sid) => { bridge.ui?.seen(sid) },
    ended: async (_h, sid) => { bridge.ui?.ended(sid) },
  }
}

/** opencode.json of a session: what a plugin restart must not lose. */
export interface Persisted { compactAt?: number, handoff?: string, compactTodos?: string[], ctxWarned?: ContextBand, todos?: string[] }

function file(sid: string): string {
  return join(paths.sessionDir(HARNESS, sid), 'opencode.json')
}

function strings(x: unknown): string[] | undefined {
  return Array.isArray(x) ? x.filter((t): t is string => typeof t === 'string') : undefined
}

export function readPersisted(sid: string): Persisted {
  const r = readJsonSafeSync<Record<string, unknown>>(file(sid))
  const v = r.ok && r.value !== null && typeof r.value === 'object' ? r.value : {}
  const out: Persisted = {}
  if (typeof v['compactAt'] === 'number') out.compactAt = v['compactAt']
  if (typeof v['handoff'] === 'string') out.handoff = v['handoff']
  const compactTodos = strings(v['compactTodos'])
  if (compactTodos !== undefined) out.compactTodos = compactTodos
  const band = v['ctxWarned']
  if (band === 'ok' || band === 'warn' || band === 'critical') out.ctxWarned = band
  const todos = strings(v['todos'])
  if (todos !== undefined) out.todos = todos
  return out
}

export function updatePersisted(sid: string, fn: (p: Persisted) => Persisted): void {
  ensureDirSync(paths.sessionDir(HARNESS, sid))
  atomicWriteSync(file(sid), JSON.stringify({ v: 2, ...fn(readPersisted(sid)) }) + '\n')
}

/** The session's compaction record in opencode.json, for the restore after it. */
export function compactStore(sid: string, at: number): CompactStore {
  return {
    read(now) {
      const own = readPersisted(sid)
      return {
        recent: own.compactAt !== undefined && now - own.compactAt <= RESTORE_RECORD_MAX_MS,
        ...(own.handoff !== undefined ? { handoff: own.handoff } : {}), ...(own.compactTodos !== undefined ? { todo: own.compactTodos } : {}),
      }
    },
    save(handoff, todo) {
      updatePersisted(sid, p => {
        const { handoff: _handoff, compactTodos: _todos, ...rest } = p
        return { ...rest, compactAt: at, ...(handoff !== undefined ? { handoff } : todo.length > 0 ? { compactTodos: todo } : {}) }
      })
    },
  }
}
