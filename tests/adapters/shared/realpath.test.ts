import { describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { realWriteTarget, withRealpath } from '../../../src/adapters/shared/realpath'
import { firstWord, expandParams, resolveArgv, resolveCommandLine } from '../../../src/adapters/shared/command'
import { withSandbox } from '../../helpers/sandbox'

describe('realWriteTarget', () => {
  test('resolves file links, linked parent directories, new files and dangling links', () => withSandbox(async ({ root, home }) => {
    const ssh = join(home, '.ssh')
    mkdirSync(ssh, { recursive: true })
    writeFileSync(join(ssh, 'authorized_keys'), 'k\n')
    const proj = join(root, 'proj')
    mkdirSync(proj)
    symlinkSync(join(ssh, 'authorized_keys'), join(proj, 'notes.txt'))
    symlinkSync(ssh, join(proj, 'cfg'))
    symlinkSync(join(ssh, 'authorized_keys2'), join(proj, 'dangling'))
    symlinkSync('../proj/cfg', join(proj, 'rel'))
    expect(realWriteTarget(join(proj, 'notes.txt'))).toBe(join(ssh, 'authorized_keys'))
    expect(realWriteTarget(join(proj, 'cfg', 'config'))).toBe(join(ssh, 'config'))
    expect(realWriteTarget(join(proj, 'cfg', 'new', 'deeper.txt'))).toBe(join(ssh, 'new', 'deeper.txt'))
    expect(realWriteTarget(join(proj, 'dangling'))).toBe(join(ssh, 'authorized_keys2'))
    expect(realWriteTarget(join(proj, 'rel', 'x'))).toBe(join(ssh, 'x'))
    expect(realWriteTarget(join(proj, 'plain.txt'))).toBe(join(proj, 'plain.txt'))
    expect(realWriteTarget('relative/path')).toBeUndefined()
  }))

  test('a symlink loop is unresolvable, not a hang', () => withSandbox(async ({ root }) => {
    symlinkSync(join(root, 'b'), join(root, 'a'))
    symlinkSync(join(root, 'a'), join(root, 'b'))
    expect(realWriteTarget(join(root, 'a', 'x'))).toBeUndefined()
  }))

  test('withRealpath attaches the resolver without touching the rest of the context', () => {
    const ctx = withRealpath({ cwd: '/w', home: '/h', vault: '/v', protect: [] })
    expect(ctx).toMatchObject({ cwd: '/w', home: '/h', vault: '/v', protect: [] })
    expect(ctx.realpath).toBe(realWriteTarget)
  })
})

describe('command resolution (I8 doctor checks)', () => {
  const env = { HOME: '/h', BURACLE_HOME: '/custom', EMPTY: '' }
  test('expands the shell parameter forms Buracle writes; refuses what it cannot know', () => {
    expect(expandParams('${BURACLE_HOME:-$HOME/.buracle}/bin/buracle', env)).toBe('/custom/bin/buracle')
    expect(expandParams('${BURACLE_HOME:-$HOME/.buracle}/bin/buracle', { HOME: '/h' })).toBe('/h/.buracle/bin/buracle')
    expect(expandParams('${EMPTY:-x}', env)).toBe('x')
    expect(expandParams('${EMPTY-x}', env)).toBe('')
    expect(expandParams('${HOME}/a', env)).toBe('/h/a')
    expect(expandParams('$NOPE/a', env)).toBeUndefined()
    expect(expandParams('$(whoami)/a', env)).toBeUndefined()
    expect(expandParams('`id`', env)).toBeUndefined()
  })

  test('first words and argv wrappers', () => {
    expect(firstWord('"${BURACLE_HOME:-$HOME/.buracle}/bin/buracle" hook codex Stop', env)).toBe('/custom/bin/buracle')
    expect(firstWord("'/a b/x' --y", env)).toBe('/a b/x')
    expect(firstWord('~/bin/tool --x', env)).toBe('/h/bin/tool')
    expect(firstWord('exec "$HOME/x" "$@"', env)).toBe('/h/x')
    expect(resolveCommandLine('"/definitely/missing/buracle" hook codex Stop', env)).toEqual({ program: '/definitely/missing/buracle' })
    expect(resolveArgv(['/bin/sh', '-c', 'exec "${BURACLE_HOME:-$HOME/.buracle}/bin/buracle" "$@"', 'buracle', 'mcp'], env)).toEqual({ program: '/custom/bin/buracle' })
    expect(resolveArgv(['/bin/sh'], env).executable).toBe('/bin/sh')
  })
})
