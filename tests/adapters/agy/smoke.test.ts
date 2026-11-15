import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { adapter } from '../../../src/adapters/agy/index'
import { agyMcpServers } from '../../../src/adapters/agy/config'
import * as paths from '../../../src/engine/paths'
import { run } from '../../../src/engine/proc'
import { applyPlans } from '../../../src/engine/txn'
import { withSandbox } from '../../helpers/sandbox'
import { canonical, ctx, REPO } from './helpers'

// The real `agy` program, started with HOME in the sandbox (it keeps everything under $HOME/.gemini). Without a Google
// login it stops at "Authentication required" before any conversation exists, so no hook can fire from the program here:
// what is checked is that it parses what Buracle wrote (its own log says how many named hooks it loaded), lists the MCP
// servers, and that the command registered for PreToolUse denies a catastrophic command as the program starts it (`sh -c`).
const AGY = Bun.which('agy') ?? undefined
const live = AGY === undefined ? test.skip : test
const NOTE = AGY === undefined ? ' (skipped: agy is not on PATH)' : ''

function shim(): string {
  const bin = join(paths.buracleHome(), 'bin')
  mkdirSync(bin, { recursive: true })
  const file = join(bin, 'buracle')
  writeFileSync(file, `#!/bin/sh\nexec ${process.execPath} ${join(REPO, 'src', 'cli', 'main.ts')} "$@"\n`)
  chmodSync(file, 0o755)
  return file
}

const agyEnv = (home: string): Record<string, string | undefined> => ({ ...process.env, HOME: home, TERM: 'dumb', NO_COLOR: '1', BURACLE_NO_AUTOSTART: '1' })

async function installed(): Promise<void> {
  shim()
  const r = await applyPlans([await adapter.installPlan(ctx())])
  expect(r.conflicts).toEqual([])
}

describe(`the real agy program${NOTE}`, () => {
  live('lists every MCP server Buracle wrote, enabled', () => withSandbox(async ({ home }) => {
    await installed()
    const list = await run([AGY as string, 'mcp', 'list'], { cwd: home, env: agyEnv(home), timeoutMs: 60_000 })
    expect(list.code).toBe(0)
    for (const id of Object.keys(agyMcpServers(canonical, ctx().buracleBin))) expect({ id, listed: new RegExp(`^${id}\\s+(stdio|http)\\s+enabled`, 'm').test(list.stdout) }).toEqual({ id, listed: true })
  }), 120_000)

  live('loads the hooks.json Buracle wrote: its log counts the named hook and reports no error about it', () => withSandbox(async ({ home }) => {
    await installed()
    await run([AGY as string, '-p', 'hi'], { cwd: home, env: agyEnv(home), stdin: '', timeoutMs: 20_000 })
    const logs = join(home, '.gemini', 'antigravity-cli', 'log')
    const text = existsSync(logs) ? readdirSync(logs).map(f => readFileSync(join(logs, f), 'utf8')).join('\n') : ''
    expect(text).toMatch(/loaded 1 named hooks from 1 hooks\.json file\(s\)/)
    expect(text).not.toMatch(/hooks?[^\n]*(parse|invalid|unmarshal)/i)
  }), 120_000)

  live('a skill folder that is a symlink is counted by the loader (the plugin loader, which the global skills folder shares)', () => withSandbox(async ({ root, home }) => {
    const store = join(root, 'store', 'linked-skill')
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'SKILL.md'), '---\nname: linked-skill\ndescription: A linked skill\n---\nbody\n')
    const plugin = join(root, 'plugin')
    mkdirSync(join(plugin, 'skills'), { recursive: true })
    writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'probe', version: '0.0.1', description: 'probe' }))
    symlinkSync(store, join(plugin, 'skills', 'linked-skill'))
    const r = await run([AGY as string, 'plugin', 'validate', plugin], { cwd: home, env: agyEnv(home), timeoutMs: 60_000 })
    expect(r.stdout).toMatch(/skills 1\b/)
  }), 120_000)

  live('the command the hooks file registers denies a catastrophic shell command, run as the program runs it (sh -c, in the hooks file\'s folder)', () => withSandbox(async ({ home }) => {
    await installed()
    const file = join(home, '.gemini', 'config', 'hooks.json')
    const hooks = JSON.parse(readFileSync(file, 'utf8')) as { buracle: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } }
    const command = hooks.buracle.PreToolUse[0]?.hooks[0]?.command as string
    const payload = JSON.stringify({ conversationId: 'smoke-1', cwd: home, workspacePaths: [home], hookEventName: 'PreToolUse', toolCall: { id: 't1', name: 'run_command', args: { CommandLine: 'rm -rf ~' } }, stepIdx: 1 })
    const r = await run(['/bin/sh', '-c', command], { stdin: payload, cwd: join(home, '.gemini', 'config'), env: agyEnv(home), timeoutMs: 60_000 })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'deny' })
    expect(String((JSON.parse(r.stdout) as { reason: string }).reason)).toStartWith('Buracle H01: ')
  }), 120_000)
})
