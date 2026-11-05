import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { accountHome, desktopHost, findWslProgram, isWsl, osName, wslInterop } from '../../src/engine/platform'
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

describe('WSL', () => {
  test('isWsl: Linux with WSL_DISTRO_NAME or WSL_INTEROP set, or a Microsoft kernel in the version file; never macOS', () => withSandbox(async ({ root }) => {
    const none = join(root, 'no-version')
    const wsl2 = join(root, 'version-wsl2')
    writeFileSync(wsl2, 'Linux version 6.6.87.2-microsoft-standard-WSL2 (root@builder) (gcc) #1 SMP\n')
    const plain = join(root, 'version-plain')
    writeFileSync(plain, 'Linux version 6.8.0-49-generic (buildd@lcy02-amd64-103) (gcc) #49-Ubuntu SMP\n')
    await withEnv({ BURACLE_PLATFORM: 'linux' }, () => {
      expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, none)).toBe(true)
      expect(isWsl({ WSL_INTEROP: '/run/WSL/1_interop' }, none)).toBe(true)
      expect(isWsl({}, wsl2)).toBe(true)
      expect(isWsl({}, plain)).toBe(false)
      expect(isWsl({}, none)).toBe(false)
      expect(isWsl({ WSL_DISTRO_NAME: '' }, plain)).toBe(false)
    })
    await withEnv({ BURACLE_PLATFORM: 'darwin' }, () => {
      expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, wsl2)).toBe(false)
    })
  }))

  test('wslInterop: the WSLInterop or WSLInterop-late binfmt entry exists and its first line is enabled', () => withSandbox(async ({ root }) => {
    const dir = (name: string, entries: Record<string, string>): string => {
      const d = join(root, name)
      mkdirSync(d, { recursive: true })
      for (const [f, text] of Object.entries(entries)) writeFileSync(join(d, f), text)
      return d
    }
    expect(wslInterop(dir('on', { WSLInterop: 'enabled\ninterpreter /init\nflags: F\noffset 0\nmagic 4d5a\n' }))).toBe(true)
    expect(wslInterop(dir('late', { 'WSLInterop-late': 'enabled\ninterpreter /init\n' }))).toBe(true)
    expect(wslInterop(dir('off', { WSLInterop: 'disabled\ninterpreter /init\n' }))).toBe(false)
    expect(wslInterop(dir('empty', { WSLInterop: '' }))).toBe(false)
    expect(wslInterop(dir('other', { python3: 'enabled\n' }))).toBe(false)
    expect(wslInterop(join(root, 'missing'))).toBe(false)
  }))

  test('findWslProgram: a Windows program on PATH first, else at its usual place on drive C, else nothing', () => withSandbox(async ({ root }) => {
    const exe = (p: string): string => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 }); return p }
    const onPath = exe(join(root, 'path-bin', 'rundll32.exe'))
    const fixed = exe(join(root, 'mnt', 'c', 'Windows', 'System32', 'rundll32.exe'))
    const places = { 'rundll32.exe': fixed, 'powershell.exe': join(root, 'missing', 'powershell.exe') }
    await withEnv({ PATH: join(root, 'path-bin') }, () => expect(findWslProgram('rundll32.exe', places)).toBe(onPath))
    await withEnv({ PATH: join(root, 'empty') }, () => {
      expect(findWslProgram('rundll32.exe', places)).toBe(fixed)
      expect(findWslProgram('powershell.exe', places)).toBeUndefined()
      expect(findWslProgram('wslview', places)).toBeUndefined()
    })
  }))

  test('desktopHost: macOS, plain Linux, or WSL; outside a real WSL distribution interop reads as off', async () => {
    await withEnv({ BURACLE_PLATFORM: 'darwin', WSL_DISTRO_NAME: 'Ubuntu' }, () => expect(desktopHost()).toBe('darwin'))
    await withEnv({ BURACLE_PLATFORM: 'linux', WSL_DISTRO_NAME: undefined, WSL_INTEROP: undefined }, () => {
      expect(desktopHost({}, '/nonexistent/version', '/nonexistent/binfmt')).toBe('linux')
      expect(desktopHost({ WSL_DISTRO_NAME: 'Ubuntu' }, '/nonexistent/version', '/nonexistent/binfmt')).toBe('wsl-no-interop')
    })
  })
})
