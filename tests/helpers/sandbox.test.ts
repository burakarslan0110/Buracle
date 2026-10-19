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

  test('a CI runner\'s Homebrew switches do not reach the tests', () => {
    for (const k of ['HOMEBREW_NO_AUTO_UPDATE', 'HOMEBREW_NO_ENV_HINTS']) expect(ISOLATED_ENV).toContain(k)
  })

  test('the preload sets the quiet defaults; withSandbox keeps them and child processes inherit them', async () => {
    expect(TEST_DEFAULT_ENV).toEqual({ BURACLE_NO_NOTIFY: '1', BURACLE_NO_CAPTURE: '1', BURACLE_NO_TOOLCHAIN: '1', BURACLE_NO_AUTOSTART: '1', BURACLE_NO_DISTILL: '1', BURACLE_NO_REFLECT: '1', BURACLE_NO_VERIFY: '1', BURACLE_NO_EMBED: '1', BURACLE_NO_NOTICES: '1', BURACLE_RUNTIME: 'checkout', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', GIT_CONFIG_NOSYSTEM: '1' })
    for (const [k, v] of Object.entries(TEST_DEFAULT_ENV)) {
      expect(ISOLATED_ENV).not.toContain(k)
      expect(process.env[k]).toBe(v)
    }
    await withSandbox(async () => {
      for (const [k, v] of Object.entries(TEST_DEFAULT_ENV)) expect(process.env[k]).toBe(v)
      const keys = Object.keys(TEST_DEFAULT_ENV)
      const child = await run([process.execPath, '-e', `process.stdout.write(${JSON.stringify(keys)}.map(k => process.env[k]).join(' '))`], { timeoutMs: 10_000 })
      expect(child.stdout).toBe(Object.values(TEST_DEFAULT_ENV).join(' '))
    })
    await withEnv({ BURACLE_NO_CAPTURE: undefined }, () => expect(process.env['BURACLE_NO_CAPTURE']).toBeUndefined())
    expect(process.env['BURACLE_NO_CAPTURE']).toBe('1')
  })

  test('a quiet default that went missing comes back at the next withSandbox or withEnv, except where a withEnv controls it', async () => {
    delete process.env['BURACLE_NO_NOTIFY']
    await withSandbox(() => expect(process.env['BURACLE_NO_NOTIFY']).toBe('1'))
    delete process.env['BURACLE_NO_NOTIFY']
    await withEnv({ OTHER_VAR_FOR_THE_TEST: 'x' }, () => undefined)
    expect(process.env['BURACLE_NO_NOTIFY']).toBe('1')
    await withEnv({ BURACLE_NO_NOTIFY: undefined }, async () => {
      await withSandbox(() => expect(process.env['BURACLE_NO_NOTIFY']).toBeUndefined())
      await withEnv({ BURACLE_NO_NOTIFY: '0' }, () => expect(process.env['BURACLE_NO_NOTIFY']).toBe('0'))
      expect(process.env['BURACLE_NO_NOTIFY']).toBeUndefined()
    })
    expect(process.env['BURACLE_NO_NOTIFY']).toBe('1')
    expect(process.env['OTHER_VAR_FOR_THE_TEST']).toBeUndefined()
  })
})
