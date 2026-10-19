import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { syncTree } from '../../../src/adapters/claude/dev-build'
import { KEEPS_MODES } from '../../helpers/fake-exe'
import { withSandbox } from '../../helpers/sandbox'

describe('syncTree', () => {
  test('writes, keeps unchanged files, removes stale ones and preserves engine-owned paths', async () => {
    await withSandbox(async sb => {
      const out = join(sb.root, 'plugin')
      const files = [
        { path: 'a.json', content: '{}\n' },
        { path: 'bin/x', content: '#!/bin/sh\n', mode: 0o755 },
        { path: 'deep/dir/y.md', content: 'y\n' },
      ]
      const first = syncTree(out, files)
      expect(first.written.sort()).toEqual(['a.json', 'bin/x', 'deep/dir/y.md'])
      if (KEEPS_MODES) {
        expect(statSync(join(out, 'bin/x')).mode & 0o777).toBe(0o755)
        expect(statSync(join(out, 'a.json')).mode & 0o777).toBe(0o644)
      }

      mkdirSync(join(out, '.claude-plugin', 'types', 'claude-code'), { recursive: true })
      writeFileSync(join(out, '.claude-plugin', 'types', 'claude-code', 'index.d.ts'), '// engine\n')
      writeFileSync(join(out, 'tsconfig.json'), '{}\n')
      mkdirSync(join(out, 'old'), { recursive: true })
      writeFileSync(join(out, 'old', 'stale.ts'), 'x\n')

      const check = syncTree(out, files.slice(0, 2), { check: true })
      expect(check).toEqual({ written: [], removed: ['deep/dir/y.md', 'old/stale.ts'], unchanged: 2 })
      expect(existsSync(join(out, 'old', 'stale.ts'))).toBe(true)

      const second = syncTree(out, [{ path: 'a.json', content: '{"v":2}\n' }, files[1] as (typeof files)[number]])
      expect(second.written).toEqual(['a.json'])
      expect(second.removed.sort()).toEqual(['deep/dir/y.md', 'old/stale.ts'])
      expect(existsSync(join(out, 'deep'))).toBe(false)
      expect(existsSync(join(out, 'old'))).toBe(false)
      expect(readFileSync(join(out, '.claude-plugin', 'types', 'claude-code', 'index.d.ts'), 'utf8')).toBe('// engine\n')
      expect(existsSync(join(out, 'tsconfig.json'))).toBe(true)
      expect(readFileSync(join(out, 'a.json'), 'utf8')).toBe('{"v":2}\n')
    })
  })

  test('where the file system keeps no mode (Windows), a file with the same content is unchanged', async () => {
    await withSandbox(async sb => {
      const out = join(sb.root, 'plugin')
      const files = [{ path: 'bin/x', content: '#!/bin/sh\n', mode: 0o755 }]
      syncTree(out, files)
      chmodSync(join(out, 'bin/x'), 0o644)
      expect(syncTree(out, files, { check: true, keepsModes: false })).toEqual({ written: [], removed: [], unchanged: 1 })
      if (KEEPS_MODES) expect(syncTree(out, files, { check: true }).written).toEqual(['bin/x'])
    })
  })
})
