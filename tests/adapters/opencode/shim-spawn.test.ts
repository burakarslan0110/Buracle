import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { shimNotify } from '../../../src/adapters/opencode/runtime/guard'
import { spawnShimFinalizer } from '../../../src/adapters/opencode/runtime/memory-bridge'
import { usageRefreshArgv } from '../../../src/adapters/opencode/runtime/status'
import { defaultCli } from '../../../src/adapters/opencode/runtime/tui-commands'
import * as paths from '../../../src/engine/paths'
import { windowsShimContent } from '../../../src/engine/update/install-core'
import { withEnv, withSandbox } from '../../helpers/sandbox'

interface Seen { argv: string[], verbatim: unknown }

function capturing(fn: () => void): Seen[] {
  const seen: Seen[] = []
  const original = Bun.spawn
  Bun.spawn = ((argv: string[], o: { windowsVerbatimArguments?: boolean }) => {
    seen.push({ argv, verbatim: o.windowsVerbatimArguments })
    return { unref() {  }, pid: 1 }
  }) as unknown as typeof Bun.spawn
  try { fn() } finally { Bun.spawn = original }
  return seen
}

describe('the OpenCode plugin starts the CLI through the shim', () => {
  test('on Windows the notification, the finalizer, the TUI commands and the usage refresh run what buracle.cmd runs, not the .cmd', () => withSandbox(async ({ root }) => {
    await withEnv({ BURACLE_PLATFORM: 'win32' }, () => {
      const checkout = join(root, 'checkout')
      const main = join(checkout, 'src', 'cli', 'main.ts')
      mkdirSync(dirname(main), { recursive: true })
      writeFileSync(main, '')
      mkdirSync(dirname(paths.shimPath()), { recursive: true })
      writeFileSync(paths.shimPath(), windowsShimContent({ bun: process.execPath, repoRoot: checkout }))
      const seen = capturing(() => {
        shimNotify('Title', 'a message')
        expect(spawnShimFinalizer('ses_abc123')).toBe(true)
      })
      expect(seen).toEqual([
        { argv: [process.execPath, main, 'notify', 'info', 'Title', 'a message'], verbatim: false },
        { argv: [process.execPath, main, 'mem', 'finalize', '--harness', 'opencode', '--session', 'ses_abc123'], verbatim: false },
      ])
      expect(defaultCli()).toEqual([process.execPath, main])
      expect(usageRefreshArgv()).toEqual([process.execPath, main, 'usage', 'refresh', '--harness', 'opencode', '--background'])
    })
  }))

  test('without a shim nothing starts', () => withSandbox(async () => {
    const seen = capturing(() => {
      shimNotify('Title', 'message')
      expect(spawnShimFinalizer('ses_abc123')).toBe(false)
    })
    expect(seen).toEqual([])
  }))
})
