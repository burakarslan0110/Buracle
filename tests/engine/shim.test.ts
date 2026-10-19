import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import * as paths from '../../src/engine/paths'
import { parseShimText, readShim, shimArgv, shimLaunch } from '../../src/engine/shim'
import { shimContent, windowsShimContent } from '../../src/engine/update/install-core'
import { withEnv, withSandbox } from '../helpers/sandbox'

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

describe('reading a shim', () => {
  test('buracle.cmd names its bun, its main.ts and, when frozen, the checkout it falls back to', () => {
    const bun = join('/', 'b', 'bun.exe')
    const repoRoot = join('/', 'r', 'buracle')
    const runtime = join('/', 'h', '.buracle', 'runtime', '0123456789abcdef')
    expect(parseShimText(windowsShimContent({ bun, repoRoot, runtime, buracleHome: join('/', 'h', 'bh') }))).toEqual({ mode: 'frozen', bun, main: join(runtime, 'src', 'cli', 'main.ts'), checkout: resolve(repoRoot) })
    expect(parseShimText(windowsShimContent({ bun, repoRoot }))).toEqual({ mode: 'checkout', bun, main: join(repoRoot, 'src', 'cli', 'main.ts'), checkout: resolve(repoRoot) })
    expect(parseShimText('@echo off\r\nrem something else\r\n')).toBeUndefined()
  })

  test('the sh shim reads as before', () => {
    expect(parseShimText(shimContent({ bun: '/b/bun', repoRoot: '/r/buracle' }))).toEqual({ mode: 'checkout', bun: '/b/bun', main: '/r/buracle/src/cli/main.ts', checkout: resolve('/r/buracle') })
  })
})

describe('starting the CLI through the shim', () => {
  test('elsewhere the shim itself runs, when it exists', () => withSandbox(async () => {
    await withEnv({ BURACLE_PLATFORM: 'linux' }, () => {
      expect(shimLaunch()).toBeUndefined()
      expect(shimArgv(['notify'])).toBeUndefined()
      write(paths.shimPath(), shimContent({ bun: process.execPath, repoRoot: '/r' }))
      expect(shimLaunch()).toEqual([paths.shimPath()])
      expect(shimArgv(['notify', 'info'])).toEqual([paths.shimPath(), 'notify', 'info'])
    })
  }))

  test('on Windows what buracle.cmd runs starts directly: its runtime, else its checkout, else what runtime-config.json recorded, else the .cmd through cmd.exe', () => withSandbox(async ({ root }) => {
    await withEnv({ BURACLE_PLATFORM: 'win32' }, () => {
      const shim = paths.shimPath()
      expect(shim.endsWith('buracle.cmd')).toBe(true)
      const repoRoot = join(root, 'checkout')
      const runtime = join(root, 'runtime', 'abc')
      write(join(runtime, 'src', 'cli', 'main.ts'), '')
      write(join(repoRoot, 'src', 'cli', 'main.ts'), '')
      write(shim, windowsShimContent({ bun: process.execPath, repoRoot, runtime }))
      expect(readShim()?.main).toBe(join(runtime, 'src', 'cli', 'main.ts'))
      expect(shimLaunch()).toEqual([process.execPath, join(runtime, 'src', 'cli', 'main.ts')])
      expect(shimArgv(['mem', 'finalize'])).toEqual([process.execPath, join(runtime, 'src', 'cli', 'main.ts'), 'mem', 'finalize'])

      rmSync(join(runtime, 'src', 'cli', 'main.ts'))
      expect(shimLaunch()).toEqual([process.execPath, join(repoRoot, 'src', 'cli', 'main.ts')])

      write(shim, '@echo off\r\nrem hand-written\r\n')
      expect(shimLaunch()).toBeUndefined()
      write(paths.runtimeConfigFile(), JSON.stringify({ v: 1, resolved: { bun: process.execPath, repoRoot } }))
      expect(shimLaunch()).toEqual([process.execPath, join(repoRoot, 'src', 'cli', 'main.ts')])

      rmSync(paths.runtimeConfigFile())
      expect(shimArgv(['notify', 'info', 'a b'])).toEqual(['cmd.exe', '/d', '/s', '/c', `"${shim} notify info "a b""`])
    })
  }))
})
