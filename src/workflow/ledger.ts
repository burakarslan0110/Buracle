import { join } from 'node:path'
import type { Harness } from '../core/events'
import type { UsageLedger } from '../core/policy/usage'
import { emptyLedger, parseLedger } from '../core/policy/usage'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../engine/fsx'
import { log } from '../engine/log'
import { sessionDir } from '../engine/paths'
import { withFileLock } from './session-store'

export function ledgerPath(h: Harness, sid: string): string {
  return join(sessionDir(h, sid), 'ledger.json')
}

export function loadLedger(h: Harness, sid: string): UsageLedger {
  const r = readJsonSafeSync<unknown>(ledgerPath(h, sid))
  if (!r.ok) {
    if (r.code !== 'missing') log('warn', 'usage ledger unreadable; starting empty', { h, sid, error: r.error })
    return emptyLedger()
  }
  return parseLedger(r.value)
}

function save(h: Harness, sid: string, l: UsageLedger): void {
  ensureDirSync(sessionDir(h, sid))
  atomicWriteSync(ledgerPath(h, sid), JSON.stringify(l) + '\n')
}

export function updateLedger(h: Harness, sid: string, fn: (l: UsageLedger) => UsageLedger, opts: { timeoutMs?: number, staleMs?: number } = {}): UsageLedger {
  ensureDirSync(sessionDir(h, sid))
  const file = ledgerPath(h, sid)
  return withFileLock(file, () => {
    const cur = loadLedger(h, sid)
    const next = fn(cur)
    if (next !== cur) save(h, sid, next)
    return next
  }, opts.timeoutMs ?? 2000, opts.staleMs ?? 10_000)
}

export function resetLedger(h: Harness, sid: string): void {
  try {
    updateLedger(h, sid, () => emptyLedger())
  } catch (e) {
    log('warn', 'usage ledger not reset', { h, sid, error: e })
  }
}
