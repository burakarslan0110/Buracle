import { describe, expect, test } from 'bun:test'
import { isAbsolute, join } from 'node:path'
import { accountHome, quoteCmd, spawnArgv, windowsVerbatim } from '../../src/engine/platform'
import { run } from '../../src/engine/proc'
import { withEnv, withSandbox } from '../helpers/sandbox'

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

describe('starting a .cmd on Windows', () => {
  test('a .cmd runs through cmd.exe; a line with quotes gets one more pair, since /s drops the outer ones', () => withEnv({ BURACLE_PLATFORM: 'win32' }, () => {
    expect(spawnArgv(['C:\\npm\\codex.cmd', '--version'])).toEqual(['cmd.exe', '/d', '/s', '/c', 'C:\\npm\\codex.cmd --version'])
    expect(spawnArgv(['C:\\Program Files\\nodejs\\npm.cmd', 'install', '--prefix', 'C:\\a b'])).toEqual(['cmd.exe', '/d', '/s', '/c', '""C:\\Program Files\\nodejs\\npm.cmd" install --prefix "C:\\a b""'])
    expect(spawnArgv(['C:\\Git\\bin\\git.exe', 'status'])).toEqual(['C:\\Git\\bin\\git.exe', 'status'])
  }))

  test('such a line reaches cmd.exe verbatim; nothing else does', async () => {
    await withEnv({ BURACLE_PLATFORM: 'win32' }, () => {
      expect(windowsVerbatim(['cmd.exe', '/d', '/s', '/c', 'x'])).toBe(true)
      expect(windowsVerbatim(['C:\\Windows\\System32\\cmd.exe', '/d', '/s', '/c', 'x'])).toBe(true)
      expect(windowsVerbatim(['git', 'status'])).toBe(false)
      expect(windowsVerbatim(['cmd.exe', '/k'])).toBe(false)
    })
    await withEnv({ BURACLE_PLATFORM: 'linux' }, () => {
      expect(windowsVerbatim(['cmd.exe', '/d', '/s', '/c', 'x'])).toBe(false)
    })
  })

  test('cmd.exe gets no %NAME% to expand: a % stays outside the quotes behind a caret', () => {
    expect(quoteCmd('plain-arg')).toBe('plain-arg')
    expect(quoteCmd('')).toBe('""')
    expect(quoteCmd('a b')).toBe('"a b"')
    expect(quoteCmd('say "hi"')).toBe('"say ""hi"""')
    expect(quoteCmd('%PATH%')).toBe('""^%"PATH"^%""')
    expect(quoteCmd('50% off & more')).toBe('"50"^%" off & more"')
  })
})
