import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cortexQuery, fromCortex, type MemItem } from '../core/memory/brain'
import { log } from '../engine/log'
import { run } from '../engine/proc'
import { CORTEXDB_BIN_ENV, cortexdbBinary, cortexdbLaunch, installCortexdb, type CortexdbInstall, type CortexdbInstallOptions } from '../engine/toolchain/cortexdb'
import { backupBrains } from './backup'
import { CortexClient } from './cortex'
import { bucketArgs, personRef, plainRow, projectRef, refKey, rowOwner, storedId, storedSave } from './store'

// A new CortexDB binary is used only after it does in a throwaway database what the memory does with it: save the
// same memory id into two buckets (a project's and the person's), read, list and find each in its own bucket only,
// and delete them, through the five tools Buracle calls.
export async function checkCortexdbBinary(bin: string, timeoutMs = 30_000): Promise<{ ok: true } | { ok: false, error: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'buracle-cortexdb-check-'))
  const client = new CortexClient(join(dir, 'check.db'), { env: { ...process.env, [CORTEXDB_BIN_ENV]: bin }, timeoutMs })
  const now = new Date().toISOString()
  const item: MemItem = {
    id: 'cortexdb-upgrade-check', kind: 'knowledge', layer: 'project', title: 'CortexDB upgrade check', summary: 'a throwaway memory',
    body: 'zebrafinch', tags: [], sources: [], about: [], status: 'active', review: 'pending', importance: 3, created: now, updated: now,
    author: 'buracle', version: 1, history: [],
  }
  const project = projectRef('upgrade-check')
  const person = personRef()
  const twin: MemItem = { ...item, layer: 'person', body: 'zebrafinch' }
  try {
    await client.call('memory_save', storedSave(project, item))
    await client.call('memory_save', storedSave(person, twin))
    for (const ref of [project, person]) {
      const got = await client.call<{ memory?: unknown }>('memory_get', { memory_id: storedId(ref, item.id) })
      if (fromCortex(plainRow(got.memory, ref), ref.layer)?.title !== item.title) return { ok: false, error: `memory_get did not return the memory saved in ${refKey(ref)}` }
    }
    const all = await client.call<{ memories?: unknown[] }>('memory_list_all', { limit: 10 })
    const owners = (all.memories ?? []).map(m => rowOwner(m)).filter((o): o is NonNullable<ReturnType<typeof rowOwner>> => o !== undefined).map(o => refKey(o.ref)).sort()
    if (owners.join() !== [refKey(person), refKey(project)].sort().join()) return { ok: false, error: `memory_list_all did not list both memories under their buckets (${owners.join(', ') || 'none'})` }
    for (const ref of [project, person]) {
      const found = await client.call<{ results?: Array<{ memory?: unknown }> }>('memory_search', { ...cortexQuery('zebrafinch', 5), ...bucketArgs(ref) })
      const ids = (found.results ?? []).map(r => (r.memory as { id?: string } | undefined)?.id)
      if (ids.length !== 1 || ids[0] !== storedId(ref, item.id)) return { ok: false, error: `memory_search in ${refKey(ref)} did not find exactly its own memory (${ids.join(', ') || 'none'})` }
    }
    await client.call('memory_delete', { memory_id: storedId(project, item.id) })
    await client.call('memory_delete', { memory_id: storedId(person, item.id) })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    await client.close()
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {  }
  }
}

export interface SelfTest { status: 'passed' | 'failed' | 'unavailable', detail: string }

/**
 * The binary's own `--doctor --self-test` against the brain file: one JSON line (status, self_test, error), exit 0 or 1.
 * A binary that does not know the flags runs as a server and prints no JSON; that is `unavailable`, not a failure.
 */
export async function brainSelfTest(db: string, timeoutMs = 10_000): Promise<SelfTest> {
  const bin = cortexdbBinary()
  if (bin === undefined) return { status: 'unavailable', detail: 'CortexDB is not installed' }
  const env: Record<string, string | undefined> = { CORTEXDB_PATH: db }
  for (const k of Object.keys(process.env)) if (/^(?:CORTEXDB_|OPENAI_)/.test(k) && k !== 'CORTEXDB_PATH') env[k] = undefined
  const r = await run([...cortexdbLaunch(bin), '--doctor', '--self-test'], { env, timeoutMs })
  let j: { status?: unknown, self_test?: unknown, error?: unknown } | undefined
  try { j = JSON.parse(r.stdout.trim().split('\n').filter(l => l.startsWith('{')).at(-1) ?? '') as typeof j } catch { j = undefined }
  if (r.timedOut || j === undefined || typeof j !== 'object' || j === null) return { status: 'unavailable', detail: r.timedOut ? `no answer within ${timeoutMs / 1000} s` : 'this CortexDB prints no self-test' }
  const status = typeof j.status === 'string' ? j.status : 'unknown'
  const err = typeof j.error === 'string' && j.error !== '' ? `: ${j.error}` : ''
  if (r.code !== 0 || status === 'failed' || j.self_test === 'failed') return { status: 'failed', detail: `status ${status}, self-test ${String(j.self_test ?? 'not run')}${err}` }
  return { status: 'passed', detail: `status ${status}, self-test ${String(j.self_test ?? 'not run')}` }
}

// The newest CortexDB, checked before it is used; the brains are backed up before a new version replaces the one
// they were written with.
export async function installCortexdbChecked(opts: Pick<CortexdbInstallOptions, 'fetch'> = {}): Promise<CortexdbInstall> {
  return installCortexdb({
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    check: bin => checkCortexdbBinary(bin),
    beforeSwitch: async (from, to) => {
      try { await backupBrains({ all: true }, { trigger: 'pre-upgrade' }) } catch (e) { log('warn', `memory: no backup before CortexDB ${from} -> ${to}`, { error: e }) }
    },
  })
}
