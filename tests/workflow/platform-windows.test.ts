import { describe, expect, test } from 'bun:test'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { windowsMcpOp } from '../../src/adapters/omp/install'
import { SERVICE_ENV_CHECK } from '../../src/adapters/opencode/install'
import type { AdapterContext } from '../../src/adapters/registry'
import { defaultConfig } from '../../src/core/config'
import { loadCanonicalSync } from '../../src/engine/canonical'
import * as paths from '../../src/engine/paths'
import { run } from '../../src/engine/proc'
import { desktopNotification } from '../../src/workflow/notify'
import { withSandbox } from '../helpers/sandbox'

const REPO = join(import.meta.dir, '..', '..')

describe('desktop notifications per platform', () => {
  test('Windows: a PowerShell tray balloon; the title and message travel in the environment only', () => {
    const evil = '"; Remove-Item -Recurse C:\\ ; "'
    const n = desktopNotification('win32', 'attention_needed', 'Approval needed', evil, () => true)
    expect(n?.argv.slice(0, 2)).toEqual(['powershell.exe', '-NoProfile'])
    expect(n?.argv.join(' ')).not.toContain('Remove-Item')
    expect(n?.env).toEqual({ BURACLE_NOTIFY_TITLE: 'Buracle: Approval needed', BURACLE_NOTIFY_MESSAGE: evil })
    expect(n?.detached).toBe(true)
  })

  test('macOS: osascript with the texts as arguments; Linux: notify-send when installed, else nothing', () => {
    const mac = desktopNotification('darwin', 'plan_approval', 'Plan ready', 'Waiting for your approval', () => true)
    expect(mac?.argv[0]).toBe('osascript')
    expect(mac?.argv.slice(-4)).toEqual(['Buracle', 'Plan ready', 'Waiting for your approval', 'Glass'])
    expect(desktopNotification('linux', 'info', 'a', 'b', () => false)).toBeUndefined()
    expect(desktopNotification('linux', 'info', 'a', 'b', c => c === 'notify-send')?.argv).toEqual(['notify-send', '--app-name=Buracle', 'Buracle: a', 'b'])
  })
})

describe('Oh My Pi on Windows', () => {
  test('Buracle\'s servers go into ~/.omp/agent/mcp.json with the shim\'s absolute path (no sh)', () => withSandbox(async ({ home }) => {
    const canonical = loadCanonicalSync(join(REPO, 'canonical'))
    const shim = 'C:\\Users\\me\\.buracle\\bin\\buracle.cmd'
    const ctx: AdapterContext = { repoRoot: REPO, config: defaultConfig(), canonical, paths, buracleBin: shim }
    const op = windowsMcpOp(ctx, join(home, '.omp', 'agent'))
    expect(op).toMatchObject({ kind: 'json-merge', path: join(home, '.omp', 'agent', 'mcp.json'), owner: 'omp' })
    const set = (op as { set: Record<string, Record<string, unknown>> }).set
    expect(set['mcpServers."codegraph"']).toMatchObject({ type: 'stdio', command: shim, args: ['mcp', 'run', 'codegraph'] })
    expect(set['mcpServers."buracle-memory"']).toMatchObject({ command: shim, args: ['mcp', 'memory'] })
    expect(JSON.stringify(set)).not.toContain('/bin/sh')
    expect(Object.keys(set).some(k => k.includes('chrome-devtools'))).toBe(false)
  }))
})

describe('OpenCode service check', () => {
  test('bun asks `opencode service get env BURACLE_HOME` and compares (no sh needed)', () => withSandbox(async ({ root }) => {
    const fake = join(root, 'opencode')
    writeFileSync(fake, '#!/bin/sh\n[ "$1 $2 $3 $4" = "service get env BURACLE_HOME" ] && echo /h/.buracle\n')
    chmodSync(fake, 0o755)
    expect((await run([process.execPath, '-e', SERVICE_ENV_CHECK, fake, '/h/.buracle'])).code).toBe(0)
    expect((await run([process.execPath, '-e', SERVICE_ENV_CHECK, fake, '/other'])).code).toBe(1)
  }))
})
