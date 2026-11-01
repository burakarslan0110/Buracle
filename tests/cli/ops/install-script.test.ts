import { describe, expect, test } from 'bun:test'
import { readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run as installRun } from '../../../src/cli/commands/install'
import { scriptDeps, scriptSession, type ScriptDeps } from '../../../src/cli/commands/install-script'
import type { ToolchainItem } from '../../../src/engine/toolchain/index'
import { emptyToolchainState } from '../../../src/engine/toolchain/state'
import * as paths from '../../../src/engine/paths'
import type { Plan } from '../../../src/engine/txn'
import { IS_WINDOWS } from '../../helpers/fake-exe'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { fakeAdapter, fakeCli, makeRepo, memoryIO, withDeps } from './helpers'

// `buracle install --script`: what scripts/install.sh and scripts/install.ps1 hand over to after their own two lines.

const STARTED = 1_800_000_000_000

function filePlan(h: 'claude' | 'codex', home: string, rel: string, content = 'x\n'): Plan {
  return { id: h, harness: h, ops: [{ kind: 'file', path: join(home, rel), content, owner: h }] }
}

async function withScript<T>(over: Partial<ScriptDeps>, fn: () => Promise<T>): Promise<T> {
  const saved = { ...scriptDeps }
  Object.assign(scriptDeps, {
    now: () => STARTED + 48_000,
    doctor: async () => [{ section: 'tools', level: 'ok' as const, check: 'node', detail: '26.13.0' }],
    startUi: async () => ({ state: 'running' as const, url: 'http://127.0.0.1:41777' }),
    addPath: () => ({ changed: false, skipped: 'on-path' as const }),
    ...over,
  })
  try { return await fn() } finally { Object.assign(scriptDeps, saved) }
}

function args(log: string, extra: string[] = []): string[] {
  return ['--script', '--log', log, '--started', String(STARTED), ...extra]
}

const lines = (s: string): string[] => s.split('\n').filter(l => l !== '')

describe('buracle install --script', () => {
  test('a clean run prints exactly Harnesses, Tools, Memory and Result, one line each, and never says to run buracle install', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const log = join(root, 'install.log')
    const adapters = [fakeAdapter('claude', { plan: () => filePlan('claude', home, '.claude/x.json') }), fakeAdapter('codex', { installed: false })]
    await withDeps({ repoRoot: () => repo, adapters: async () => adapters, runCli: fakeCli().runCli }, () => withScript({}, async () => {
      const io = memoryIO()
      expect(await installRun(args(log, ['--yes']), io)).toBe(0)
      expect(lines(io.out())).toEqual([
        '✔ Harnesses       claude · codex not installed',
        '✔ Tools           skipped (BURACLE_NO_TOOLCHAIN)',
        '✔ Memory          brain ok · UI http://127.0.0.1:41777',
        `✔ Result          done in 48 s · log ${log.replace(home, '~')}`,
      ])
      expect(io.out()).not.toContain('buracle install')
      expect(io.out()).not.toContain('\u001b')
      expect(io.err()).toBe('')
      const text = readFileSync(log, 'utf8')
      expect(text).toContain('buracle doctor')
      expect(text).toContain('node')
      // The log holds the health report: readable by this user only when the install creates it.
      if (!IS_WINDOWS) expect(statSync(log).mode & 0o777).toBe(0o600)
    }))
  }))

  test('the toolchain: n of m ready, a failed required tool and a missing optional one are listed under Tools', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const items: ToolchainItem[] = [
      { id: 'tool:rg', group: 'cli', label: 'rg', required: true, status: 'installed', detail: '15.2.0 installed' },
      { id: 'tool:node', group: 'runtime', label: 'node', required: true, status: 'failed', detail: 'node 26.13.0: sha256 aaa does not match the pinned bbb' },
      { id: 'tool:gopls', group: 'lsp', label: 'gopls', required: false, status: 'missing', detail: 'not found; gopls needs go on PATH; install it first, then run `buracle install`' },
    ]
    await withEnv({ BURACLE_NO_TOOLCHAIN: undefined }, () => withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli, runToolchain: async () => ({ items, state: emptyToolchainState(), changed: false }) }, () => withScript({}, async () => {
      const io = memoryIO()
      await installRun(args(join(root, 'i.log'), ['--yes']), io)
      const out = lines(io.out())
      expect(out[1]).toBe('✖ Tools           1/3 ready')
      expect(out.slice(2, 4)).toEqual([
        '    ✖ node         node 26.13.0: sha256 aaa does not match the pinned bbb',
        '    ▲ gopls        optional · not found; gopls needs go on PATH; install it first',
      ])
      expect(io.out()).not.toContain('buracle install')
      expect(home).toBeDefined()
    })))
  }))

  test('a running harness: in a terminal a no leaves it skipped with no command; without a terminal Result names the command once', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const codex = fakeAdapter('codex', {
      plan: (ctx) => {
        if ((ctx as { force?: boolean }).force !== true) throw Object.assign(new Error('Codex is running (pid 42).'), { code: 'HARNESS_BUSY', exitCode: 2 })
        return filePlan('codex', home, '.codex/hooks.json')
      },
    })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli, confirm: async () => false }, () => withScript({}, async () => {
      const tty = memoryIO({ tty: true })
      expect(await installRun(args(join(root, 'a.log')), tty)).toBe(2)
      expect(lines(tty.out())).toContain('    ▲ codex        skipped · still running (you said no)')
      expect(tty.out()).not.toContain('buracle install')
      const pipe = memoryIO()
      expect(await installRun(args(join(root, 'b.log'), ['--yes']), pipe)).toBe(2)
      const out = lines(pipe.out())
      expect(out).toContain('    ▲ codex        skipped · running')
      expect(out.filter(l => l.includes('buracle install'))).toEqual(['    ▲ codex        later: buracle install codex'])
    }))
  }))

  test('removed items, links outside the home folder and a lost ledger: without a terminal each is listed once with `buracle install` in a terminal', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const target = join(home, '.claude', 'settings.json')
    const adapters = [fakeAdapter('claude', { plan: () => filePlan('claude', home, '.claude/settings.json') })]
    await withDeps({ repoRoot: () => repo, adapters: async () => adapters, runCli: fakeCli().runCli }, () => withScript({}, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      unlinkSync(target)
      const removed = memoryIO()
      await installRun(args(join(root, 'r.log'), ['--yes']), removed)
      expect(lines(removed.out()).filter(l => l.includes('buracle install'))).toEqual(['    ▲ removed      1 Buracle item you removed · buracle install (in a terminal)'])

      if (!IS_WINDOWS) {
        const outside = join(root, 'elsewhere.json')
        writeFileSync(outside, '{}\n')
        rmSync(target, { force: true })
        symlinkSync(outside, target)
        const links = memoryIO()
        await installRun(args(join(root, 'l.log'), ['--yes']), links)
        expect(lines(links.out()).filter(l => l.includes('buracle install'))).toEqual(['    ▲ links        1 link out of your home folder · buracle install (in a terminal)'])
        unlinkSync(target)
      }

      rmSync(paths.ownedLedgerFile(), { force: true })
      rmSync(paths.journalDir(), { recursive: true, force: true })
      const ledger = memoryIO()
      await installRun(args(join(root, 'g.log'), ['--yes']), ledger)
      expect(lines(ledger.out()).filter(l => l.includes('buracle install'))).toContain('    ▲ ledger       the ownership ledger is gone · buracle install (in a terminal)')
    }))
  }))

  test('the Memory line: the UI address, the setting off, a UI that did not start', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, async () => {
      const memory = async (over: Partial<ScriptDeps>): Promise<string> => withScript(over, async () => {
        const io = memoryIO()
        await installRun(args(join(root, 'm.log'), ['--yes']), io)
        return lines(io.out()).filter(l => l.includes('Memory') || l.startsWith('    ') && l.includes('ui')).join('\n')
      })
      expect(await memory({ startUi: async () => ({ state: 'off' }) })).toBe('✔ Memory          brain ok · UI off · buracle mem ui')
      expect(await memory({ startUi: async () => ({ state: 'failed', why: 'no free port in 41777-41796' }) })).toBe('▲ Memory          brain ok · UI did not start\n    ▲ ui           no free port in 41777-41796')
    })
  }))

  test('doctor errors make Result a warning that points at the log; a PATH added is one info line', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, () => withScript({
      doctor: async () => [{ section: 'mcp', level: 'error', check: 'context7', detail: 'no answer' }, { section: 'mcp', level: 'error', check: 'semble', detail: 'no answer' }],
      addPath: () => ({ changed: true, file: join(home, '.zshrc') }),
    }, async () => {
      const io = memoryIO()
      expect(await installRun(args(join(home, 'd.log'), ['--yes']), io)).toBe(2)
      const out = lines(io.out())
      expect(out).toHaveLength(5)
      expect(out[3]).toBe('▲ Result          done in 48 s · doctor: 2 errors · log ~/d.log')
      expect(out[4]).toBe('    ℹ PATH         ~/.local/bin added in ~/.zshrc · open a new terminal')
      const note = memoryIO()
      await withScript({ addPath: () => ({ changed: false, skipped: 'windows' as const }) }, () => installRun(args(join(home, 'w.log'), ['--yes', '--path-note', 'added to your user PATH']), note))
      expect(lines(note.out())).toContain('    ℹ PATH         ~/.local/bin added to your user PATH · open a new terminal')
    }))
  }))

  test('a terminal gets a live line while a section runs and lines cut to its width; the result lines stay', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, () => withScript({}, async () => {
      const io = memoryIO()
      Object.assign(io.stdout, { isTTY: true, columns: 60 })
      await withEnv({ TERM: 'xterm-256color', NO_COLOR: undefined, LANG: 'en_US.UTF-8', LC_ALL: undefined, LC_CTYPE: undefined }, () => installRun(args(join(home, 'a-rather-long-name-for-the-install-log-file.log'), ['--yes']), io))
      expect(io.out()).toContain('\r\u001b[2K')
      // What the terminal shows: on each line, what follows the last carriage return.
      const finalLines = io.out().split('\n').map(l => (l.split('\r').pop() ?? '').replace(/\u001b\[[0-9;]*[mK]/g, '')).filter(l => l.startsWith('✔') || l.startsWith('▲') || l.startsWith('✖'))
      expect(finalLines.map(l => l.split(/\s{2,}/)[0])).toEqual(['▲ Harnesses', '✔ Tools', '✔ Memory', '✔ Result'])
      expect(Math.max(...finalLines.map(l => [...l].length))).toBeLessThanOrEqual(59)
    }))
  }))

  test('on an 80-column terminal the log path is never cut: a Result line too long for it moves the path to its own line', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const log = join(home, '.buracle', 'logs', 'install-2026-11-01.log')
    const run = async (doctorErrors: number): Promise<string[]> => withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, () => withScript({
      doctor: async () => Array.from({ length: doctorErrors }, (_, i) => ({ section: 'mcp', level: 'error' as const, check: `s${i}`, detail: 'no answer' })),
    }, async () => {
      const io = memoryIO()
      Object.assign(io.stdout, { isTTY: true, columns: 80 })
      await withEnv({ TERM: 'xterm-256color', NO_COLOR: undefined, LANG: 'en_US.UTF-8', LC_ALL: undefined, LC_CTYPE: undefined }, () => installRun(args(log, ['--yes']), io))
      return io.out().split('\n').map(l => (l.split('\r').pop() ?? '').replace(/\u001b\[[0-9;]*[mK]/g, '')).filter(l => /^(\s{4})?[✔▲✖ℹ] /.test(l))
    }))
    const short = await run(0)
    expect(short.find(l => l.startsWith('✔ Result'))).toBe('✔ Result          done in 48 s · log ~/.buracle/logs/install-2026-11-01.log')
    const long = await run(4)
    expect(long.find(l => l.startsWith('▲ Result'))).toBe('▲ Result          done in 48 s · doctor: 4 errors')
    expect(long).toContain('    ℹ log          ~/.buracle/logs/install-2026-11-01.log')
    expect(Math.max(...long.map(l => [...l].length))).toBeLessThanOrEqual(79)
  }))

  test('the live line names the phase that runs: the toolchain under Tools, the harness writes under Harnesses, then Memory; no live line while a question waits', () => withSandbox(async ({ home }) => {
    const io = memoryIO()
    Object.assign(io.stdout, { isTTY: true, columns: 100 })
    let atQuestion = ''
    await withDeps({ confirm: async () => { atQuestion = io.out(); return true } }, () => withEnv({ TERM: 'xterm-256color', NO_COLOR: undefined, LANG: 'en_US.UTF-8', LC_ALL: undefined, LC_CTYPE: undefined }, async () => {
      const session = scriptSession(io, { log: join(home, 'p.log'), startedMs: STARTED, interactive: true })
      // The order the install flow runs in: the build check, the toolchain, the harness plan (with its question), the
      // harness writes, the memory.
      session.steps.start('build', 'Checking the generated files')
      session.steps.done('build', 'ok', 'Generated files are up to date')
      session.steps.list.start('tool:codegraph', 'codegraph  npm @colbymchenry/codegraph')
      session.steps.list.finish('tool:codegraph', 'ok', 'codegraph installed')
      session.steps.start('plan', 'Finding the harnesses and planning the changes')
      expect(await session.ask?.('Put back 1 Buracle item(s) you removed?')).toBe(true)
      session.steps.start('txn:claude', "Writing Claude Code's configuration")
      session.steps.start('memory', 'Checking the memory')
      session.steps.stop()
    }))
    const plain = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '')
    const frames = [...plain(io.out()).matchAll(/\r\u001b\[2K\S+ ([A-Za-z]+) +([^\r]*)/g)].map(m => `${m[1]}: ${m[2]}`)
    expect(frames).toEqual([
      'Harnesses: Checking the generated files',
      'Tools: codegraph  npm @colbymchenry/codegraph',
      'Harnesses: Finding the harnesses and planning the changes',
      "Harnesses: Writing Claude Code's configuration",
      'Memory: Checking the memory',
    ])
    // When the question is asked, the live line has just been cleared.
    expect(atQuestion.endsWith('\r\u001b[2K')).toBe(true)
  }))

  test('a terminal that reports no width (a pty with 0 columns) gets 80 columns, not lines cut to nothing', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, () => withScript({}, async () => {
      const io = memoryIO()
      Object.assign(io.stdout, { isTTY: true, columns: 0 })
      await withEnv({ TERM: 'xterm-256color', NO_COLOR: undefined, LANG: 'en_US.UTF-8', LC_ALL: undefined, LC_CTYPE: undefined }, () => installRun(args(join(home, 'z.log'), ['--yes']), io))
      const finalLines = io.out().split('\n').map(l => (l.split('\r').pop() ?? '').replace(/\u001b\[[0-9;]*[mK]/g, '')).filter(l => l.startsWith('✔') || l.startsWith('▲') || l.startsWith('✖'))
      expect(finalLines.map(l => l.split(/\s{2,}/)[0])).toEqual(['▲ Harnesses', '✔ Tools', '✔ Memory', '✔ Result'])
      expect(finalLines.find(l => l.startsWith('✔ Result'))).toContain('log ~/z.log')
    }))
  }))
})
