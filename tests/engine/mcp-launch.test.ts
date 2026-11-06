import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadCanonicalSync } from '../../src/engine/canonical'
import * as paths from '../../src/engine/paths'
import { launchPlan } from '../../src/engine/toolchain/launch'
import { emptyToolchainState } from '../../src/engine/toolchain/state'
import { writeStoredKey } from '../../src/engine/mcp-share/keys'
import { mcpLaunchArgv } from '../../src/engine/update/mcp'
import { withEnv, withSandbox } from '../helpers/sandbox'

describe('mcpLaunchArgv: how the handshake probe starts a stdio server', () => {
  test('the shim and other commands start as written', () => withSandbox(({ root }) => {
    const shim = join(root, 'buracle')
    writeFileSync(shim, '#!/bin/sh\n')
    expect(mcpLaunchArgv(shim, ['mcp', 'memory'], shim)).toEqual([shim, 'mcp', 'memory'])
    expect(mcpLaunchArgv('npx', ['-y', 'pkg'], shim)).toEqual(['npx', '-y', 'pkg'])
  }))
})

function file(path: string, text: string, mode = 0o755): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, mode)
  return path
}

describe('launchPlan: codegraph runs as one process per session (R3)', () => {
  const spec = loadCanonicalSync(paths.canonicalDir()).mcp.servers['codegraph']!

  test('codegraph runs with its watchdog process off', () => {
    expect(spec.env?.['CODEGRAPH_NO_WATCHDOG']).toBe('1')
  })

  test('with the platform package in the toolchain, its bin/codegraph starts directly (it replaces itself with the bundled node)', () => withSandbox(({ root }) => {
    const dir = join(root, 'tc', 'colbymchenry__codegraph')
    const shim = file(join(dir, 'node_modules', '@colbymchenry', 'codegraph', 'npm-shim.js'), '#!/usr/bin/env node\n')
    const direct = file(join(dir, 'node_modules', '@colbymchenry', `codegraph-${process.platform}-${process.arch}`, 'bin', 'codegraph'), '#!/bin/sh\nexec node "$@"\n')
    const state = emptyToolchainState()
    state.packages['npm:@colbymchenry/codegraph'] = { registry: 'npm', name: '@colbymchenry/codegraph', version: '1.6.2', dir, bins: { codegraph: shim }, installed_at: 'x' }
    const plan = launchPlan('codegraph', spec, state, { node: '/opt/node/bin/node' })
    expect(plan).toMatchObject({ argv: [direct, 'serve', '--mcp'], source: 'toolchain', version: '1.6.2' })
    expect('error' in plan ? {} : plan.env).toMatchObject({ CODEGRAPH_NO_WATCHDOG: '1' })
  }))

  test('without it (another platform, or a layout that changed), the npm entry starts as before', () => withSandbox(({ root }) => {
    const dir = join(root, 'tc', 'colbymchenry__codegraph')
    const shim = file(join(dir, 'node_modules', '@colbymchenry', 'codegraph', 'npm-shim.js'), '#!/usr/bin/env node\n')
    file(join(dir, 'node_modules', '@colbymchenry', 'codegraph-plan9-mips', 'bin', 'codegraph'), '#!/bin/sh\n')
    const state = emptyToolchainState()
    state.packages['npm:@colbymchenry/codegraph'] = { registry: 'npm', name: '@colbymchenry/codegraph', version: '1.6.2', dir, bins: { codegraph: shim }, installed_at: 'x' }
    expect(launchPlan('codegraph', spec, state, { node: '/opt/node/bin/node' })).toMatchObject({ argv: ['/opt/node/bin/node', shim, 'serve', '--mcp'], source: 'toolchain' })
    const notExecutable = file(join(dir, 'node_modules', '@colbymchenry', `codegraph-${process.platform}-${process.arch}`, 'bin', 'codegraph'), '#!/bin/sh\n', 0o644)
    expect(launchPlan('codegraph', spec, state, { node: '/opt/node/bin/node' })).toMatchObject({ argv: ['/opt/node/bin/node', shim, 'serve', '--mcp'] })
    expect(notExecutable).toContain('bin/codegraph')
  }))
})

describe('launchPlan: the API key of a server that takes one', () => {
  const spec = loadCanonicalSync(paths.canonicalDir()).mcp.servers['context7']!
  const planEnv = (): Record<string, string> => {
    const p = launchPlan('context7', spec, emptyToolchainState(), { npx: '/opt/node/bin/npx' })
    if ('error' in p) throw new Error(p.error)
    return p.env
  }

  test('a stored key reaches a server started without the shared backend; the variable in the environment wins over it; with no stored key nothing is added', () => withSandbox(async () => {
    expect(planEnv()['CONTEXT7_API_KEY']).toBeUndefined()
    writeStoredKey('context7', 'stored-key-0123456789')
    expect(planEnv()['CONTEXT7_API_KEY']).toBe('stored-key-0123456789')
    await withEnv({ CONTEXT7_API_KEY: 'from-the-shell' }, () => {
      // Left out of the plan, so the session's own variable reaches the server unchanged.
      expect(planEnv()['CONTEXT7_API_KEY']).toBeUndefined()
    })
  }))
})
