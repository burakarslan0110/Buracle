import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { adapter } from '../../../src/adapters/agy/index'
import { agyMcpServers } from '../../../src/adapters/agy/config'
import * as paths from '../../../src/engine/paths'
import { run } from '../../../src/engine/proc'
import { applyPlans } from '../../../src/engine/txn'
import { liveNote, liveTest } from '../../helpers/live-smoke'
import { withSandbox } from '../../helpers/sandbox'
import { canonical, ctx, REPO } from './helpers'

// The real `agy` program, started with HOME in the sandbox (it keeps everything under $HOME/.gemini). Without a Google
// login it opens a sign-in window, so every call that starts `agy` is opt-in (BURACLE_LIVE_SMOKE=1); `agy -p` is not run at
// all, because without a login it stops before any hook can fire. The one check that never starts `agy` is that the command
// registered for PreToolUse denies a catastrophic command as the program starts it (`sh -c`).
const AGY = Bun.which('agy') ?? undefined
const live = liveTest(AGY)
const local = AGY === undefined ? test.skip : test
const NOTE = liveNote('agy', AGY)

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
  live('lists every MCP server Buracle Stack wrote, enabled', () => withSandbox(async ({ home }) => {
    await installed()
    const list = await run([AGY as string, 'mcp', 'list'], { cwd: home, env: agyEnv(home), timeoutMs: 60_000 })
    expect(list.code).toBe(0)
    for (const id of Object.keys(agyMcpServers(canonical, ctx().buracleBin))) expect({ id, listed: new RegExp(`^${id}\\s+(stdio|http)\\s+enabled`, 'm').test(list.stdout) }).toEqual({ id, listed: true })
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

  live('lists the buracle plugin with its review agents and rules (agy plugin list --json)', () => withSandbox(async ({ home }) => {
    await installed()
    const r = await run([AGY as string, 'plugin', 'list', '--json'], { cwd: home, env: agyEnv(home), timeoutMs: 60_000 })
    const list = JSON.parse(r.stdout) as Array<{ name: string, enabled: boolean, agents?: string[], rules?: string[] }>
    const mine = list.find(p => p.name === 'buracle')
    expect(mine?.enabled).toBe(true)
    expect([...(mine?.agents ?? [])].sort()).toEqual(canonical.agents.map(a => a.id).sort())
    expect(mine?.rules ?? []).toContain('AGENTS.md')
    const v = await run([AGY as string, 'plugin', 'validate', join(home, '.gemini', 'config', 'plugins', 'buracle'), '--strict'], { cwd: home, env: agyEnv(home), timeoutMs: 60_000 })
    expect(v.code).toBe(0)
  }), 120_000)

  local('the command the hooks file registers denies a catastrophic shell command, run as the program runs it (sh -c, in the hooks file\'s folder)', () => withSandbox(async ({ home }) => {
    await installed()
    const file = join(home, '.gemini', 'config', 'hooks.json')
    const hooks = JSON.parse(readFileSync(file, 'utf8')) as { buracle: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } }
    const command = hooks.buracle.PreToolUse[0]?.hooks[0]?.command as string
    const payload = JSON.stringify({ conversationId: 'smoke-1', cwd: home, workspacePaths: [home], hookEventName: 'PreToolUse', toolCall: { id: 't1', name: 'run_command', args: { CommandLine: 'rm -rf ~' } }, stepIdx: 1 })
    const r = await run(['/bin/sh', '-c', command], { stdin: payload, cwd: join(home, '.gemini', 'config'), env: agyEnv(home), timeoutMs: 60_000 })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'deny' })
    expect(String((JSON.parse(r.stdout) as { reason: string }).reason)).toStartWith('Buracle Stack H01: ')
  }), 120_000)
})
