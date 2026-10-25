import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pruneDeadReaders } from './cortex'
import { locksDir } from './layout'
import { removeDeadLock } from './lock'

const DEAD_LOCK_AGE_MS = 24 * 3600_000

/**
 * Removes what a killed process left behind: lock files and CortexDB reader entries whose owner is gone (older than a day),
 * and the marker files older Buracle versions wrote next to them. The session-end finalizer runs it; nothing else does.
 * Returns how many files it removed.
 */
export function removeDeadLocks(now: number = Date.now()): number {
  let names: string[] = []
  try { names = readdirSync(locksDir()) } catch { return 0 }
  let n = 0
  for (const name of names) {
    const p = join(locksDir(), name)
    try {
      const st = statSync(p)
      if (!st.isFile()) continue
      if ((name.startsWith('finalize-spawn-') && name.endsWith('.json')) || name.startsWith('kick-')) {
        if (now - st.mtimeMs > DEAD_LOCK_AGE_MS) { try { unlinkSync(p); n++ } catch {  } }
        continue
      }
      if (name.endsWith('.lock') && removeDeadLock(p, DEAD_LOCK_AGE_MS, now)) n++
    } catch {  }
  }
  return n + pruneDeadReaders()
}
