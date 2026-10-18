import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { lockTestHooks } from '../../src/engine/lockfile'
import * as paths from '../../src/engine/paths'
import { releaseToolchainLock, takeToolchainLock, toolchainLockFile } from '../../src/engine/toolchain/index'
import { applyPlans, withTxnLock } from '../../src/engine/txn'
import { tryLock } from '../../src/memory/lock'
import { withSandbox } from '../helpers/sandbox'

function deadPid(): number {
  return Bun.spawnSync(['true'], { env: { ...process.env } }).pid
}

function liveHolder(): { pid: number, stop: () => void } {
  const child = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 60000)'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: { ...process.env } })
  return { pid: child.pid, stop: () => child.kill() }
}

function racerTakes(path: string, text: string): void {
  let done = false
  lockTestHooks.beforeBreak = p => {
    if (done || p !== path) return
    done = true
    unlinkSync(path)
    writeFileSync(path, text, { flag: 'wx' })
  }
}

afterEach(() => { delete lockTestHooks.beforeBreak })

describe('stale lock breaking (O11)', () => {
  test('memory/lock tryLock: the slower waiter never deletes the lock the faster one took after breaking the stale one', () => withSandbox(async ({ root }) => {
    const lock = join(root, 'state.json.lock')
    writeFileSync(lock, JSON.stringify({ pid: deadPid(), at: new Date().toISOString() }))
    const holder = liveHolder()
    try {
      const fresh = JSON.stringify({ pid: holder.pid, at: new Date().toISOString(), token: 'faster' })
      racerTakes(lock, fresh)
      expect(tryLock(lock, 60_000)).toBeUndefined()
      expect(readFileSync(lock, 'utf8')).toBe(fresh)
    } finally {
      holder.stop()
    }
  }))

  test('memory/lock tryLock: a stale lock nobody races for is still broken and taken', () => withSandbox(async ({ root }) => {
    const lock = join(root, 'a.lock')
    writeFileSync(lock, JSON.stringify({ pid: deadPid(), at: new Date().toISOString() }))
    const release = tryLock(lock, 60_000)
    expect(release).toBeDefined()
    release?.()
    expect(existsSync(lock)).toBe(false)
  }))

  test('memory/lock release: a holder whose lock was broken and taken over does not delete the new holder\'s lock', () => withSandbox(async ({ root }) => {
    const lock = join(root, 'b.lock')
    const release = tryLock(lock, 60_000)
    expect(release).toBeDefined()
    unlinkSync(lock)
    const theirs = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: 'theirs' })
    writeFileSync(lock, theirs)
    release?.()
    expect(readFileSync(lock, 'utf8')).toBe(theirs)
  }))

  test('the transaction lock: a racer that took the lock after breaking the stale one keeps it', () => withSandbox(async ({ home }) => {
    const lock = paths.txnLockFile()
    mkdirSync(dirname(lock), { recursive: true })
    writeFileSync(lock, JSON.stringify({ pid: deadPid() }) + '\n')
    const holder = liveHolder()
    try {
      const fresh = JSON.stringify({ pid: holder.pid }) + '\n'
      racerTakes(lock, fresh)
      await expect(applyPlans([{ id: 't', harness: 'core', ops: [{ kind: 'file', path: join(home, 'x'), content: 'x', owner: 'core' }] }])).rejects.toThrow(/another Buracle transaction is running/)
      expect(readFileSync(lock, 'utf8')).toBe(fresh)
      expect(existsSync(join(home, 'x'))).toBe(false)
    } finally {
      holder.stop()
    }
  }))

  test('the transaction lock: releasing never deletes a lock another process holds now', () => withSandbox(async () => {
    const lock = paths.txnLockFile()
    const theirs = JSON.stringify({ pid: process.pid, startedAt: 1, note: 'theirs' }) + '\n'
    await withTxnLock(async () => {
      unlinkSync(lock)
      writeFileSync(lock, theirs)
    })
    expect(readFileSync(lock, 'utf8')).toBe(theirs)
  }))

  test('the toolchain lock: the slower waiter does not take over a lock the faster one took', () => withSandbox(async () => {
    const lock = toolchainLockFile()
    mkdirSync(dirname(lock), { recursive: true })
    writeFileSync(lock, JSON.stringify({ pid: deadPid(), at: Date.now() }))
    const holder = liveHolder()
    try {
      const fresh = JSON.stringify({ pid: holder.pid, at: Date.now() })
      racerTakes(lock, fresh)
      expect(takeToolchainLock(Date.now())).toBe(false)
      expect(readFileSync(lock, 'utf8')).toBe(fresh)
      releaseToolchainLock()
      expect(readFileSync(lock, 'utf8')).toBe(fresh)
    } finally {
      holder.stop()
    }
  }))
})
