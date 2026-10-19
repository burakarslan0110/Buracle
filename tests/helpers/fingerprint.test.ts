import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { diffFingerprints, fingerprintHome } from './fingerprint'
import { withSandbox } from './sandbox'

describe('fingerprintHome', () => {
  test('detects content, mode, creation, deletion and link changes', () => withSandbox(({ root }) => {
    const home = join(root, 'fake-home')
    mkdirSync(join(home, '.claude', 'skills', 'x'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), '{}')
    writeFileSync(join(home, '.claude', 'skills', 'x', 'SKILL.md'), 'a')
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    symlinkSync('/one', join(home, '.local', 'bin', 'buracle'))
    const base = fingerprintHome(home)
    expect(base['.codex/config.toml']).toBe('missing')
    expect(diffFingerprints(base, fingerprintHome(home))).toEqual([])

    writeFileSync(join(home, '.claude', 'settings.json'), '{"x":1}')
    // Read-only is the one mode change Windows keeps too.
    chmodSync(join(home, '.claude', 'skills', 'x', 'SKILL.md'), 0o444)
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'config.toml'), 'a = 1\n')
    unlinkSync(join(home, '.local', 'bin', 'buracle'))
    symlinkSync('/two', join(home, '.local', 'bin', 'buracle'))
    const diff = diffFingerprints(base, fingerprintHome(home))
    expect(diff.map(d => d.split(':')[0])).toEqual([
      '.claude/settings.json',
      '.claude/skills/x/SKILL.md',
      '.codex/config.toml',
      '.local/bin/buracle',
    ])
    chmodSync(join(home, '.claude', 'skills', 'x', 'SKILL.md'), 0o644)
    rmSync(join(home, '.claude', 'skills'), { recursive: true })
    expect(diffFingerprints(base, fingerprintHome(home)).some(d => d.startsWith('.claude/skills/x/SKILL.md: file') && d.endsWith('(absent)'))).toBe(true)
  }))

  test('ignores volatile files', () => withSandbox(({ root }) => {
    const home = join(root, 'fake-home')
    mkdirSync(join(home, '.config', 'opencode', 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(home, 'Documents', 'Buracle', '.obsidian'), { recursive: true })
    const base = fingerprintHome(home)
    writeFileSync(join(home, '.config', 'opencode', 'node_modules', 'pkg', 'index.js'), 'x')
    writeFileSync(join(home, '.config', 'opencode', 'package.json'), '{}')
    writeFileSync(join(home, 'Documents', 'Buracle', '.obsidian', 'workspace.json'), '{}')
    expect(diffFingerprints(base, fingerprintHome(home))).toEqual([])
    writeFileSync(join(home, 'Documents', 'Buracle', 'note.md'), 'x')
    expect(diffFingerprints(base, fingerprintHome(home))).toEqual(['Documents/Buracle/note.md: (absent) -> ' + fingerprintHome(home)['Documents/Buracle/note.md']])
  }))
})
