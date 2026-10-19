import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { lockTestHooks, lookUpProcess } from '../../src/engine/lockfile'
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

afterEach(() => {
  delete lockTestHooks.beforeBreak
  delete lockTestHooks.lookUpProcess
})

describe('who holds a lock', () => {
  test('on Windows the start time and image name come from PowerShell, since there is no ps', () => {
    const calls: string[][] = []
    const seen = lookUpProcess(4242, { os: 'win32', run: argv => { calls.push(argv); return '1729281234567 bun\r\n' } })
    expect(seen).toEqual({ startedAt: 1729281234567, command: 'bun' })
    expect(calls[0]?.[0]).toBe('powershell.exe')
    expect(calls[0]?.at(-1)).toContain('Get-Process -Id 4242')
    expect(lookUpProcess(4242, { os: 'win32', run: () => undefined })).toBeUndefined()
    expect(lookUpProcess(4242, { os: 'win32', run: () => 'Get-Process : Cannot find a process\r\n' })).toBeUndefined()
  })

  test('elsewhere ps gives the elapsed time and the command line', () => {
    expect(lookUpProcess(7, { os: 'darwin', nowMs: 100_000_000, run: () => '  01:01:05 bun /x/main.ts install\n' })).toEqual({ startedAt: 100_000_000 - 3665_000, command: 'bun /x/main.ts install' })
    expect(lookUpProcess(7, { os: 'linux', run: () => '' })).toBeUndefined()
  })

  const attempt = (home: string) => applyPlans([{ id: 't', harness: 'core', ops: [{ kind: 'file', path: join(home, 'x'), content: 'x', owner: 'core' }] }])

  test('the transaction lock: a live holder nobody can identify blocks only for a while, never forever', () => withSandbox(async ({ home }) => {
    const lock = paths.txnLockFile()
    mkdirSync(dirname(lock), { recursive: true })
    const holder = liveHolder()
    try {
      lockTestHooks.lookUpProcess = () => undefined
      writeFileSync(lock, JSON.stringify({ pid: holder.pid, startedAt: Date.now() - 1000 }) + '\n')
      await expect(attempt(home)).rejects.toThrow(/another Buracle transaction is running/)
      const old = (Date.now() - 20 * 60_000) / 1000
      utimesSync(lock, old, old)
      expect((await attempt(home)).applied).toBe(1)
    } finally {
      holder.stop()
    }
  }))

  test('the transaction lock: a reused PID (another start time) is taken over, the same start time blocks', () => withSandbox(async ({ home }) => {
    const lock = paths.txnLockFile()
    mkdirSync(dirname(lock), { recursive: true })
    const holder = liveHolder()
    const startedAt = Date.now() - 60_000
    try {
      lockTestHooks.lookUpProcess = () => ({ startedAt, command: 'bun' })
      writeFileSync(lock, JSON.stringify({ pid: holder.pid, startedAt }) + '\n')
      await expect(attempt(home)).rejects.toThrow(/another Buracle transaction is running/)
      writeFileSync(lock, JSON.stringify({ pid: holder.pid, startedAt: startedAt - 3_600_000 }) + '\n')
      expect((await attempt(home)).applied).toBe(1)
    } finally {
      holder.stop()
    }
  }))
})

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
