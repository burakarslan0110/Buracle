import { describe, expect, test } from 'bun:test'
import { userInfo } from 'node:os'
import { accountHome } from '../src/engine/platform'
import { diffFingerprints, fingerprintHome } from './helpers/fingerprint'

describe('real home', () => {
  test('tests ran with a sandboxed HOME', () => {
    const guard = globalThis.__BURACLE_REAL_HOME_GUARD__
    expect(guard).toBeDefined()
    expect(process.env['HOME']).not.toBe(userInfo().homedir)
    expect(process.env['HOME']).not.toBe(accountHome())
    expect(process.env['BURACLE_HOME']?.startsWith(guard?.runRoot ?? '\0')).toBe(true)
  })

  test('~/.claude, ~/.codex, ~/.config/opencode, ~/.omp, ~/.agents, ~/.buracle and the vault are untouched', () => {
    const guard = globalThis.__BURACLE_REAL_HOME_GUARD__
    if (!guard) throw new Error('tests/helpers/preload.ts did not run (bunfig.toml [test].preload)')
    for (const home of guard.homes) {
      const diff = diffFingerprints(guard.before[home] ?? {}, fingerprintHome(home))
      expect(diff).toEqual([])
    }
  })
})
