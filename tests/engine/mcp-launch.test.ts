import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mcpLaunchArgv } from '../../src/engine/update/mcp'
import { withSandbox } from '../helpers/sandbox'

describe('mcpLaunchArgv: how the handshake probe starts a stdio server', () => {
  test('the shim and other commands start as written', () => withSandbox(({ root }) => {
    const shim = join(root, 'buracle')
    writeFileSync(shim, '#!/bin/sh\n')
    expect(mcpLaunchArgv(shim, ['mcp', 'memory'], shim)).toEqual([shim, 'mcp', 'memory'])
    expect(mcpLaunchArgv('npx', ['-y', 'pkg'], shim)).toEqual(['npx', '-y', 'pkg'])
  }))
})
