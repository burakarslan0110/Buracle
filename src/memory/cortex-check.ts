import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cortexQuery, fromCortex, toCortexSave, type MemItem } from '../core/memory/brain'
import { CORTEXDB_BIN_ENV, installCortexdb, type CortexdbInstall, type CortexdbInstallOptions } from '../engine/toolchain/cortexdb'
import { log } from '../engine/log'
import { backupBrains } from './backup'
import { CortexClient } from './cortex'

// A new CortexDB binary is used only after it does in a throwaway database what the memory does with it: save,
// read, list, find and delete one memory, through the five tools Buracle calls.
export async function checkCortexdbBinary(bin: string, timeoutMs = 30_000): Promise<{ ok: true } | { ok: false, error: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'buracle-cortexdb-check-'))
  const client = new CortexClient(join(dir, 'check.db'), { env: { ...process.env, [CORTEXDB_BIN_ENV]: bin }, timeoutMs })
  const now = new Date().toISOString()
  const item: MemItem = {
    id: 'cortexdb-upgrade-check', kind: 'knowledge', layer: 'project', title: 'CortexDB upgrade check', summary: 'a throwaway memory',
    body: 'zebrafinch', tags: [], sources: [], about: [], status: 'active', review: 'pending', importance: 3, created: now, updated: now,
    author: 'buracle', version: 1, history: [],
  }
  try {
    await client.call('memory_save', toCortexSave(item))
    const got = await client.call<{ memory?: unknown }>('memory_get', { memory_id: item.id })
    if (fromCortex(got.memory, 'project')?.title !== item.title) return { ok: false, error: 'memory_get did not return the saved memory' }
    const all = await client.call<{ memories?: unknown[] }>('memory_list_all', { limit: 10 })
    if (!(all.memories ?? []).some(m => fromCortex(m, 'project')?.id === item.id)) return { ok: false, error: 'memory_list_all did not list the saved memory' }
    const found = await client.call<{ results?: Array<{ memory?: unknown }> }>('memory_search', cortexQuery('zebrafinch', 5))
    if (!(found.results ?? []).some(r => fromCortex(r.memory, 'project')?.id === item.id)) return { ok: false, error: 'memory_search did not find the saved memory' }
    await client.call('memory_delete', { memory_id: item.id })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    await client.close()
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {  }
  }
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
