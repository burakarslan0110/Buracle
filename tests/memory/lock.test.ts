import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lockHeld, removeDeadLock, tryLock } from '../../src/memory/lock'
import { withSandbox } from '../helpers/sandbox'

const DEAD_PID = 2_000_000_000

describe('locks', () => {
  test('a heartbeat keeps the lock held past staleMs; without one it is broken by age', async () => {
    await withSandbox(async sb => {
      const beat = join(sb.root, 'locks', 'beat.lock')
      const release = tryLock(beat, 300, { heartbeat: true })
      expect(release).toBeDefined()
      await Bun.sleep(700)
      expect(tryLock(beat, 300)).toBeUndefined()
      expect(lockHeld(beat, 300)).toBe(true)
      release?.()
      expect(existsSync(beat)).toBe(false)

      const still = join(sb.root, 'locks', 'still.lock')
      const first = tryLock(still, 300)
      expect(first).toBeDefined()
      await Bun.sleep(500)
      const second = tryLock(still, 300)
      expect(second).toBeDefined()
      second?.()
      first?.()
    })
  })

  test('removeDeadLock removes an old lock of a dead owner and keeps young or live ones', async () => {
    await withSandbox(async sb => {
      const dir = join(sb.root, 'locks')
      mkdirSync(dir, { recursive: true })
      const old = new Date(Date.now() - 2 * 86_400_000)
      const dead = join(dir, 'dead.lock')
      writeFileSync(dead, JSON.stringify({ pid: DEAD_PID, at: old.toISOString(), token: 'x' }))
      utimesSync(dead, old, old)
      const young = join(dir, 'young.lock')
      writeFileSync(young, JSON.stringify({ pid: DEAD_PID, at: new Date().toISOString(), token: 'y' }))
      const live = join(dir, 'live.lock')
      writeFileSync(live, JSON.stringify({ pid: process.pid, at: old.toISOString(), token: 'z' }))
      utimesSync(live, old, old)
      expect(removeDeadLock(dead, 86_400_000)).toBe(true)
      expect(removeDeadLock(young, 86_400_000)).toBe(false)
      expect(removeDeadLock(live, 86_400_000)).toBe(false)
      expect([existsSync(dead), existsSync(young), existsSync(live)]).toEqual([false, true, true])
    })
  })
})
