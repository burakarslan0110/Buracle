import { describe, expect, test } from 'bun:test'
import { isAbsolute, join } from 'node:path'
import { accountHome } from '../../src/engine/platform'
import { run } from '../../src/engine/proc'
import { withSandbox } from '../helpers/sandbox'

const PLATFORM_TS = join(import.meta.dir, '..', '..', 'src', 'engine', 'platform.ts')
const POSIX = process.platform !== 'win32'

describe('accountHome', () => {
  test.if(POSIX)('is an absolute folder, not the temporary HOME this test run uses', () => {
    const home = accountHome()
    expect(home).toBeDefined()
    expect(isAbsolute(home ?? '')).toBe(true)
    expect(home).not.toBe(process.env['HOME'])
  })

  test.if(POSIX)('a process started with another HOME still finds the same account home', () => withSandbox(async ({ home }) => {
    const script = `import { accountHome } from ${JSON.stringify(PLATFORM_TS)}\nconsole.log(JSON.stringify({ account: accountHome() ?? null, home: process.env.HOME }))\n`
    const r = await run([process.execPath, '-e', script], { env: { HOME: home }, timeoutMs: 30_000 })
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: '' })
    expect(JSON.parse(r.stdout)).toEqual({ account: accountHome() ?? null, home })
    expect(accountHome()).not.toBe(home)
  }), 60_000)

  test.if(POSIX)('is looked up once per process', () => {
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
