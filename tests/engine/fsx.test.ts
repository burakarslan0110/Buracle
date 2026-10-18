import { describe, expect, test } from 'bun:test'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite, ensureDir, exists, readJsonSafe, readText, sha256 } from '../../src/engine/fsx'
import { withSandbox } from '../helpers/sandbox'

describe('fsx', () => {
  test('atomicWrite creates parent dirs, writes bytes and leaves no temp files', () => withSandbox(async ({ root }) => {
    const p = join(root, 'a', 'b', 'c.txt')
    await atomicWrite(p, 'hello\n')
    expect(readFileSync(p, 'utf8')).toBe('hello\n')
    expect(statSync(p).mode & 0o777).toBe(0o644)
    await atomicWrite(p, new TextEncoder().encode('bytes'))
    expect(readFileSync(p, 'utf8')).toBe('bytes')
    expect(readdirSync(join(root, 'a', 'b'))).toEqual(['c.txt'])
  }))

  test('atomicWrite keeps an existing mode unless told otherwise', () => withSandbox(async ({ root }) => {
    const p = join(root, 'script.sh')
    writeFileSync(p, '#!/bin/sh\n')
    chmodSync(p, 0o750)
    await atomicWrite(p, '#!/bin/sh\necho hi\n')
    expect(statSync(p).mode & 0o777).toBe(0o750)
    await atomicWrite(p, 'x', { mode: 0o600 })
    expect(statSync(p).mode & 0o777).toBe(0o600)
  }))

  test('atomicWrite through a symlink keeps the link', () => withSandbox(async ({ root }) => {
    const real = join(root, 'dotfiles', 'settings.json')
    mkdirSync(join(root, 'dotfiles'))
    writeFileSync(real, '{}')
    const link = join(root, 'settings.json')
    symlinkSync('dotfiles/settings.json', link)
    await atomicWrite(link, '{"a":1}')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe('dotfiles/settings.json')
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
