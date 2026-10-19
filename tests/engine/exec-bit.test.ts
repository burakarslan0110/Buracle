import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { executableBit, fileMode, knownExecutableBit } from '../../src/engine/exec-bit'
import { withSandbox } from '../helpers/sandbox'

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, env: { ...process.env }, stdout: 'ignore', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
}

function repoWithScript(root: string): { script: string, plain: string } {
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'skills', 'a', 'scripts'), { recursive: true })
  const script = join(repo, 'skills', 'a', 'scripts', 'run.sh')
  const plain = join(repo, 'skills', 'a', 'SKILL.md')
  writeFileSync(script, '#!/bin/sh\necho hi\n', { mode: 0o755 })
  writeFileSync(plain, '# a\n', { mode: 0o644 })
  git(repo, 'init', '-q')
  git(repo, 'add', '.')
  git(repo, 'update-index', '--chmod=+x', 'skills/a/scripts/run.sh')
  git(repo, 'commit', '-q', '-m', 'init')
  chmodSync(script, 0o644)
  return { script, plain }
}

describe('executableBit: the executable bit on a filesystem that does not keep one', () => {
  test('on Windows a file the git index records as 100755 is executable, whatever its file mode says', () => withSandbox((sb) => {
    const { script, plain } = repoWithScript(sb.root)
    expect(executableBit(script, statSync(script).mode, 'win32')).toBe(true)
    expect(executableBit(plain, statSync(plain).mode, 'win32')).toBe(false)
    expect(fileMode(script, statSync(script).mode, 'win32')).toBe(0o755)
    expect(fileMode(plain, statSync(plain).mode, 'win32')).toBe(0o644)
  }))

  // The modes below are given, not read: a Windows file system keeps no executable bit to read back.
  test('elsewhere the file mode decides', () => withSandbox((sb) => {
    const { script } = repoWithScript(sb.root)
    expect(executableBit(script, 0o100644, 'linux')).toBe(false)
    expect(executableBit(script, 0o100755, 'linux')).toBe(true)
    expect(fileMode(script, 0o100644, 'darwin')).toBe(0o644)
    expect(fileMode(script, 0o100755, 'darwin')).toBe(0o755)
  }))

  test('on Windows outside a git checkout the file mode decides', () => withSandbox((sb) => {
    const loose = join(sb.root, 'loose.sh')
    writeFileSync(loose, '#!/bin/sh\n')
    expect(executableBit(loose, 0o100755, 'win32')).toBe(true)
    expect(executableBit(loose, 0o100644, 'win32')).toBe(false)
  }))
})

describe('knownExecutableBit: whether anything records the bit', () => {
  test('on Windows only the git index records it: a tracked file is known, an untracked one or one outside git is not', () => withSandbox((sb) => {
    const { script, plain } = repoWithScript(sb.root)
    const fresh = join(sb.root, 'repo', 'skills', 'a', 'new.sh')
    writeFileSync(fresh, '#!/bin/sh\n')
    const loose = join(sb.root, 'loose.sh')
    writeFileSync(loose, '#!/bin/sh\n')
    expect(knownExecutableBit(script, 0o100644, 'win32')).toBe(true)
    expect(knownExecutableBit(plain, 0o100644, 'win32')).toBe(false)
    expect(knownExecutableBit(fresh, 0o100755, 'win32')).toBeUndefined()
    expect(knownExecutableBit(loose, 0o100755, 'win32')).toBeUndefined()
    expect(knownExecutableBit(fresh, 0o100755, 'darwin')).toBe(true)
    expect(knownExecutableBit(fresh, 0o100644, 'linux')).toBe(false)
  }))
})
