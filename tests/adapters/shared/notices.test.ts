import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { claimNotices, noticesOff, runtimeVersion, startupNotices } from '../../../src/adapters/shared/notices'
import type { Notice } from '../../../src/core/notices'
import * as paths from '../../../src/engine/paths'
import { withEnv, withSandbox } from '../../helpers/sandbox'

const NOW = Date.UTC(2026, 9, 17)
const LIST: Notice[] = [{ id: 'demo-a', since: '0.5.0', message: 'First notice.' }, { id: 'demo-b', since: '0.5.0', until: '0.6.0', message: 'Second notice.' }]
const SHARED = join(import.meta.dir, '..', '..', '..', 'src', 'adapters', 'shared', 'notices.ts')

describe('one-time notices: acknowledged once per machine (H17)', () => {
  test('the first session claims each notice; every later one, on any harness, gets nothing', () => withSandbox(() => withEnv({ BURACLE_NO_NOTICES: undefined }, () => {
    const first = startupNotices(LIST, { version: '0.5.0', nowMs: NOW, harness: 'claude' })
    expect(first?.user).toBe('Buracle 0.5.0: First notice.\nBuracle 0.5.0: Second notice.')
    expect(first?.model).toContain('- First notice.\n- Second notice.')
    expect(readdirSync(paths.noticesDir()).sort()).toEqual(['demo-a.ack', 'demo-b.ack'])
    expect(JSON.parse(readFileSync(join(paths.noticesDir(), 'demo-a.ack'), 'utf8'))).toEqual({ at: NOW, version: '0.5.0', harness: 'claude' })
    for (const harness of ['codex', 'opencode', 'omp'] as const) expect(claimNotices(LIST, { version: '0.5.0', nowMs: NOW, harness })).toEqual([])
    expect(claimNotices([...LIST, { id: 'demo-c', since: '0.5.0', message: 'Third.' }], { version: '0.5.0', nowMs: NOW, harness: 'omp' }).map(n => n.id)).toEqual(['demo-c'])
  })))

  test('sessions starting at the same moment show a notice exactly once', () => withSandbox(async ({ root }) => withEnv({ BURACLE_NO_NOTICES: undefined }, async () => {
    const script = join(root, 'claim.ts')
    writeFileSync(script, `import { claimNotices } from ${JSON.stringify(SHARED)}\nconsole.log(JSON.stringify(claimNotices(${JSON.stringify(LIST)}, { version: '0.5.0', nowMs: ${NOW}, harness: 'codex' }).map(n => n.id)))\n`)
    const procs = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } }))
    const outs = await Promise.all(procs.map(p => new Response(p.stdout).text()))
    const claimed = outs.flatMap(o => JSON.parse(o.trim()) as string[])
    expect(claimed.sort()).toEqual(['demo-a', 'demo-b'])
  })))

  test('nothing is shown without a version, outside the version range, while BURACLE_NO_NOTICES=1, or when no acknowledgement can be written', () => withSandbox(() => withEnv({ BURACLE_NO_NOTICES: undefined }, async () => {
    expect(claimNotices(LIST, { version: undefined, nowMs: NOW, harness: 'claude' })).toEqual([])
    expect(claimNotices(LIST, { version: '0.4.9', nowMs: NOW, harness: 'claude' })).toEqual([])
    expect(await withEnv({ BURACLE_NO_NOTICES: '1' }, () => claimNotices(LIST, { version: '0.5.0', nowMs: NOW, harness: 'claude' }))).toEqual([])
    expect(noticesOff({ BURACLE_NO_NOTICES: '1' })).toBe(true)
    expect(noticesOff({ BURACLE_MEMORY_RUNNER: '1' })).toBe(true)
    expect(noticesOff({})).toBe(false)
    expect(existsSync(paths.noticesDir())).toBe(false)
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      mkdirSync(paths.noticesDir(), { recursive: true })
      chmodSync(paths.noticesDir(), 0o500)
      try {
        expect(claimNotices(LIST, { version: '0.5.0', nowMs: NOW, harness: 'claude' })).toEqual([])
      } finally {
        chmodSync(paths.noticesDir(), 0o700)
      }
    }
  })))

  test('runtimeVersion reads the version of the runtime the hooks run from', () => withSandbox(({ root }) => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'buracle', version: '9.8.7' }))
    expect(runtimeVersion(root)).toBe('9.8.7')
    expect(runtimeVersion(join(root, 'missing'))).toBeUndefined()
  }))
})
