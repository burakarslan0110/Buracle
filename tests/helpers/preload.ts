import { afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { accountHome } from '../../src/engine/platform'
import { diffFingerprints, fingerprintHome, type Fingerprint } from './fingerprint'
import { ISOLATED_ENV, realPath, TEST_DEFAULT_ENV } from './sandbox'

export interface RealHomeGuard { homes: string[]; before: Record<string, Fingerprint>; runRoot: string }

declare global {
  var __BURACLE_REAL_HOME_GUARD__: RealHomeGuard | undefined
}

if (globalThis.__BURACLE_REAL_HOME_GUARD__ === undefined) {
  const homes = [...new Set([accountHome(), userInfo().homedir, process.env['HOME']].filter((h): h is string => typeof h === 'string' && h !== ''))]
  const before: Record<string, Fingerprint> = {}
  for (const h of homes) before[h] = fingerprintHome(h)

  const runRoot = realPath(mkdtempSync(join(realPath(tmpdir()), 'buracle-test-run-')))
  const home = join(runRoot, 'home')
  mkdirSync(home, { recursive: true })
  for (const k of Object.keys(process.env)) if (k.startsWith('XDG_')) delete process.env[k]
  for (const k of ISOLATED_ENV) delete process.env[k]
  process.env['HOME'] = home
  process.env['BURACLE_HOME'] = join(home, '.buracle')
  for (const [k, v] of Object.entries(TEST_DEFAULT_ENV)) process.env[k] = v
  const fakeBin = join(import.meta.dir, '..', 'fixtures', 'cortexdb', 'fake-cortexdb.ts')
  process.env['BURACLE_CORTEXDB_BIN'] = process.env['BURACLE_CORTEXDB_SMOKE'] !== undefined && process.env['BURACLE_CORTEXDB_SMOKE'] !== '' ? process.env['BURACLE_CORTEXDB_SMOKE'] : fakeBin

  globalThis.__BURACLE_REAL_HOME_GUARD__ = { homes, before, runRoot }

  afterAll(() => {
    const guard = globalThis.__BURACLE_REAL_HOME_GUARD__
    if (!guard) return
    try { rmSync(guard.runRoot, { recursive: true, force: true }) } catch {  }
    const problems: string[] = []
    for (const h of guard.homes) {
      const diff = diffFingerprints(guard.before[h] ?? {}, fingerprintHome(h))
      if (diff.length > 0) problems.push(`${h}:\n  ${diff.slice(0, 20).join('\n  ')}`)
    }
    if (problems.length > 0) throw new Error(`tests modified the real home directory:\n${problems.join('\n')}`)
  })
}
