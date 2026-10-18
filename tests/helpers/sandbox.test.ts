import { describe, expect, test } from 'bun:test'
import { run } from '../../src/engine/proc'
import { ISOLATED_ENV, TEST_DEFAULT_ENV, withEnv, withSandbox } from './sandbox'

const SESSION_VARS = ['BURACLE_SESSION_ID', 'BURACLE_HARNESS', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'OPENCODE_SESSION_ID', 'OMP_SESSION_ID']

describe('withSandbox', () => {
  test('clears session-resolution variables and restores them afterwards', async () => {
    for (const k of SESSION_VARS) expect(ISOLATED_ENV).toContain(k)
    const outside = Object.fromEntries(SESSION_VARS.map(k => [k, `outer-${k}`]))
    await withEnv(outside, () => withSandbox(() => {
      for (const k of SESSION_VARS) expect(process.env[k]).toBeUndefined()
    }))
    await withEnv(outside, async () => {
      await withSandbox(() => undefined)
      for (const k of SESSION_VARS) expect(process.env[k]).toBe(`outer-${k}`)
    })
  })

  test('the run-wide preload already cleared them', () => {
    for (const k of SESSION_VARS) expect(process.env[k]).toBeUndefined()
  })

  test('the preload sets the quiet defaults; withSandbox keeps them and child processes inherit them', async () => {
    expect(TEST_DEFAULT_ENV).toEqual({ BURACLE_NO_NOTIFY: '1', BURACLE_NO_CAPTURE: '1', BURACLE_NO_TOOLCHAIN: '1', BURACLE_NO_AUTOSTART: '1', BURACLE_NO_DISTILL: '1', BURACLE_NO_REFLECT: '1', BURACLE_NO_VERIFY: '1', BURACLE_NO_EMBED: '1', BURACLE_NO_NOTICES: '1', BURACLE_RUNTIME: 'checkout' })
    for (const [k, v] of Object.entries(TEST_DEFAULT_ENV)) {
      expect(ISOLATED_ENV).not.toContain(k)
      expect(process.env[k]).toBe(v)
    }
    await withSandbox(async () => {
      for (const [k, v] of Object.entries(TEST_DEFAULT_ENV)) expect(process.env[k]).toBe(v)
      const child = await run(['/bin/sh', '-c', 'printf "%s %s %s %s %s %s %s %s %s" "$BURACLE_NO_NOTIFY" "$BURACLE_NO_CAPTURE" "$BURACLE_NO_TOOLCHAIN" "$BURACLE_NO_AUTOSTART" "$BURACLE_NO_DISTILL" "$BURACLE_NO_REFLECT" "$BURACLE_NO_VERIFY" "$BURACLE_NO_EMBED" "$BURACLE_NO_NOTICES"'], { timeoutMs: 10_000 })
      expect(child.stdout).toBe('1 1 1 1 1 1 1 1 1')
    })
    await withEnv({ BURACLE_NO_CAPTURE: undefined }, () => expect(process.env['BURACLE_NO_CAPTURE']).toBeUndefined())
    expect(process.env['BURACLE_NO_CAPTURE']).toBe('1')
  })
})
