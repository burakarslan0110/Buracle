import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dashboardFits, fileSource, REEXEC_ENV, resultLine, runDashboard, type ChildHandle, type DashData, type DashSource } from '../../src/cli/dashboard'
import type { DashRow } from '../../src/cli/ui/dashboard'
import type { Key } from '../../src/cli/ui/keys'
import { makeStyle } from '../../src/cli/ui/style'
import type { Terminal } from '../../src/cli/ui/terminal'
import * as paths from '../../src/engine/paths'
import { installRecordFile } from '../../src/engine/update/install-core'
import { writeHealth } from '../../src/engine/update/mcp'
import type { Verifier } from '../../src/engine/update/refresh'
import { UPDATE_KINDS, writeUpdatesCache } from '../../src/engine/update/updates-cache'
import { fakeExe, onlyPath } from '../helpers/fake-exe'
import { withEnv, withSandbox } from '../helpers/sandbox'

const plain = makeStyle(0, { unicode: false })
const COMMAND = ['/bin/bun', '/rt/a/src/cli/main.ts'] as const
const SHIM = '/home/u/.buracle/bin/buracle'

const ROWS: DashRow[] = [
  { id: 'buracle', section: 'buracle', label: 'Buracle', version: '0.5.0', state: 'ok', status: 'runtime current', action: { argv: ['doctor', 'runtime'], label: 'check the runtime' } },
  { id: 'harness:codex', section: 'harnesses', label: 'Codex', version: '0.164.0', state: 'ok', status: 'Buracle installed', update: '0.165.0', action: { argv: ['update', 'codex'], label: 'update Codex' } },
]

async function until(cond: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 5))
  }
}

function fakeTerm(size = { columns: 100, rows: 30 }) {
  const frames: string[][] = []
  const events: string[] = []
  const keys: Key[] = []
  let waiter: ((k: Key) => void) | undefined
  const next = (): Promise<Key> => {
    const k = keys.shift()
    return k !== undefined ? Promise.resolve(k) : new Promise<Key>(r => { waiter = r })
  }
  const term: Terminal = {
    size: () => size,
    draw: l => { frames.push(l); events.push('draw') },
    nextKey: () => { events.push('nextKey'); return next() },
    anyKey: () => { events.push('anyKey'); return next() },
    onResize: () => {  },
    suspend: () => { events.push('suspend') },
    resume: () => { events.push('resume') },
    close: () => { events.push('close') },
  }
  const press = (k: Key): void => {
    const w = waiter
    waiter = undefined
    if (w !== undefined) w(k)
    else keys.push(k)
  }
  return { term, frames, events, press, waiting: () => waiter !== undefined }
}

function fakeSource(rows: DashRow[] = ROWS): DashSource & { reads: number } {
  const s = { reads: 0, read: (): DashData => { s.reads++; return { version: '0.5.0', rows } }, fill: async () => {  } }
  return s
}

function fakeSpawn() {
  const calls: Array<{ argv: string[], env: Record<string, string | undefined> }> = []
  const children: Array<{ exit(code: number): void, kills: string[] }> = []
  const spawn = (argv: readonly string[], env: Record<string, string | undefined>): ChildHandle => {
    calls.push({ argv: [...argv], env })
    let exit!: (code: number) => void
    const kills: string[] = []
    children.push({ exit: code => exit(code), kills })
    return { exited: new Promise<number>(r => { exit = r }), kill: sig => { kills.push(sig) } }
  }
  return { spawn, calls, children }
}

function fakeSignals() {
  const handlers = new Set<() => void>()
  return { host: { on: (_s: 'SIGINT', f: () => void) => { handlers.add(f) }, off: (_s: 'SIGINT', f: () => void) => { handlers.delete(f) } }, emit: () => { for (const f of [...handlers]) f() }, count: () => handlers.size }
}

function start(o: { source?: DashSource, env?: Record<string, string | undefined>, shim?: () => { path: string, main: string } | undefined } = {}) {
  const t = fakeTerm()
  const sp = fakeSpawn()
  const sig = fakeSignals()
  let out = ''
  const done = runDashboard({
    terminal: t.term, spawn: sp.spawn, now: () => 0, source: o.source ?? fakeSource(), command: COMMAND, style: plain,
    shim: o.shim ?? (() => ({ path: SHIM, main: '/rt/a/src/cli/main.ts' })), env: o.env ?? { PATH: '/usr/bin' }, signals: sig.host, write: s => { out += s },
  })
  return { ...t, ...sp, sig, done, out: () => out }
}

const frame = (d: { frames: string[][] }): string => d.frames.at(-1)?.join('\n') ?? ''

async function openDetail(d: ReturnType<typeof start>): Promise<void> {
  await until(d.waiting, 'the first key')
  d.press({ char: 'v' })
  await until(() => d.waiting() && frame(d).includes('Harnesses'), 'the detailed view')
}

describe('the main menu comes first', () => {
  test('it shows the choices and the waiting updates; Enter runs the selected command and its result shows in the menu', async () => {
    const d = start()
    await until(d.waiting, 'the first key')
    expect(frame(d)).toContain('Install or repair')
    expect(frame(d)).toContain('Detailed view')
    expect(frame(d)).toContain('1 update waiting')
    expect(frame(d)).not.toContain('Harnesses')
    d.press('enter')
    await until(() => d.calls.length === 1, 'the install child')
    expect(d.calls[0]?.argv).toEqual([...COMMAND, 'install'])
    d.children[0]?.exit(0)
    await until(() => d.events.includes('anyKey'), 'the key prompt')
    d.press({ char: 'x' })
    await until(() => d.events.filter(e => e === 'nextKey').length === 2, 'the menu again')
    expect(frame(d)).toContain('buracle install: done')
    expect(frame(d)).toContain('Detailed view')
    d.press({ char: 'q' })
    expect(await d.done).toBe(0)
    expect(d.events.filter(e => e === 'close')).toEqual(['close'])
  })

  test('Detailed view opens the dashboard; Esc there returns to the menu, Esc in the menu quits', async () => {
    const d = start()
    await until(d.waiting, 'the first key')
    for (let i = 0; i < 4; i++) d.press('down')
    await until(() => d.events.filter(e => e === 'nextKey').length === 5, 'the moves')
    d.press('enter')
    await until(() => d.waiting() && frame(d).includes('Harnesses'), 'the detailed view')
    expect(frame(d)).toContain('esc menu')
    d.press('escape')
    await until(() => d.waiting() && frame(d).includes('Install or repair'), 'the menu')
    expect(frame(d)).toContain('  > Detailed view')
    expect(d.events).not.toContain('close')
    d.press('escape')
    expect(await d.done).toBe(0)
    expect(d.calls).toHaveLength(0)
    expect(d.events.filter(e => e === 'close')).toEqual(['close'])
  })

  test('q quits from the detailed view too', async () => {
    const d = start()
    await openDetail(d)
    d.press({ char: 'q' })
    expect(await d.done).toBe(0)
    expect(d.calls).toHaveLength(0)
  })
})

describe('the dashboard runs actions as child commands', () => {
  test('Enter runs the update of a row that has one, else its doctor topic; the result and "press any key to return" follow', async () => {
    const d = start()
    await openDetail(d)
    d.press('enter')
    await until(() => d.calls.length === 1, 'the doctor child')
    expect(d.calls[0]?.argv).toEqual([...COMMAND, 'doctor', 'runtime'])
    expect(d.calls[0]?.env).toEqual({ PATH: '/usr/bin' })
    expect(d.events).toContain('suspend')
    d.children[0]?.exit(0)
    await until(() => d.events.includes('anyKey'), 'the key prompt')
    expect(d.out()).toContain('\nburacle doctor runtime\n')
    expect(d.out()).toContain('\ndone\npress any key to return\n')
    d.press({ char: 'x' })
    await until(() => d.events.filter(e => e === 'nextKey').length === 3, 'the dashboard again')
    expect(d.events.slice(d.events.indexOf('anyKey'))).toEqual(['anyKey', 'resume', 'draw', 'nextKey'])
    expect(frame(d)).toContain('buracle doctor runtime: done')
    expect(frame(d)).toContain('Harnesses')
    d.press({ char: 'j' })
    await until(d.waiting, 'the move')
    d.press('enter')
    await until(() => d.calls.length === 2, 'the update child')
    expect(d.calls[1]?.argv).toEqual([...COMMAND, 'update', 'codex'])
    d.children[1]?.exit(0)
    await until(() => d.events.filter(e => e === 'anyKey').length === 2, 'the second prompt')
    d.press({ char: 'x' })
    await until(() => d.events.filter(e => e === 'nextKey').length === 5, 'the dashboard again')
    d.press({ char: 'q' })
    expect(await d.done).toBe(0)
    expect(d.events.filter(e => e === 'close')).toEqual(['close'])
  })

  test('Ctrl-C while a command runs reaches only the command; the dashboard stays open', async () => {
    const d = start()
    await until(d.waiting, 'the first key')
    d.press({ char: 'u' })
    await until(() => d.calls.length === 1, 'the update child')
    expect(d.calls[0]?.argv).toEqual([...COMMAND, 'update'])
    expect(d.sig.count()).toBe(1)
    d.sig.emit()
    expect(d.children[0]?.kills).toEqual(['SIGINT'])
    expect(d.events).not.toContain('close')
    d.children[0]?.exit(130)
    await until(() => d.events.includes('anyKey'), 'the key prompt')
    expect(d.out()).toContain('\nfailed (exit code 130)\npress any key to return\n')
    d.press('ctrl-c')
    await until(() => d.events.filter(e => e === 'nextKey').length === 2, 'the dashboard again')
    expect(d.sig.count()).toBe(0)
    expect(d.events).not.toContain('close')
    d.press({ char: 'q' })
    expect(await d.done).toBe(0)
  })

  test('exit 2 and exit 1 are reported as such', async () => {
    expect(resultLine(0)).toBe('done')
    expect(resultLine(2)).toBe('done, with points that need your attention (exit code 2)')
    expect(resultLine(1)).toBe('failed (exit code 1)')
    const d = start()
    for (const [n, code] of [[0, 2], [1, 1]] as const) {
      await until(d.waiting, 'a key')
      d.press({ char: 'd' })
      await until(() => d.calls.length === n + 1, 'the child')
      d.children[n]?.exit(code)
      await until(() => d.events.filter(e => e === 'anyKey').length === n + 1, 'the key prompt')
      d.press({ char: 'x' })
    }
    expect(d.out()).toContain('done, with points that need your attention (exit code 2)\npress any key to return')
    expect(d.out()).toContain('failed (exit code 1)\npress any key to return')
    await until(d.waiting, 'a key')
    d.press({ char: 'q' })
    expect(await d.done).toBe(0)
  })

  test('the letter keys run their commands and r reads the data again without running anything', async () => {
    const source = fakeSource()
    const d = start({ source })
    await openDetail(d)
    const want: Array<[string, string[]]> = [['c', ['update', '--check']], ['i', ['install']], ['m', ['mem', 'ui', '--open']]]
    for (const [i, [key, argv]] of want.entries()) {
      await until(d.waiting, 'a key')
      d.press({ char: key })
      await until(() => d.calls.length === i + 1, `the ${key} child`)
      expect(d.calls[i]?.argv).toEqual([...COMMAND, ...argv])
      d.children[i]?.exit(0)
      await until(() => d.events.filter(e => e === 'anyKey').length === i + 1, 'the key prompt')
      d.press({ char: 'x' })
    }
    await until(d.waiting, 'a key')
    const reads = source.reads
    d.press({ char: 'r' })
    await until(() => source.reads === reads + 1, 'the reload')
    expect(d.calls).toHaveLength(want.length)
    await until(d.waiting, 'a key')
    d.press({ char: 'q' })
    expect(await d.done).toBe(0)
  })

  test('a shim that points at new code after a command starts the dashboard once more from it, and only once', async () => {
    let main = '/rt/a/src/cli/main.ts'
    const d = start({ shim: () => ({ path: SHIM, main }) })
    await until(d.waiting, 'the first key')
    d.press({ char: 'i' })
    await until(() => d.calls.length === 1, 'the install child')
    main = '/rt/b/src/cli/main.ts'
    d.children[0]?.exit(0)
    await until(() => d.events.includes('anyKey'), 'the key prompt')
    d.press({ char: 'x' })
    await until(() => d.calls.length === 2, 'the new dashboard')
    expect(d.calls[1]).toEqual({ argv: [SHIM], env: { PATH: '/usr/bin', [REEXEC_ENV]: '1' } })
    expect(d.events).toContain('close')
    d.children[1]?.exit(7)
    expect(await d.done).toBe(7)

    let again = '/rt/a/src/cli/main.ts'
    const r = start({ shim: () => ({ path: SHIM, main: again }), env: { [REEXEC_ENV]: '1' } })
    await until(r.waiting, 'the first key')
    r.press({ char: 'i' })
    await until(() => r.calls.length === 1, 'the install child')
    again = '/rt/c/src/cli/main.ts'
    r.children[0]?.exit(0)
    await until(() => r.events.includes('anyKey'), 'the key prompt')
    r.press({ char: 'x' })
    await until(() => r.events.filter(e => e === 'nextKey').length === 2, 'the same dashboard')
    expect(r.calls).toHaveLength(1)
    r.press({ char: 'q' })
    expect(await r.done).toBe(0)
  })
})

describe('the terminal comes back on every way out', () => {
  test('a failure while the dashboard starts still closes the terminal, once', async () => {
    const t = fakeTerm()
    const source: DashSource = { read: () => { throw new Error('state file unreadable') }, fill: async () => {  } }
    const run = runDashboard({ terminal: t.term, spawn: fakeSpawn().spawn, now: () => 0, source, command: COMMAND, style: plain, shim: () => undefined, env: {}, signals: fakeSignals().host, write: () => {  } })
    await expect(run).rejects.toThrow('state file unreadable')
    expect(t.events.filter(e => e === 'close')).toEqual(['close'])
  })
})

describe('the dashboard data', () => {
  test('the first frame comes from the state files while a harness binary is still answering; its version follows', () => withSandbox(async ({ root, buracleHome }) => {
    const bin = join(root, 'bin')
    fakeExe(join(bin, 'claude'), "await Bun.sleep(1000)\nconsole.log('2.1.300 (Claude Code)')")
    const state = join(buracleHome, 'state')
    mkdirSync(state, { recursive: true })
    writeFileSync(paths.userConfigFile(), 'harnesses:\n  codex: { enabled: false }\n  opencode: { enabled: false }\n  omp: { enabled: false }\n')
    const at = '2026-10-18T10:00:00.000Z'
    const now = Date.parse('2026-10-18T12:00:00.000Z')
    mkdirSync(dirname(installRecordFile()), { recursive: true })
    writeFileSync(installRecordFile(), JSON.stringify({ v: 1, plans: { claude: { keys: [] } }, execUndone: {} }))
    writeFileSync(paths.updatesFile(), JSON.stringify({ v: 1, checked_at: at, kinds: ['harness', 'mcp'], held: [], errors: [], items: [
      { kind: 'harness', id: 'claude', current: '2.1.300', latest: '2.1.301', action: 'self-update', risk: 'low', source: 'native installer' },
      { kind: 'mcp', id: 'context7', current: '2.1.0', latest: '2.2.0', action: 'bump-pin', risk: 'low' },
      { kind: 'plugins', id: 'helper@acme', current: '1.0.0', latest: '1.1.0', action: 'plugin-update', risk: 'low' },
      { kind: 'pricing', id: 'pricing.yaml', current: null, latest: null, action: 'refresh', risk: 'low' },
      { kind: 'skills', id: 'mine', current: null, latest: null, action: 'clone', risk: 'low' },
    ] }))
    writeFileSync(paths.healthFile(), JSON.stringify({ v: 1, checked_at: at, mcp: { context7: { status: 'ok', transport: 'stdio', tools: 2, checked_at: at }, 'web-search': { status: 'down', error: 'exited with code 1', checked_at: at } } }))
    writeFileSync(paths.toolchainStateFile(), JSON.stringify({ v: 1, updated_at: at, system: {}, packages: { 'npm:@upstash/context7-mcp': { registry: 'npm', name: '@upstash/context7-mcp', version: '2.1.0', dir: join(buracleHome, 'toolchain', 'x'), bins: {}, installed_at: at } } }))
    writeFileSync(paths.memoryUiStateFile(), JSON.stringify({ pid: process.pid, port: 41777, host: '127.0.0.1', url: 'http://127.0.0.1:41777', startedAt: at }))
    await withEnv({ PATH: onlyPath(bin) }, async () => {
      const src = await fileSource(() => now)
      const t0 = Date.now()
      const first = src.read()
      expect(Date.now() - t0).toBeLessThan(500)
      const row = (d: DashData, id: string) => d.rows.find(r => r.id === id)
      expect(first.checkedAt).toBe('2 h ago')
      expect(row(first, 'harness:claude')).toMatchObject({ version: '…', state: 'ok', status: 'Buracle installed', update: '2.1.301', source: 'native installer', action: { argv: ['update', 'claude'] } })
      expect(row(first, 'harness:codex')).toMatchObject({ state: 'off', status: 'off in config', action: { argv: ['doctor', 'codex'] } })
      expect(row(first, 'mcp:context7')).toMatchObject({ version: '2.1.0', state: 'ok', status: 'handshake ok, 2 tools', update: '2.2.0', action: { argv: ['update', 'context7'] } })
      expect(row(first, 'mcp:web-search')).toMatchObject({ state: 'err', status: 'down', detail: 'exited with code 1', action: { argv: ['doctor', 'mcp'] } })
      expect(row(first, 'memory')).toMatchObject({ status: 'localhost:41777', action: { argv: ['doctor', 'memory'] } })
      expect(row(first, 'buracle')).toMatchObject({ status: 'checking the runtime', action: { argv: ['doctor', 'runtime'] } })
      expect(row(first, 'rowless-updates')).toMatchObject({ section: 'buracle', status: '3 updates waiting', update: 'skills, plugins, pricing', action: { argv: ['update', 'skills', 'plugins', 'pricing'] } })
      expect(first.rows.filter(r => r.section === 'tools').every(r => r.action?.argv.join(' ') === 'doctor tools' || r.action?.argv[0] === 'update')).toBe(true)

      const t = fakeTerm()
      const done = runDashboard({ terminal: t.term, spawn: fakeSpawn().spawn, now: () => now, source: src, command: COMMAND, style: plain, shim: () => undefined, env: {}, signals: fakeSignals().host, write: () => {  } })
      await until(() => t.frames.length > 0, 'the first frame')
      const firstAt = Date.now() - t0
      expect(t.frames[0]?.join('\n')).toContain('3 updates waiting')
      expect(t.frames[0]?.join('\n')).toContain('updates checked 2 h ago')
      t.press({ char: 'v' })
      await until(() => t.frames.some(f => f.join('\n').includes('Harnesses')), 'the detailed view')
      expect(t.frames.find(f => f.join('\n').includes('Harnesses'))?.join('\n')).not.toContain('2.1.300')
      await until(() => t.frames.some(f => f.join('\n').includes('2.1.300')), 'the claude version', 10_000)
      expect(Date.now() - t0).toBeGreaterThan(firstAt + 500)
      expect(t.frames.at(-1)?.join('\n')).toContain('not installed')
      expect(t.frames.at(-1)?.join('\n')).not.toContain('checking the runtime')
      t.press({ char: 'q' })
      expect(await done).toBe(0)
    })
  }), 15_000)
})

describe('the dashboard verifies what is stale while it is open', () => {
  const NOW = Date.parse('2026-10-25T12:00:00.000Z')
  const iso = new Date(NOW).toISOString()

  // Records what it was asked and writes the result where doctor and update write theirs, as the real one does.
  function fakeVerifier(opts: { hold?: boolean, failMcp?: string } = {}) {
    const calls: string[] = []
    const gates = new Map<string, () => void>()
    const wait = async (key: string): Promise<void> => { if (opts.hold === true) await new Promise<void>(r => gates.set(key, r)) }
    const verifier: Verifier = {
      async mcp(id) {
        calls.push(`mcp:${id}`)
        await wait(`mcp:${id}`)
        if (id === opts.failMcp) throw new Error('could not write health.json')
        writeHealth({ mcp: { [id]: { status: 'ok', transport: 'stdio', tools: 3, ms: 12, version: '4.5.6', checked_at: iso } } }, iso)
      },
      async tool(t) {
        calls.push(`tool:${t.name}`)
        await wait(`tool:${t.name}`)
        writeHealth({ tools: { [t.name]: { status: 'ok', version: '9.9.9', checked_at: iso } } }, iso)
      },
      async updates() {
        calls.push('updates')
        await wait('updates')
        writeUpdatesCache({ checked_at: iso, kinds: [...UPDATE_KINDS], items: [], held: [], errors: [] })
      },
    }
    return { verifier, calls, release: () => { for (const g of [...gates.values()]) g(); gates.clear() }, gated: () => [...gates.keys()] }
  }

  // The toolchain holds context7 only; the shim exists; every harness is off so only Buracle's own files are read.
  function setup(buracleHome: string): void {
    mkdirSync(join(buracleHome, 'state'), { recursive: true })
    mkdirSync(join(buracleHome, 'bin'), { recursive: true })
    writeFileSync(paths.shimPath(), '#!/bin/sh\n')
    writeFileSync(paths.userConfigFile(), 'harnesses:\n  claude: { enabled: false }\n  codex: { enabled: false }\n  opencode: { enabled: false }\n  omp: { enabled: false }\n')
    writeFileSync(paths.toolchainStateFile(), JSON.stringify({ v: 1, updated_at: iso, system: {}, packages: { 'npm:@upstash/context7-mcp': { registry: 'npm', name: '@upstash/context7-mcp', version: '2.1.0', dir: join(buracleHome, 'toolchain', 'x'), bins: {}, installed_at: iso } } }))
  }

  const row = (d: DashData | undefined, id: string) => d?.rows.find(r => r.id === id)

  test('stale servers, stale tools and the update check are verified; a row says it is being checked until its result is in', () => withSandbox(async ({ buracleHome }) => {
    setup(buracleHome)
    const v = fakeVerifier({ hold: true })
    const src = await fileSource(() => NOW, v.verifier)
    expect(row(src.read(), 'mcp:context7')).toMatchObject({ state: 'off', status: 'not checked yet' })
    const seen: DashData[] = []
    const done = src.fill(d => { seen.push(d) })
    await until(() => seen.some(d => row(d, 'mcp:context7')?.status === 'checking…'), 'the checking row')
    const during = seen.find(d => row(d, 'mcp:context7')?.status === 'checking…')
    expect(row(during, 'mcp:context7')).toMatchObject({ state: 'off', detail: 'running the handshake' })
    expect(during?.working).toContain('verifying')
    expect(during?.working).toContain('checking for updates')
    v.release()
    await done
    const last = seen.at(-1)
    expect(row(last, 'mcp:context7')).toMatchObject({ state: 'ok', status: 'handshake ok, 3 tools' })
    expect(row(last, 'mcp:context7')?.detail).toBe('verified just now · 12 ms · v4.5.6')
    expect(row(last, 'tool:bun')).toMatchObject({ state: 'ok', version: '9.9.9' })
    expect(last?.working).toBeUndefined()
    expect(last?.checkedAt).toBe('just now')
    expect(v.calls).toContain('updates')
    expect(v.calls).toContain('tool:bun')
  }), 15_000)

  test('a handshake never downloads: servers whose package is not in the toolchain are left for `buracle install`', () => withSandbox(async ({ buracleHome }) => {
    setup(buracleHome)
    const v = fakeVerifier()
    const src = await fileSource(() => NOW, v.verifier)
    src.read()
    await src.fill(() => {  })
    const probed = v.calls.filter(c => c.startsWith('mcp:')).sort()
    expect(probed).toEqual(['mcp:buracle-memory', 'mcp:context7', 'mcp:grep', 'mcp:lsp'])
    expect(probed).not.toContain('mcp:codegraph')
    expect(probed).not.toContain('mcp:semble')
  }), 15_000)

  test('fresh results are trusted; a forced recheck repeats everything', () => withSandbox(async ({ buracleHome }) => {
    setup(buracleHome)
    const v = fakeVerifier()
    const src = await fileSource(() => NOW, v.verifier)
    src.read()
    await src.fill(() => {  })
    const first = v.calls.length
    expect(first).toBeGreaterThan(5)
    src.read()
    await src.fill(() => {  })
    expect(v.calls.length).toBe(first)
    src.read()
    await src.fill(() => {  }, { force: true })
    expect(v.calls.length).toBe(first * 2)
  }), 15_000)

  test('a result older than six hours is checked again, and a down server on every open', () => withSandbox(async ({ buracleHome }) => {
    setup(buracleHome)
    const old = new Date(NOW - 7 * 3_600_000).toISOString()
    writeFileSync(paths.healthFile(), JSON.stringify({ v: 1, checked_at: iso, mcp: {
      context7: { status: 'ok', transport: 'stdio', tools: 2, checked_at: iso },
      lsp: { status: 'ok', transport: 'stdio', tools: 2, checked_at: old },
      'buracle-memory': { status: 'down', transport: 'stdio', error: 'exited', checked_at: iso },
      grep: { status: 'ok', transport: 'http', tools: 1, checked_at: iso },
    } }))
    const v = fakeVerifier()
    const src = await fileSource(() => NOW, v.verifier)
    src.read()
    await src.fill(() => {  })
    expect(v.calls.filter(c => c.startsWith('mcp:')).sort()).toEqual(['mcp:buracle-memory', 'mcp:lsp'])
  }), 15_000)

  test('asking again while a verification runs starts nothing new; the newest listener hears the result', () => withSandbox(async ({ buracleHome }) => {
    setup(buracleHome)
    const v = fakeVerifier({ hold: true })
    const src = await fileSource(() => NOW, v.verifier)
    src.read()
    const a: DashData[] = []
    const b: DashData[] = []
    const first = src.fill(d => { a.push(d) })
    await until(() => v.gated().length > 3, 'the verifier to start')
    const started = v.calls.length
    src.read()
    const second = src.fill(d => { b.push(d) })
    expect(v.calls.length).toBe(started)
    v.release()
    await Promise.all([first, second])
    expect(v.calls.length).toBe(started)
    expect(row(b.at(-1), 'mcp:context7')?.status).toBe('handshake ok, 3 tools')
  }), 15_000)

  test('a verification that itself fails is shown on its row and does not stop the others', () => withSandbox(async ({ buracleHome }) => {
    setup(buracleHome)
    const v = fakeVerifier({ failMcp: 'context7' })
    const src = await fileSource(() => NOW, v.verifier)
    src.read()
    const seen: DashData[] = []
    await src.fill(d => { seen.push(d) })
    expect(row(seen.at(-1), 'mcp:context7')).toMatchObject({ state: 'warn', status: 'check failed', detail: 'could not write health.json' })
    expect(row(seen.at(-1), 'mcp:lsp')).toMatchObject({ state: 'ok' })
    expect(seen.at(-1)?.working).toBeUndefined()
  }), 15_000)

  test('a server that runs through the buracle shim says so when there is no shim, instead of inviting a handshake that cannot run', () => withSandbox(async ({ buracleHome }) => {
    setup(buracleHome)
    const withShim = (await fileSource(() => NOW)).read().rows
    expect(row({ version: '', rows: withShim }, 'mcp:lsp')).toMatchObject({ state: 'off', status: 'not checked yet' })
    rmSync(paths.shimPath())
    const rows = (await fileSource(() => NOW)).read().rows
    expect(row({ version: '', rows }, 'mcp:lsp')).toMatchObject({ state: 'warn', status: 'not installed' })
    expect(row({ version: '', rows }, 'mcp:lsp')?.detail).toContain('shim')
    expect(row({ version: '', rows }, 'mcp:buracle-memory')).toMatchObject({ state: 'warn', status: 'not installed' })
    // A remote server needs no shim.
    expect(row({ version: '', rows }, 'mcp:grep')).toMatchObject({ state: 'off', status: 'not checked yet' })
  }), 15_000)

  test('language servers are rows of their own section, the other tools stay under Tools', () => withSandbox(async ({ buracleHome }) => {
    setup(buracleHome)
    const rows = (await fileSource(() => NOW)).read().rows
    expect(row({ version: '', rows }, 'tool:pyright')?.section).toBe('lsp')
    expect(row({ version: '', rows }, 'tool:typescript-language-server')?.section).toBe('lsp')
    expect(row({ version: '', rows }, 'tool:jq')?.section).toBe('tools')
    expect(row({ version: '', rows }, 'tool:codegraph')?.section).toBe('tools')
  }), 15_000)

  test('without a verifier the dashboard only reads files, as before', () => withSandbox(async ({ buracleHome }) => {
    setup(buracleHome)
    const src = await fileSource(() => NOW)
    src.read()
    const seen: DashData[] = []
    await src.fill(d => { seen.push(d) })
    expect(seen.some(d => d.working !== undefined)).toBe(false)
    expect(row(src.read(), 'mcp:context7')?.status).toBe('not checked yet')
  }), 15_000)

  test('r asks for a forced recheck; the other ways to refresh are not forced', async () => {
    const forced: Array<boolean | undefined> = []
    const source: DashSource = { read: () => ({ version: '0.5.0', rows: ROWS }), fill: async (_changed, o) => { forced.push(o?.force) } }
    const d = start({ source })
    await until(d.waiting, 'the first key')
    d.press({ char: 'v' })
    await until(() => d.waiting() && frame(d).includes('Harnesses'), 'the detailed view')
    d.press({ char: 'r' })
    await until(() => forced.length === 2, 'the forced fill')
    expect(forced[0]).toBeUndefined()
    expect(forced[1]).toBe(true)
    d.press({ char: 'q' })
    await d.done
  })
})

describe('the dashboard hints follow toolchain.autoInstall', () => {
  test('with the switch off, a missing tool, a server outside the toolchain and a missing CortexDB name the switch instead of i alone', () => withSandbox(async ({ root, buracleHome }) => {
    mkdirSync(join(buracleHome, 'state'), { recursive: true })
    writeFileSync(paths.userConfigFile(), 'harnesses:\n  claude: { enabled: false }\n  codex: { enabled: false }\n  opencode: { enabled: false }\n  omp: { enabled: false }\ntoolchain:\n  autoInstall: false\n')
    writeFileSync(paths.healthFile(), JSON.stringify({ v: 1, checked_at: 'x', mcp: {}, tools: { jq: { status: 'missing', checked_at: 'x' } } }))
    await withEnv({ PATH: join(root, 'nothing'), BURACLE_CORTEXDB_BIN: join(root, 'no-cortexdb') }, async () => {
      const rows = (await fileSource(() => 0)).read().rows
      const want = 'buracle config set toolchain.autoInstall true'
      expect(rows.find(r => r.id === 'tool:jq')?.detail).toContain(want)
      expect(rows.find(r => r.id === 'mcp:context7')?.detail).toContain(want)
      expect(rows.find(r => r.id === 'memory')?.detail).toContain(want)
    })
    writeFileSync(paths.userConfigFile(), 'toolchain:\n  autoInstall: true\n')
    await withEnv({ PATH: join(root, 'nothing'), BURACLE_CORTEXDB_BIN: join(root, 'no-cortexdb') }, async () => {
      const rows = (await fileSource(() => 0)).read().rows
      expect(rows.find(r => r.id === 'memory')?.detail).toContain('press i to install it')
    })
  }))
})

describe('when `buracle` opens the dashboard', () => {
  test('only with a terminal on both ends, no --json, a TERM that is not dumb and at least 40 by 10', () => {
    const ok = { stdinTTY: true, stdoutTTY: true, json: false, term: 'xterm-256color', columns: 40, rows: 10 }
    expect(dashboardFits(ok)).toBe(true)
    expect(dashboardFits({ ...ok, term: undefined })).toBe(true)
    for (const no of [{ stdinTTY: false }, { stdoutTTY: false }, { json: true }, { term: 'dumb' }, { columns: 39 }, { rows: 9 }, { columns: undefined }]) {
      expect({ no, fits: dashboardFits({ ...ok, ...no }) }).toEqual({ no, fits: false })
    }
  })
})
