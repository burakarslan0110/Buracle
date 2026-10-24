import { describe, expect, test } from 'bun:test'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite, atomicWriteSync, ensureDir, exists, readJsonSafe, readText, renameRetrySync, sha256 } from '../../src/engine/fsx'
import { KEEPS_MODES } from '../helpers/fake-exe'
import { withSandbox } from '../helpers/sandbox'

describe('fsx', () => {
  test('atomicWrite creates parent dirs, writes bytes and leaves no temp files', () => withSandbox(async ({ root }) => {
    const p = join(root, 'a', 'b', 'c.txt')
    await atomicWrite(p, 'hello\n')
    expect(readFileSync(p, 'utf8')).toBe('hello\n')
    if (KEEPS_MODES) expect(statSync(p).mode & 0o777).toBe(0o644)
    await atomicWrite(p, new TextEncoder().encode('bytes'))
    expect(readFileSync(p, 'utf8')).toBe('bytes')
    expect(readdirSync(join(root, 'a', 'b'))).toEqual(['c.txt'])
  }))

  test('atomicWrite keeps an existing mode unless told otherwise', () => withSandbox(async ({ root }) => {
    const p = join(root, 'script.sh')
    writeFileSync(p, '#!/bin/sh\n')
    chmodSync(p, 0o750)
    await atomicWrite(p, '#!/bin/sh\necho hi\n')
    expect(readFileSync(p, 'utf8')).toBe('#!/bin/sh\necho hi\n')
    if (KEEPS_MODES) expect(statSync(p).mode & 0o777).toBe(0o750)
    await atomicWrite(p, 'x', { mode: 0o600 })
    expect(readFileSync(p, 'utf8')).toBe('x')
    if (KEEPS_MODES) expect(statSync(p).mode & 0o777).toBe(0o600)
  }))

  test('atomicWrite through a symlink keeps the link', () => withSandbox(async ({ root }) => {
    const real = join(root, 'dotfiles', 'settings.json')
    mkdirSync(join(root, 'dotfiles'))
    writeFileSync(real, '{}')
    const link = join(root, 'settings.json')
    symlinkSync('dotfiles/settings.json', link)
    await atomicWrite(link, '{"a":1}')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    // Windows may hand the target back with its own separator.
    expect(readlinkSync(link).replace(/\\/g, '/')).toBe('dotfiles/settings.json')
    expect(readFileSync(real, 'utf8')).toBe('{"a":1}')
  }))

  test('readText distinguishes missing files', () => withSandbox(async ({ root }) => {
    const r = await readText(join(root, 'nope.txt'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('missing')
    writeFileSync(join(root, 'yes.txt'), '')
    expect(await readText(join(root, 'yes.txt'))).toEqual({ ok: true, value: '' })
  }))

  test('readJsonSafe never treats a parse failure as empty', () => withSandbox(async ({ root }) => {
    const p = join(root, 'broken.json')
    writeFileSync(p, '{"a": 1,,}')
    const r = await readJsonSafe(p)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('parse')
      expect(r.error).toContain('invalid JSON')
    }
    writeFileSync(p, '{"a": [1, 2]}')
    expect(await readJsonSafe(p)).toEqual({ ok: true, value: { a: [1, 2] } })
    const m = await readJsonSafe(join(root, 'missing.json'))
    expect(m.ok === false && m.code === 'missing').toBe(true)
  }))

  test('exists, ensureDir, sha256', () => withSandbox(async ({ root }) => {
    const d = join(root, 'x', 'y')
    expect(await exists(d)).toBe(false)
    await ensureDir(d)
    await ensureDir(d)
    expect(await exists(d)).toBe(true)
    symlinkSync(join(root, 'missing-target'), join(root, 'dangling'))
    expect(await exists(join(root, 'dangling'))).toBe(true)
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  }))
})

describe('renameRetrySync', () => {
  const busy = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code })
  const flaky = (fails: number, code = 'EPERM') => {
    const calls: string[] = []
    return { calls, rename: (a: string, b: string) => { calls.push(`${a}>${b}`); if (calls.length <= fails) throw busy(code) } }
  }

  test('on Windows a rename refused while another process reads the folder (EPERM, EACCES, EBUSY) is tried again', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      const f = flaky(2, code)
      renameRetrySync('a.staging', 'a', { platform: 'win32', rename: f.rename })
      expect(f.calls).toEqual(['a.staging>a', 'a.staging>a', 'a.staging>a'])
    }
  })

  test('elsewhere, for another error, or past the budget, the error stands', () => {
    const posix = flaky(1)
    expect(() => renameRetrySync('a', 'b', { platform: 'darwin', rename: posix.rename })).toThrow(/EPERM/)
    expect(posix.calls).toHaveLength(1)
    const other = flaky(1, 'ENOENT')
    expect(() => renameRetrySync('a', 'b', { platform: 'win32', rename: other.rename })).toThrow(/ENOENT/)
    expect(other.calls).toHaveLength(1)
    const stuck = flaky(1_000)
    expect(() => renameRetrySync('a', 'b', { platform: 'win32', rename: stuck.rename, budgetMs: 200 })).toThrow(/EPERM/)
    expect(stuck.calls.length).toBeGreaterThan(1)
  })
})

describe('atomicWriteSync on a file another process holds', () => {
  const busy = (code: string) => Object.assign(new Error(`${code}: resource busy or locked, rename`), { code })
  // A rename that fails `fails` times (as Windows does while a scanner or the indexer has the target open), then works.
  function flaky(fails: number, code = 'EBUSY') {
    const calls: string[] = []
    return { calls, rename: (a: string, b: string) => { calls.push(b); if (calls.length <= fails) throw busy(code); renameSync(a, b) } }
  }

  test('on Windows the replacing rename is tried again after EPERM or EBUSY, and the file ends up with the new content', () => withSandbox(({ root }) => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      const p = join(root, `state-${code}.json`)
      writeFileSync(p, 'old')
      const f = flaky(2, code)
      const naps: number[] = []
      atomicWriteSync(p, 'new', { renameRetry: { platform: 'win32', rename: f.rename, sleep: ms => { naps.push(ms) } } })
      expect(f.calls).toEqual([p, p, p])
      expect(naps).toEqual([50, 100])
      expect(readFileSync(p, 'utf8')).toBe('new')
    }
    expect(readdirSync(root).filter(n => n.endsWith('.tmp'))).toEqual([])
  }))

  test('a rename that never succeeds, another error code or any other platform throws at once or after the budget; the old content and no temp file stay', () => withSandbox(({ root }) => {
    const p = join(root, 'state.json')
    writeFileSync(p, 'old')
    const posix = flaky(1, 'EPERM')
    expect(() => atomicWriteSync(p, 'new', { renameRetry: { platform: 'linux', rename: posix.rename } })).toThrow(/EPERM/)
    expect(posix.calls).toHaveLength(1)
    const missing = flaky(1, 'ENOENT')
    expect(() => atomicWriteSync(p, 'new', { renameRetry: { platform: 'win32', rename: missing.rename } })).toThrow(/ENOENT/)
    expect(missing.calls).toHaveLength(1)
    const stuck = flaky(1_000)
    expect(() => atomicWriteSync(p, 'new', { renameRetry: { platform: 'win32', rename: stuck.rename, budgetMs: 0, sleep: () => {} } })).toThrow(/EBUSY/)
    expect(stuck.calls).toHaveLength(1)
    expect(readFileSync(p, 'utf8')).toBe('old')
    expect(readdirSync(root).filter(n => n !== 'home')).toEqual(['state.json'])
  }))
})
