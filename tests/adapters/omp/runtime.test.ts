import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { liveConfig, mcpHealth, parseHealth, parseRuntimeConfig } from '../../../src/adapters/omp/runtime/config'
import { defaultDeps } from '../../../src/adapters/omp/runtime/extension'
import { buracleCli, capText, createMemoryBridge, readMemoryStatus } from '../../../src/adapters/omp/runtime/memory'
import { defaultConfig } from '../../../src/core/config'
import * as paths from '../../../src/engine/paths'
import { withEnv, withSandbox } from '../../helpers/sandbox'

const SID = '01a118a8-8d01-740c-9360-f4f796699f4b'

describe('omp runtime: memory bridge', () => {
  test('spool goes through appendSpool with the omp harness; failures never escape', async () => {
    const calls: unknown[] = []
    const bridge = createMemoryBridge({ cli: () => undefined, append: (...a) => { calls.push(a) } })
    await bridge.appendSpool(SID, [{ ts: 1, ev: 'prompt' }])
    await bridge.appendSpool(SID, [])
    expect(calls).toEqual([['omp', SID, [{ ts: 1, ev: 'prompt' }]]])
    const throwing = createMemoryBridge({ cli: () => undefined, append: () => { throw new Error('disk full') } })
    await throwing.appendSpool(SID, [{ ts: 1, ev: 'note' }])
  })

  test('session start and finalize spawn the CLI twins detached; no CLI means no spawn', async () => {
    const spawned: string[][] = []
    const bridge = createMemoryBridge({ cli: () => ['/b/buracle'], spawnDetached: a => { spawned.push(a); return true } })
    await bridge.sessionStart(SID, '/work')
    await bridge.spawnFinalizer(SID)
    expect(spawned).toEqual([
      ['/b/buracle', 'mem', 'start', '--harness', 'omp', '--session', SID, '--cwd', '/work'],
      ['/b/buracle', 'mem', 'finalize', '--harness', 'omp', '--session', SID, '--detach'],
    ])
    const none = createMemoryBridge({ cli: () => undefined, spawnDetached: a => { spawned.push(a); return true } })
    await none.sessionStart(SID, '/work')
    await none.spawnFinalizer(SID)
    expect(spawned).toHaveLength(2)
  })

  test('contextText reads `buracle mem context --json`; failures yield undefined', async () => {
    const argvs: string[][] = []
    let reply = { code: 0, stdout: JSON.stringify({ text: '# Buracle memory\n- x\n' }), stderr: '', timedOut: false }
    const bridge = createMemoryBridge({ cli: () => ['bun', '/r/src/cli/main.ts'], run: async a => { argvs.push(a); return reply } })
    expect(await bridge.contextText('/work')).toBe('# Buracle memory\n- x')
    expect(argvs).toEqual([['bun', '/r/src/cli/main.ts', 'mem', 'context', '--harness', 'omp', '--cwd', '/work', '--json']])
    reply = { code: 2, stdout: '', stderr: 'no vault', timedOut: false }
    expect(await bridge.contextText('/work')).toBeUndefined()
    reply = { code: 0, stdout: 'not json', stderr: '', timedOut: false }
    expect(await bridge.contextText('/work')).toBeUndefined()
    reply = { code: 0, stdout: '{"text":"  "}', stderr: '', timedOut: false }
    expect(await bridge.contextText('/work')).toBeUndefined()
    expect(await createMemoryBridge({ cli: () => undefined }).contextText('/work')).toBeUndefined()
  })

  test('buracleCli prefers the shim, else bun with the checkout CLI', () => withSandbox(async sb => {
    const shim = join(sb.root, 'buracle')
    const repo = join(sb.root, 'repo')
    expect(buracleCli(shim, repo)).toBeUndefined()
    mkdirSync(join(repo, 'src', 'cli'), { recursive: true })
    writeFileSync(join(repo, 'src', 'cli', 'main.ts'), '')
    const viaBun = buracleCli(shim, repo)
    if (Bun.which('bun') !== null) expect(viaBun).toEqual([Bun.which('bun') as string, join(repo, 'src', 'cli', 'main.ts')])
    writeFileSync(shim, '#!/bin/sh\n')
    chmodSync(shim, 0o755)
    expect(buracleCli(shim, repo)).toEqual([shim])
    expect(buracleCli(join(sb.root, 'absent'), undefined)).toBeUndefined()
  }))

  test('the bundled appendSpool (memory task) writes the session spool', () => withSandbox(async sb => {
    await withEnv({ BURACLE_NO_CAPTURE: undefined }, async () => {
      const bridge = createMemoryBridge({ cli: () => undefined })
      await bridge.appendSpool(SID, [{ ts: Date.now(), ev: 'tool', tool: 'bash', kind: 'bash', cmd: 'bun test', exit: 0 }])
      const dir = join(sb.buracleHome, 'state', 'memory', 'spool')
      expect(readdirSync(dir).some(n => n.startsWith(`omp-${SID}`))).toBe(true)
    })
  }))
})

describe('omp runtime: live config and MCP health', () => {
  test('parseRuntimeConfig merges the snapshot over the defaults and keeps valid values only', () => withSandbox(async sb => {
    const d = defaultConfig()
    const live = parseRuntimeConfig(JSON.stringify({ v: 1, config: { ...d, routing: { strictness: 'nudge' }, context: { warnPct: 'x', criticalPct: 95 } }, resolved: { repoRoot: '/r', vault: '/ignored' } }), d)
    expect(live.config.routing.strictness).toBe('nudge')
    expect(live.config.context.warnPct).toBe(85)
    expect(live.repoRoot).toBe('/r')
    expect(live.vault).toBe(join(sb.home, 'Documents', 'Buracle'))
    expect(live.shim).toBe(join(sb.buracleHome, 'bin', 'buracle'))
    expect(live.source).toBe('runtime-config')
    const other = parseRuntimeConfig(JSON.stringify({ v: 2, config: { ...d, routing: { strictness: 'off' } }, resolved: { repoRoot: '/r' } }), d)
    expect(other.source).toBe('defaults')
    expect(other.config).toEqual(d)
    expect(other.repoRoot).toBeUndefined()
    expect(readFileSync(paths.logFile(), 'utf8')).toContain('runtime-config.json has version 2, this Buracle reads version 1')
    expect(() => parseRuntimeConfig('[]', d)).toThrow(/expected an object/)
  }))

  test('liveConfig falls back to the defaults, re-reads on change and survives a broken file', () => withSandbox(async () => {
    const d = defaultConfig()
    expect(liveConfig(d).source).toBe('defaults')
    const file = paths.runtimeConfigFile()
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ v: 1, config: { ...d, routing: { strictness: 'off' } } }))
    expect(liveConfig(d).config.routing.strictness).toBe('off')
    writeFileSync(file, JSON.stringify({ v: 1, config: { ...d, routing: { strictness: 'nudge' } } }) + '\n')
    utimesSync(file, new Date(), new Date(Date.now() + 5000))
    expect(liveConfig(d).config.routing.strictness).toBe('nudge')
    writeFileSync(file, '{ broken')
    utimesSync(file, new Date(), new Date(Date.now() + 10_000))
    expect(liveConfig(d).source).toBe('defaults')
  }))

  test('health.json shapes', () => withSandbox(async () => {
    expect(parseHealth({ mcp: { context7: 'ok', semble: 'down', x: 'weird' } })).toEqual({ context7: 'ok', semble: 'down' })
    expect(parseHealth({ servers: { grep: { status: 'unknown' }, codegraph: { health: 'ok' } } })).toEqual({ grep: 'unknown', codegraph: 'ok' })
    expect(parseHealth({ 'web-search': 'down' })).toEqual({ 'web-search': 'down' })
    expect(parseHealth(null)).toEqual({})
    expect(mcpHealth()).toEqual({})
    mkdirSync(paths.stateDir(), { recursive: true })
    writeFileSync(paths.healthFile(), JSON.stringify({ mcp: { context7: 'down' } }))
    expect(mcpHealth()).toEqual({ context7: 'down' })
  }))

  test('health.json: a failed start is down until its `until` (core mcpHealthOf), also from the cache without a change of the file', () => withSandbox(async () => {
    const now = Date.UTC(2026, 9, 10, 12, 0, 0)
    const until = new Date(now + 60_000).toISOString()
    expect(parseHealth({ mcp: { a: { status: 'down', source: 'launch', until }, b: { state: 'down', until } } }, now + 60_000)).toEqual({ a: 'unknown', b: 'unknown' })
    mkdirSync(paths.stateDir(), { recursive: true })
    writeFileSync(paths.healthFile(), JSON.stringify({ v: 1, mcp: { 'web-search': { status: 'down', source: 'launch', until }, codegraph: { health: 'ok' }, semble: 'down' } }))
    expect(mcpHealth(now)).toEqual({ 'web-search': 'down', codegraph: 'ok', semble: 'down' })
    expect(mcpHealth(now + 60_000)).toEqual({ 'web-search': 'unknown', codegraph: 'ok', semble: 'down' })
  }))
})

describe('omp runtime: memory index, status inputs and maintenance', () => {
  test('capText cuts at the line and byte caps', () => {
    expect(capText('aaaa\nbbbb\ncccc', 10, 10)).toEqual({ text: 'aaaa\nbbbb', truncated: true })
    expect(capText('a\nb', 10, 100)).toEqual({ text: 'a\nb', truncated: false })
  })

  test('memory status file per project with a _global fallback; torn JSON is skipped', () => withSandbox(async () => {
    const dir = join(paths.memoryStateDir(), 'status')
    mkdirSync(dir, { recursive: true })
    expect(readMemoryStatus('demo')).toBeUndefined()
    writeFileSync(join(dir, '_global.json'), JSON.stringify({ v: 2, health: 'warn' }))
    expect(readMemoryStatus('demo')).toMatchObject({ health: 'warn' })
    writeFileSync(join(dir, 'demo.json'), '{"v":2,')
    expect(readMemoryStatus('demo')).toMatchObject({ health: 'warn' })
    writeFileSync(join(dir, 'demo.json'), JSON.stringify({ v: 1, health: 'error' }))
    expect(readMemoryStatus('demo')).toMatchObject({ health: 'warn' })
    writeFileSync(join(dir, 'demo.json'), JSON.stringify({ v: 2, health: 'ok' }))
    expect(readMemoryStatus('demo')).toMatchObject({ health: 'ok' })
  }))

  test('H16: the production prune is the shared sessionMaint (idle omp state and old finalized spool go; kept, recent and other harnesses stay)', () => withSandbox(async () => {
    const now = Date.now()
    const old = new Date(now - 30 * 86_400_000)
    const mk = (sid: string, aged: boolean) => {
      const dir = paths.sessionDir('omp', sid)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'state.json'), '{}')
      if (aged) { utimesSync(join(dir, 'state.json'), old, old); utimesSync(dir, old, old) }
      return dir
    }
    const stale = mk('stale-1', true)
    const kept = mk('keep-1', true)
    const fresh = mk('fresh-1', false)
    mkdirSync(join(paths.sessionsDir('omp'), 'not a session id!'), { recursive: true })
    mkdirSync(paths.runDir('omp'), { recursive: true })
    writeFileSync(paths.heartbeatFile('omp', 'stale-1'), '{}')
    utimesSync(paths.heartbeatFile('omp', 'stale-1'), old, old)
    const otherHarness = paths.sessionDir('codex', 'stale-1')
    mkdirSync(otherHarness, { recursive: true })
    utimesSync(otherHarness, old, old)
    const done = join(paths.memoryStateDir(), 'spool', 'done')
    mkdirSync(done, { recursive: true })
    for (const name of ['omp-stale-1.jsonl', 'codex-stale-1.jsonl']) { writeFileSync(join(done, name), '{}\n'); utimesSync(join(done, name), old, old) }
    const active = join(paths.memoryStateDir(), 'spool', 'omp-stale-1.jsonl')
    writeFileSync(active, '{}\n')
    utimesSync(active, old, old)
    mkdirSync(join(paths.memoryStateDir(), 'sessions'), { recursive: true })
    writeFileSync(join(paths.memoryStateDir(), 'sessions', 'omp-stale-1.json'), '{"v":1}\n')
    const removed = defaultDeps().prune(new Set(['keep-1']), now)
    expect(removed.sort()).toEqual([join(done, 'omp-stale-1.jsonl'), paths.heartbeatFile('omp', 'stale-1'), stale].sort())
    for (const p of [kept, fresh, otherHarness, join(done, 'codex-stale-1.jsonl'), active]) expect({ p, exists: existsSync(p) }).toEqual({ p, exists: true })
    expect(defaultDeps().prune(new Set(), now)).toEqual([kept])
    expect(existsSync(fresh)).toBe(true)
  }))
})
