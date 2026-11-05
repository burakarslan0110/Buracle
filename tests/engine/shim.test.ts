import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as paths from '../../src/engine/paths'
import { parseShimText, shimArgv, shimLaunch } from '../../src/engine/shim'
import { shimContent } from '../../src/engine/update/install-core'
import { withEnv, withSandbox } from '../helpers/sandbox'

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

describe('reading a shim', () => {
  test('the sh shim names its bun, its main.ts and its checkout', () => {
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
})
