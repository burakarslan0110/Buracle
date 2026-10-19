import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mcpLaunchArgv } from '../../src/engine/update/mcp'
import { windowsShimContent } from '../../src/engine/update/install-core'
import { withEnv, withSandbox } from '../helpers/sandbox'

describe('mcpLaunchArgv: how the handshake probe starts a stdio server', () => {
  test('on Windows the Buracle shim runs as the bun and main.ts that buracle.cmd names, never the .cmd itself', () => withSandbox(({ root }) => withEnv({ BURACLE_PLATFORM: 'win32' }, () => {
    const repoRoot = join(root, 'checkout')
    mkdirSync(join(repoRoot, 'src', 'cli'), { recursive: true })
    writeFileSync(join(repoRoot, 'src', 'cli', 'main.ts'), '')
    const shim = join(root, 'buracle.cmd')
    writeFileSync(shim, windowsShimContent({ bun: process.execPath, repoRoot }))
    expect(mcpLaunchArgv(shim, ['mcp', 'run', 'codegraph'], shim)).toEqual([process.execPath, join(repoRoot, 'src', 'cli', 'main.ts'), 'mcp', 'run', 'codegraph'])
  })))

  test('elsewhere the shim and other commands start as written', () => withSandbox(({ root }) => withEnv({ BURACLE_PLATFORM: 'linux' }, () => {
    const shim = join(root, 'buracle')
    writeFileSync(shim, '#!/bin/sh\n')
    expect(mcpLaunchArgv(shim, ['mcp', 'memory'], shim)).toEqual([shim, 'mcp', 'memory'])
    expect(mcpLaunchArgv('npx', ['-y', 'pkg'], shim)).toEqual(['npx', '-y', 'pkg'])
  })))
})
