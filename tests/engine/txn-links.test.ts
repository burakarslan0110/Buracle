import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { linkDirSync, readLinkSync } from '../../src/engine/fsx'
import { applyPlans, readLedger, rollback, txnTestHooks, type Op, type Plan } from '../../src/engine/txn'
import { withSandbox } from '../helpers/sandbox'

const OWNER = 'test'

function plan(ops: Op[]): Plan {
  return { id: 'p', harness: 'core', ops }
}

function link(path: string, target: string): void {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path)
}

// Windows reads a link made to '/shim' back as '\shim', and 'a/b' as 'a\b': the links below are spelled that way.
describe('symlink targets on a file system that stores them with backslashes (Windows)', () => {
  afterEach(() => { delete txnTestHooks.windowsLinks })

  test('a link the user already had is adopted, so uninstall leaves it alone', () => withSandbox(async (sb) => {
    txnTestHooks.windowsLinks = true
    const p = join(sb.home, '.local', 'bin', 'buracle')
    link(p, '\\shim')
    const r1 = await applyPlans([plan([{ kind: 'symlink', path: p, target: '/shim', owner: OWNER }])])
    expect(r1.conflicts).toEqual([])
    expect(Object.values(await readLedger()).map(e => e.adopted)).toEqual([true])
    const r2 = await applyPlans([plan([{ kind: 'remove', path: p, owner: OWNER }])])
    expect(r2.conflicts).toEqual([])
    expect(r2.skipped.map(s => s.reason).join('\n')).toMatch(/never wrote/)
    expect(lstatSync(p).isSymbolicLink()).toBe(true)
  }))

  test('a link Buracle wrote stays its own when it reads back with backslashes: unchanged, verified, rolled back and removed', () => withSandbox(async (sb) => {
    txnTestHooks.windowsLinks = true
    const p = join(sb.home, '.local', 'bin', 'buracle')
    const op: Op = { kind: 'symlink', path: p, target: '/opt/buracle/bin/buracle', owner: OWNER }
    const r1 = await applyPlans([plan([op])])
    expect(r1.applied).toBe(1)
    unlinkSync(p)
    link(p, '\\opt\\buracle\\bin\\buracle')
    expect((await applyPlans([plan([op])])).txn).toBe('')
    await rollback(r1.txn)
    expect(() => lstatSync(p)).toThrow()

    const r3 = await applyPlans([plan([{ ...op, target: '\\\\?\\C:\\buracle\\bin\\buracle' }])])
    expect(r3.applied).toBe(1)
    expect(readlinkSync(p).replace(/\\/g, '/')).toBe('C:/buracle/bin/buracle')
    unlinkSync(p)
    link(p, 'C:\\buracle\\bin\\buracle')
    const r4 = await applyPlans([plan([{ kind: 'remove', path: p, owner: OWNER }])])
    expect(r4.conflicts).toEqual([])
    expect(r4.applied).toBe(1)
    expect(() => lstatSync(p)).toThrow()
  }))

  // Spelled here as Windows reports such links; on Windows itself the file system picks the spelling.
  test.skipIf(process.platform === 'win32')('a target behind the \\\\?\\ prefix is the same path; a rollback recreates a link exactly as it was spelled', () => withSandbox(async (sb) => {
    txnTestHooks.windowsLinks = true
    const p = join(sb.home, '.local', 'bin', 'buracle')
    link(p, '\\\\?\\X:\\tools\\shim')
    const r1 = await applyPlans([plan([{ kind: 'symlink', path: p, target: 'X:/tools/shim', owner: OWNER }])])
    expect(r1.conflicts).toEqual([])
    expect(Object.values(await readLedger()).map(e => e.adopted)).toEqual([true])

    const ours = join(sb.home, 'ours')
    const r2 = await applyPlans([plan([{ kind: 'symlink', path: ours, target: 'X:/tools/shim', owner: OWNER }])])
    expect(r2.applied).toBe(1)
    unlinkSync(ours)
    link(ours, '\\\\?\\X:\\tools\\shim')
    const r3 = await applyPlans([plan([{ kind: 'symlink', path: ours, target: 'X:/tools/next', owner: OWNER }])])
    expect(r3.applied).toBe(1)
    expect(readlinkSync(ours)).toBe('X:\\tools\\next')
    await rollback(r3.txn)
    expect(readlinkSync(ours)).toBe('\\\\?\\X:\\tools\\shim')
  }))

  test.skipIf(process.platform === 'win32')('where targets are stored as written, a backslash is part of the target', () => withSandbox(async (sb) => {
    txnTestHooks.windowsLinks = false
    const p = join(sb.home, '.local', 'bin', 'buracle')
    link(p, '\\shim')
    const r = await applyPlans([plan([{ kind: 'symlink', path: p, target: '/shim', owner: OWNER }])])
    expect(r.conflicts.length).toBe(1)
    expect(readlinkSync(p)).toBe('\\shim')
  }))
})

// A user without administrator rights or Developer Mode cannot make a symbolic link on Windows, but always a junction.
describe.if(process.platform === 'win32')('directory links on Windows are junctions', () => {
  const linkType = (p: string): string => Bun.spawnSync(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `(Get-Item -LiteralPath '${p.replace(/'/g, "''")}' -Force).LinkType`], { stdout: 'pipe', stderr: 'ignore', env: { ...process.env } }).stdout.toString().trim()

  test('a directory link in a transaction is a junction that verifies, reads back its target and rolls back to nothing', () => withSandbox(async (sb) => {
    const target = join(sb.root, 'skills-src', 'plan-build')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), 'skill\n')
    const p = join(sb.home, '.agents', 'skills', 'plan-build')
    const r = await applyPlans([plan([{ kind: 'symlink', path: p, target, owner: OWNER }])])
    expect(r.conflicts).toEqual([])
    expect(linkType(p)).toBe('Junction')
    expect(lstatSync(p).isSymbolicLink()).toBe(true)
    expect(readLinkSync(p).toLowerCase()).toBe(target.toLowerCase())
    expect(readFileSync(join(p, 'SKILL.md'), 'utf8')).toBe('skill\n')
    await rollback(r.txn)
    expect(existsSync(p)).toBe(false)
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('skill\n')
  }))

  test('removing a junction, or a folder that holds one, never deletes what it points at', () => withSandbox(async (sb) => {
    const target = join(sb.root, 'keep')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'file.txt'), 'x')
    const holder = join(sb.root, 'holder')
    mkdirSync(holder)
    linkDirSync(target, join(holder, 'j1'))
    linkDirSync(target, join(sb.root, 'j2'))
    expect(linkType(join(sb.root, 'j2'))).toBe('Junction')
    rmSync(join(sb.root, 'j2'), { recursive: true, force: true })
    rmSync(holder, { recursive: true, force: true })
    expect(existsSync(holder)).toBe(false)
    expect(readFileSync(join(target, 'file.txt'), 'utf8')).toBe('x')
  }))
})
