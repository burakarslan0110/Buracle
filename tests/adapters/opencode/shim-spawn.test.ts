import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { shimNotify } from '../../../src/adapters/opencode/runtime/guard'
import { spawnShimFinalizer } from '../../../src/adapters/opencode/runtime/memory-bridge'
import { usageRefreshArgv } from '../../../src/adapters/opencode/runtime/status'
import { defaultCli } from '../../../src/adapters/opencode/runtime/tui-commands'
import * as paths from '../../../src/engine/paths'
import { shimContent } from '../../../src/engine/update/install-core'
import { withSandbox } from '../../helpers/sandbox'

function capturing(fn: () => void): string[][] {
  const seen: string[][] = []
  const original = Bun.spawn
  Bun.spawn = ((argv: string[]) => {
    seen.push(argv)
    return { unref() {  }, pid: 1 }
  }) as unknown as typeof Bun.spawn
  try { fn() } finally { Bun.spawn = original }
  return seen
}

describe('the OpenCode plugin starts the CLI through the shim', () => {
  test('the notification, the finalizer, the TUI commands and the usage refresh run the shim itself', () => withSandbox(async () => {
    const shim = paths.shimPath()
    mkdirSync(dirname(shim), { recursive: true })
    writeFileSync(shim, shimContent({ bun: process.execPath, repoRoot: '/r' }), { mode: 0o755 })
    const seen = capturing(() => {
      shimNotify('Title', 'a message')
      expect(spawnShimFinalizer('ses_abc123')).toBe(true)
    })
    expect(seen).toEqual([
      [shim, 'notify', 'info', 'Title', 'a message'],
      [shim, 'mem', 'finalize', '--harness', 'opencode', '--session', 'ses_abc123'],
    ])
    expect(defaultCli()).toEqual([shim])
    expect(usageRefreshArgv()).toEqual([shim, 'usage', 'refresh', '--harness', 'opencode', '--background'])
  }))

  test('without a shim nothing starts', () => withSandbox(async () => {
    const seen = capturing(() => {
      shimNotify('Title', 'message')
      expect(spawnShimFinalizer('ses_abc123')).toBe(false)
    })
    expect(seen).toEqual([])
  }))
})
