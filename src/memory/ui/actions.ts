import { existsSync } from 'node:fs'
import { isMemId } from '../../core/memory/brain'
import { BACKUP_BUDGET, HEADROOM } from '../../core/memory/budgets'
import { loadConfigSync } from '../../engine/config'
import * as paths from '../../engine/paths'
import { memReasonAdvice } from '../../core/memory/status'
import { tilde } from '../../engine/update/output'
import { update as updateMemory, type MemoryCtx } from '../api'
import { BackupError, backupBrains, listBackups, type BackupManifest } from '../backup'
import { chooseHarnesses } from '../model'
import { projectRoot, readProjectsCache } from '../project'
import { removeProject } from '../project-remove'
import { computeStatus, memoryMcpHealth, refreshStatus } from '../status'
import { brainExists, deleteItem, getStored, projectRef, recordEvent, withBrainLock } from '../store'
import { parseScope, UiApiError, type UiScope } from './api'

export const MAX_BODY_BYTES = 64 * 1024

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  const type = (req.headers.get('content-type') ?? '').toLowerCase()
  if (!type.startsWith('application/json')) throw new UiApiError(415, 'bad_type', 'a write sends application/json')
  const declared = Number(req.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new UiApiError(413, 'too_large', `the body is larger than ${MAX_BODY_BYTES} bytes`)
  const text = await req.text()
  if (text.length > MAX_BODY_BYTES) throw new UiApiError(413, 'too_large', `the body is larger than ${MAX_BODY_BYTES} bytes`)
  let v: unknown
  try { v = JSON.parse(text) } catch { throw new UiApiError(400, 'bad_json', 'the body is not JSON') }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new UiApiError(400, 'bad_json', 'the body must be a JSON object')
  return v as Record<string, unknown>
}

function scopeOf(body: Record<string, unknown>): UiScope {
  return parseScope(typeof body['scope'] === 'string' ? body['scope'] : null)
}

function projectInfo(slug: string, memories: number): Record<string, unknown> {
  const rec = readProjectsCache().projects[slug]
  return {
    slug,
    ...(rec?.ownerRepo !== undefined && rec.ownerRepo !== '' ? { name: rec.ownerRepo } : {}),
    registered: rec !== undefined,
    roots: (rec?.roots ?? []).map(r => ({ path: tilde(r), exists: existsSync(r) })),
    brain: brainExists(projectRef(slug)),
    memories,
  }
}

export async function healthPayload(scope: UiScope, nowMs: number): Promise<Record<string, unknown>> {
  const slug = scope.kind === 'project' ? scope.slug : undefined
  const status = await computeStatus({ ...(slug !== undefined ? { slug } : {}), nowMs })
  return {
    scope: scope.key,
    computedAt: status.computed_at,
    health: status.health,
    reasons: status.reasons.map(code => ({ code, ...memReasonAdvice(code, status) })),
    ...(slug !== undefined ? { project: projectInfo(slug, status.counts.project) } : {}),
    captures: status.captures,
    ...(status.last_capture !== undefined ? { lastCapture: status.last_capture } : {}),
    store: { ok: status.store.ok, ...(status.store.version !== undefined ? { version: status.store.version } : {}) },
    mcp: memoryMcpHealth(),
    backups: backupsPayload(scope),
  }
}

function backupsPayload(scope: UiScope): Record<string, unknown> {
  const holds = (m: BackupManifest) => m.brains.some(x => (scope.kind === 'person' ? x.layer === 'person' : x.layer === 'project' && x.project === scope.slug))
  const all = listBackups()
  const list = all.slice(0, BACKUP_BUDGET.keep)
  const mine = all.find(holds)
  return {
    list: list.map(m => ({ id: m.id, at: m.at, trigger: m.trigger, brains: m.brains.length, bytes: m.brains.reduce((n, x) => n + x.bytes, 0), here: holds(m) })),
    ...(mine !== undefined ? { restore: `buracle mem restore ${mine.id} ${scope.kind === 'person' ? '--person' : `--project ${scope.slug}`}` } : {}),
  }
}

export async function backupNow(body: Record<string, unknown>, nowMs: number): Promise<Record<string, unknown>> {
  scopeOf(body)
  try {
    const r = await backupBrains({ all: true }, { trigger: 'manual', nowMs, keep: BACKUP_BUDGET.keep })
    if (r.manifest === undefined) throw new UiApiError(409, 'nothing_to_back_up', 'there is no brain file yet')
    return { ok: true, id: r.manifest.id, brains: r.manifest.brains.length, pruned: r.pruned.length, ...(r.manifest.skipped !== undefined ? { skipped: r.manifest.skipped } : {}) }
  } catch (e) {
    if (e instanceof BackupError) throw new UiApiError(409, 'backup_failed', e.message)
    throw e
  }
}

export async function removeProjectNow(body: Record<string, unknown>, nowMs: number): Promise<Record<string, unknown>> {
  const scope = scopeOf(body)
  if (scope.kind !== 'project') throw new UiApiError(400, 'bad_scope', 'only a project can be removed; the person brain stays')
  const r = await removeProject(scope.slug, { nowMs, by: 'human' })
  await refreshStatus({ nowMs })
  return { ok: true, slug: r.slug, brain: r.brain, memories: r.memories, total: r.total, record: r.record }
}

const PROTECTED_KINDS: ReadonlySet<string> = new Set(['core', 'profile'])

async function target(body: Record<string, unknown>): Promise<{ scope: UiScope, id: string }> {
  const scope = scopeOf(body)
  const id = body['id']
  if (!isMemId(id)) throw new UiApiError(400, 'bad_id', 'id must be a memory id (lowercase letters, digits and dashes)')
  const got = await getStored(scope.ref, id)
  if (got === undefined) throw new UiApiError(404, 'not_found', `there is no memory ${id} in this brain`)
  if (PROTECTED_KINDS.has(got.item.kind)) {
    throw new UiApiError(400, 'protected_kind', got.item.kind === 'core'
      ? 'core pages are kept by Buracle; edit them instead of deleting them'
      : 'profile lines come from an older Buracle and are no longer maintained; write a preference memory instead')
  }
  return { scope, id }
}

function uiCtx(scope: UiScope, nowMs: number): MemoryCtx {
  const root = scope.kind === 'project' ? projectRoot(scope.slug) : undefined
  return { cwd: root ?? paths.home(), harness: 'human', generatedBy: 'buracle-ui', agent: false, project: scope.kind === 'project' ? scope.slug : null, now: () => nowMs }
}

async function afterChange(scope: UiScope, nowMs: number): Promise<void> {
  await refreshStatus({ ...(scope.kind === 'project' ? { slug: scope.slug } : {}), nowMs })
}

export async function setMemoryStatus(body: Record<string, unknown>, status: 'deprecated' | 'active', nowMs: number): Promise<Record<string, unknown>> {
  const { scope, id } = await target(body)
  await updateMemory(uiCtx(scope, nowMs), {
    id: scope.kind === 'person' ? `person/${id}` : id,
    patch: { status },
    reason: status === 'deprecated' ? 'retired in the web UI' : 'restored in the web UI',
  })
  await afterChange(scope, nowMs)
  return { ok: true, id, status }
}

export async function deleteMemory(body: Record<string, unknown>, nowMs: number): Promise<Record<string, unknown>> {
  const { scope, id } = await target(body)
  const deleted = await withBrainLock(scope.ref, async () => {
    const cur = await getStored(scope.ref, id)
    if (cur === undefined) return false
    const gone = await deleteItem(scope.ref, id)
    if (gone) recordEvent({ op: 'delete', layer: scope.ref.layer, ...(scope.ref.slug !== undefined ? { project: scope.ref.slug } : {}), id, kind: cur.item.kind, by: 'human' })
    return gone
  })
  if (!deleted) throw new UiApiError(404, 'not_found', `there is no memory ${id} in this brain`)
  await afterChange(scope, nowMs)
  return { ok: true, id, deleted: true }
}

export function settingsPayload(nowMs: number): Record<string, unknown> {
  const choice = chooseHarnesses({ nowMs })
  let port: number | undefined
  try { port = loadConfigSync().config.memory.ui.port } catch { port = undefined }
  return {
    file: tilde(paths.userConfigFile()),
    model: {
      harnesses: choice.picks, held: choice.held,
      headroom: { max5hPct: HEADROOM.max5hPct, max7dPct: HEADROOM.max7dPct },
    },
    ...(port !== undefined ? { ui: { port } } : {}),
  }
}
