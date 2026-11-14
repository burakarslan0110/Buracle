import { describe, expect, test } from 'bun:test'
import { isAbsolute, join } from 'node:path'
import { accountHome, osName } from '../../src/engine/platform'
import { run } from '../../src/engine/proc'
import { withEnv, withSandbox } from '../helpers/sandbox'

const PLATFORM_TS = join(import.meta.dir, '..', '..', 'src', 'engine', 'platform.ts')

describe('accountHome', () => {
  test('is an absolute folder, not the temporary HOME this test run uses', () => {
    const home = accountHome()
    expect(home).toBeDefined()
    expect(isAbsolute(home ?? '')).toBe(true)
    expect(home).not.toBe(process.env['HOME'])
  })

  test('a process started with another HOME still finds the same account home', () => withSandbox(async ({ home }) => {
    const script = `import { accountHome } from ${JSON.stringify(PLATFORM_TS)}\nconsole.log(JSON.stringify({ account: accountHome() ?? null, home: process.env.HOME }))\n`
    const r = await run([process.execPath, '-e', script], { env: { HOME: home }, timeoutMs: 30_000 })
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: '' })
    expect(JSON.parse(r.stdout)).toEqual({ account: accountHome() ?? null, home })
    expect(accountHome()).not.toBe(home)
  }), 60_000)

  test('is looked up once per process', () => {
    const first = accountHome()
    const original = Bun.spawnSync
    let spawned = 0
    Bun.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => { spawned++; return original(...args) }) as typeof Bun.spawnSync
    try {
      expect([accountHome(), accountHome()]).toEqual([first, first])
    } finally {
      Bun.spawnSync = original
    }
    expect(spawned).toBe(0)
  })
})

describe('osName', () => {
  test('BURACLE_PLATFORM picks darwin or linux; win32 or any other value gives the real platform', async () => {
    const real = process.platform === 'darwin' ? 'darwin' : 'linux'
    await withEnv({ BURACLE_PLATFORM: 'darwin' }, () => expect(osName()).toBe('darwin'))
    await withEnv({ BURACLE_PLATFORM: 'linux' }, () => expect(osName()).toBe('linux'))
    for (const v of ['win32', 'freebsd', '']) await withEnv({ BURACLE_PLATFORM: v }, () => expect(osName()).toBe(real))
  })
})

