import { existsSync } from 'node:fs'
import { isMemId } from '../../core/memory/brain'
import { BACKUP_BUDGET, HEADROOM } from '../../core/memory/budgets'
import { loadConfigSync } from '../../engine/config'
import * as paths from '../../engine/paths'
import { memReasonAdvice } from '../../core/memory/status'
import { tilde } from '../../engine/update/output'
import { MemoryError, update as updateMemory, type MemoryCtx, type UpdatePatch } from '../api'
import { BackupError, backupBrains, backupBytes, backupBuckets, backupHolds, listBackups, type BackupInfo } from '../backup'
import { chooseHarnesses } from '../model'
import { projectRoot, readProjectsCache } from '../project'
import { removeProject } from '../project-remove'
import { computeStatus, memoryMcpHealth, refreshStatus } from '../status'
import { brainFileInfo } from '../status-report'
import { bucketExists, deleteItem, getStored, projectRef, recordEvent, withBrainLock } from '../store'
import { migrationSummary, parseScope, UiApiError, type UiScope } from './api'

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

async function scopeOf(body: Record<string, unknown>): Promise<UiScope> {
  return parseScope(typeof body['scope'] === 'string' ? body['scope'] : null)
}

async function projectInfo(slug: string, memories: number): Promise<Record<string, unknown>> {
  const rec = readProjectsCache().projects[slug]
  return {
    slug,
    ...(rec?.ownerRepo !== undefined && rec.ownerRepo !== '' ? { name: rec.ownerRepo } : {}),
    registered: rec !== undefined,
    roots: (rec?.roots ?? []).map(r => ({ path: tilde(r), exists: existsSync(r) })),
    brain: await bucketExists(projectRef(slug)).catch(() => false),
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
    ...(slug !== undefined ? { project: await projectInfo(slug, status.counts.project) } : {}),
    captures: status.captures,
    ...(status.last_capture !== undefined ? { lastCapture: status.last_capture } : {}),
    store: { ok: status.store.ok, ...(status.store.version !== undefined ? { version: status.store.version } : {}) },
    brain: await brainFileInfo().catch(() => undefined),
    migration: migrationSummary(),
    mcp: memoryMcpHealth(),
    backups: backupsPayload(scope),
  }
}

function backupsPayload(scope: UiScope): Record<string, unknown> {
  const holds = (m: BackupInfo) => backupHolds(m, scope.kind === 'person' ? { person: true } : { project: scope.slug })
  const all = listBackups()
  const list = all.slice(0, BACKUP_BUDGET.keep)
  const mine = all.find(holds)
  return {
    list: list.map(m => ({ id: m.id, at: m.at, trigger: m.trigger, buckets: backupBuckets(m).length, bytes: backupBytes(m), here: holds(m) })),
    ...(mine !== undefined ? { restore: `buracle mem restore ${mine.id} ${scope.kind === 'person' ? '--person' : `--project ${scope.slug}`}` } : {}),
  }
}

export async function backupNow(body: Record<string, unknown>, nowMs: number): Promise<Record<string, unknown>> {
  await scopeOf(body)
  try {
    const r = await backupBrains({ all: true }, { trigger: 'manual', nowMs, keep: BACKUP_BUDGET.keep })
    if (r.manifest === undefined) throw new UiApiError(409, 'nothing_to_back_up', 'there is no brain file yet')
    return { ok: true, id: r.manifest.id, buckets: backupBuckets(r.manifest).length, pruned: r.pruned.length }
  } catch (e) {
    if (e instanceof BackupError) throw new UiApiError(409, 'backup_failed', e.message)
    throw e
  }
}

export async function removeProjectNow(body: Record<string, unknown>, nowMs: number): Promise<Record<string, unknown>> {
  const scope = await scopeOf(body)
  if (scope.kind !== 'project') throw new UiApiError(400, 'bad_scope', 'only a project can be removed; the person brain stays')
  const r = await removeProject(scope.slug, { nowMs, by: 'human' })
  await refreshStatus({ nowMs })
  return { ok: true, slug: r.slug, brain: r.brain, memories: r.memories, total: r.total, record: r.record }
}

const PROTECTED_KINDS: ReadonlySet<string> = new Set(['core', 'profile'])

/** The memory a write names. An edit (`editing`) is accepted for core pages and profile lines; retiring or deleting them is refused. */
async function target(body: Record<string, unknown>, opts: { editing?: boolean } = {}): Promise<{ scope: UiScope, id: string }> {
  const scope = await scopeOf(body)
  const id = body['id']
  if (!isMemId(id)) throw new UiApiError(400, 'bad_id', 'id must be a memory id (lowercase letters, digits and dashes)')
  const got = await getStored(scope.ref, id)
  if (got === undefined) throw new UiApiError(404, 'not_found', `there is no memory ${id} in this brain`)
  if (opts.editing !== true && PROTECTED_KINDS.has(got.item.kind)) {
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

const layerId = (scope: UiScope, id: string): string => `${scope.kind === 'person' ? 'person' : 'project'}/${id}`

/** A memory error of the shared memory API as the status and body the page gets. */
export function uiErrorOf(e: MemoryError): UiApiError {
  const status = e.code === 'conflict' ? 409 : e.code === 'not_editable' ? 403 : e.code === 'not_found' ? 404 : e.code === 'invalid_input' ? 400 : e.code === 'migrating' || e.code === 'store_unavailable' ? 503 : 400
  return new UiApiError(status, e.code, e.message, undefined, e.data)
}

export async function setMemoryStatus(body: Record<string, unknown>, status: 'deprecated' | 'active', nowMs: number): Promise<Record<string, unknown>> {
  const { scope, id } = await target(body)
  try {
    await updateMemory(uiCtx(scope, nowMs), {
      id: layerId(scope, id),
      patch: { status },
      reason: status === 'deprecated' ? 'retired in the web UI' : 'restored in the web UI',
    })
  } catch (e) {
    throw e instanceof MemoryError ? uiErrorOf(e) : e
  }
  await afterChange(scope, nowMs)
  return { ok: true, id, status }
}

const EDITABLE = ['title', 'summary', 'body', 'tags', 'about', 'importance', 'review'] as const

function editPatch(raw: unknown): UpdatePatch {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new UiApiError(400, 'bad_patch', 'patch must be an object with title, summary, body, tags, about, importance or review')
  const p = raw as Record<string, unknown>
  const unknown = Object.keys(p).filter(k => !(EDITABLE as readonly string[]).includes(k))
  if (unknown.length > 0) throw new UiApiError(400, 'bad_patch', `the page edits ${EDITABLE.join(', ')}; not ${unknown.join(', ')}`)
  if (Object.keys(p).length === 0) throw new UiApiError(400, 'bad_patch', 'patch is empty: name what to change')
  const out: UpdatePatch = {}
  for (const k of ['title', 'summary', 'body'] as const) {
    if (p[k] === undefined) continue
    if (typeof p[k] !== 'string') throw new UiApiError(400, 'bad_patch', `${k} must be text`)
    out[k] = p[k]
  }
  for (const k of ['tags', 'about'] as const) {
    if (p[k] === undefined) continue
    if (!Array.isArray(p[k]) || (p[k] as unknown[]).some(x => typeof x !== 'string')) throw new UiApiError(400, 'bad_patch', `${k} must be a list of text`)
    out[k] = p[k] as string[]
  }
  if (p['importance'] !== undefined) {
    if (typeof p['importance'] !== 'number' || !Number.isInteger(p['importance']) || p['importance'] < 1 || p['importance'] > 5) throw new UiApiError(400, 'bad_patch', 'importance must be a whole number from 1 to 5')
    out.importance = p['importance']
  }
  if (p['review'] !== undefined) {
    if (p['review'] !== 'ok' && p['review'] !== 'pending') throw new UiApiError(400, 'bad_patch', 'review must be ok or pending')
    out.review = p['review']
  }
  return out
}

/**
 * A correction made in the page: the same `update` the CLI and the agents use, with the human as the actor, so a rewritten
 * claim becomes the user's own (origin explicit, confidence 1) and an older version number is refused.
 */
export async function editMemory(body: Record<string, unknown>, nowMs: number): Promise<Record<string, unknown>> {
  const { scope, id } = await target(body, { editing: true })
  const patch = editPatch(body['patch'])
  const expected = body['expected_version']
  if (expected !== undefined && (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 1)) throw new UiApiError(400, 'bad_version', 'expected_version must be the whole number the page read')
  const reason = body['reason']
  if (reason !== undefined && typeof reason !== 'string') throw new UiApiError(400, 'bad_reason', 'reason must be text')
  let r
  try {
    r = await updateMemory(uiCtx(scope, nowMs), {
      id: layerId(scope, id), patch,
      ...(expected !== undefined ? { expected_version: expected } : {}),
      reason: reason !== undefined && reason.trim() !== '' ? reason : 'edited in the web UI',
    })
  } catch (e) {
    throw e instanceof MemoryError ? uiErrorOf(e) : e
  }
  await afterChange(scope, nowMs)
  return { ok: true, id: r.id, version: r.version, changed: r.changed }
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
