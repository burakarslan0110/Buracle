import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cmTmpDir, writeCmInput } from '../../src/adapters/shared/context-mode/client'
import { main, type CommandIO } from '../../src/cli/router'
import { cmSessionsDir, cmStorageRoot } from '../../src/engine/context-mode'
import { installCmFixture } from '../fixtures/context-mode/fixture'
import { withEnv, withSandbox } from '../helpers/sandbox'

function io(stdin = ''): Omit<CommandIO, 'flags'> & { out(): string, err(): string } {
  let out = ''
  let err = ''
  return {
    stdout: { write: (s: string) => { out += s } },
    stderr: { write: (s: string) => { err += s } },
    stdin: { isTTY: false, text: async () => stdin },
    out: () => out,
    err: () => err,
  }
}

async function ctx(args: string[], stdin = ''): Promise<{ code: number, out: string, err: string }> {
  const x = io(stdin)
  const code = await main(['ctx', ...args], x)
  return { code, out: x.out(), err: x.err() }
}

const EVENTS = JSON.stringify({ events: [
  { kind: 'prompt', text: 'Export the report as CSV, keep the header row.' },
  { kind: 'tool', tool: 'Write', input: { file_path: '/p/src/csv.ts', content: 'body' }, response: '', status: 'ok' },
  { kind: 'tool', tool: 'Bash', input: { command: 'bun test' }, response: 'error: expected 3 columns, got 2', status: 'error' },
] })

describe('buracle ctx: arguments', () => {
  test('usage errors exit 1 with the reason on stderr and nothing on stdout', async () => {
    await withSandbox(async () => {
      const cases: Array<[string[], string]> = [
        [[], 'missing subcommand (session, stats or smoke)'],
        [['frob'], "unknown subcommand 'frob'"],
        [['session'], 'missing op (capture, snapshot, restore or startup)'],
        [['session', 'purge', '--harness', 'claude', '--session', 's'], "unknown op 'purge'"],
        [['session', 'capture', '--session', 's'], '--harness is required'],
        [['session', 'capture', '--harness', 'kilo', '--session', 's'], "unknown harness 'kilo'"],
        [['session', 'capture', '--harness', 'omp'], '--session is required'],
        [['session', 'capture', '--harness', 'omp', '--session', 'a/b'], 'invalid --session id'],
        [['session', 'restore', '--harness', 'omp', '--session', 's', '--source', 'later'], '--source takes compact or resume'],
        [['session', 'restore', '--harness', 'omp', '--session', 's', '--max-bytes', '0'], '--max-bytes takes a positive whole number'],
        [['session', 'restore', '--harness', 'omp', '--session', 's', '--project-dir', 'rel'], '--project-dir must be an absolute path'],
        [['session', 'restore', '--harness', 'omp', '--session', 's', '--project-dir', '/p', '--cwd', '/q'], 'give --project-dir or --cwd, not both'],
        [['session', 'restore', '--harness', 'omp', '--session', 's', '--bogus'], 'unknown option --bogus'],
        [['stats', '--harness', 'kilo'], "unknown harness 'kilo'"],
        [['stats', '--pid', 'x'], '--pid takes a process id'],
        [['stats', '--input', '/f'], "--input does not apply to 'ctx stats'"],
        [['smoke', 'extra'], 'ctx smoke takes no arguments'],
      ]
      for (const [args, reason] of cases) {
        const r = await ctx(args)
        expect({ args, code: r.code, out: r.out, hasReason: r.err.includes(reason) }).toEqual({ args, code: 1, out: '', hasReason: true })
      }
    })
  })

  test('the help names every op, the switches and the exit codes', async () => {
    const x = io()
    expect(await main(['ctx', '--help'], x)).toBe(0)
    for (const needle of ['capture', 'snapshot', 'restore', 'startup', '--project-dir', '--input', 'BURACLE_NO_CAPTURE', 'stats', 'smoke', 'Exit codes']) expect(x.out()).toContain(needle)
  })
})

describe('buracle ctx session', () => {
  test('capture on stdin, snapshot, restore and startup print their outcome as JSON', async () => {
    await withSandbox(async sb => {
      installCmFixture(sb)
      const proj = join(sb.root, 'proj')
      mkdirSync(proj)
      const target = ['--harness', 'opencode', '--session', 'ses_1', '--project-dir', proj, '--json']
      await withEnv({ BURACLE_NO_CAPTURE: undefined }, async () => {
        const cap = await ctx(['session', 'capture', ...target], EVENTS)
        expect(cap).toEqual({ code: 0, out: '{"ok":true,"rows":5}\n', err: '' })
        const snap = await ctx(['session', 'snapshot', ...target], JSON.stringify({ events: [{ kind: 'prompt', text: 'Then wire it into the CLI.' }] }))
        const s = JSON.parse(snap.out) as { ok: boolean, rows: number, snapshot: string, text: string }
        expect({ code: snap.code, ok: s.ok, rows: s.rows }).toEqual({ code: 0, ok: true, rows: 2 })
        expect(s.snapshot).toContain('context-mode_ctx_search')
        expect(s.text).toContain('Last request (the user\'s words): "Then wire it into the CLI."')
        const rest = await ctx(['session', 'restore', ...target, '--source', 'resume', '--max-bytes', '1500'])
        const r = JSON.parse(rest.out) as { ok: boolean, text: string }
        expect(r.ok).toBe(true)
        expect(r.text).toStartWith('<context_mode_restore source="resume">')
        expect(r.text).toContain('Files changed (newest first): /p/src/csv.ts')
        expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(1500)
        const plain = await ctx(['session', 'restore', '--harness', 'opencode', '--session', 'ses_1', '--project-dir', proj])
        expect(plain.out).toBe(`${r.text.replace('source="resume"', 'source="compact"').replace("prompts and tool calls.", "prompts and tool calls before the context was compacted.")}\n`)
        expect(await ctx(['session', 'startup', ...target])).toEqual({ code: 0, out: '{"ok":true,"removed":0}\n', err: '' })
        expect((await ctx(['session', 'startup', '--harness', 'opencode', '--session', 'ses_1', '--project-dir', proj])).out).toBe('session opened; 0 old session(s) removed\n')
        expect((await ctx(['session', 'capture', '--harness', 'opencode', '--session', 'ses_1', '--project-dir', proj], EVENTS)).out).toBe('recorded 5 row(s)\n')
      })
    })
  })

  test('--cwd derives the project folder with the harness rule (the real path; Claude Code: CLAUDE_PROJECT_DIR)', async () => {
    await withSandbox(async sb => {
      installCmFixture(sb)
      const real = join(sb.root, 'real')
      mkdirSync(real)
      symlinkSync(real, join(sb.root, 'link'))
      await withEnv({ BURACLE_NO_CAPTURE: undefined }, async () => {
        expect((await ctx(['session', 'capture', '--harness', 'codex', '--session', 'c1', '--cwd', join(sb.root, 'link'), '--json'], EVENTS)).code).toBe(0)
        expect(existsSync(cmSessionsDir(cmStorageRoot('codex', real)))).toBe(true)
        await withEnv({ CLAUDE_PROJECT_DIR: join(sb.root, 'link') }, async () => {
          expect((await ctx(['session', 'capture', '--harness', 'claude', '--session', 'c1', '--cwd', real, '--json'], EVENTS)).code).toBe(0)
        })
        expect(existsSync(cmSessionsDir(cmStorageRoot('claude', join(sb.root, 'link'))))).toBe(true)
      })
    })
  })

  test("--input: a file Buracle wrote is read and deleted; any other file is only read", async () => {
    await withSandbox(async sb => {
      installCmFixture(sb)
      const proj = join(sb.root, 'proj')
      mkdirSync(proj)
      const args = ['session', 'capture', '--harness', 'omp', '--session', 'o1', '--project-dir', proj, '--json']
      await withEnv({ BURACLE_NO_CAPTURE: undefined }, async () => {
        const mine = writeCmInput(EVENTS) as string
        expect((await ctx([...args, '--input', mine])).out).toBe('{"ok":true,"rows":5}\n')
        expect(existsSync(mine)).toBe(false)
        const other = join(sb.root, 'events.json')
        writeFileSync(other, EVENTS)
        expect((await ctx([...args, '--input', other])).out).toBe('{"ok":true,"rows":5}\n')
        expect(existsSync(other)).toBe(true)
        const missing = await ctx([...args, '--input', join(sb.root, 'nope.json')])
        expect(missing).toEqual({ code: 0, out: '{"ok":true,"rows":0}\n', err: `buracle ctx session capture: cannot read --input ${join(sb.root, 'nope.json')}\n` })
        expect(readdirSync(cmTmpDir())).toEqual([])
      })
    })
  })

  test('fail open: switches off, no toolchain copy and bad input exit 0 with the reason on stderr', async () => {
    await withSandbox(async sb => {
      const proj = join(sb.root, 'proj')
      mkdirSync(proj)
      const args = ['session', 'capture', '--harness', 'claude', '--session', 's', '--project-dir', proj, '--json']
      expect(await ctx(args, EVENTS)).toEqual({ code: 0, out: '{"ok":false,"skipped":"BURACLE_NO_CAPTURE=1"}\n', err: 'buracle ctx session capture: skipped: BURACLE_NO_CAPTURE=1\n' })
      await withEnv({ BURACLE_NO_CAPTURE: undefined }, async () => {
        expect((await ctx(args, EVENTS)).out).toBe('{"ok":false,"skipped":"context-mode is not installed in the toolchain"}\n')
        installCmFixture(sb)
        mkdirSync(sb.buracleHome, { recursive: true })
        writeFileSync(join(sb.buracleHome, 'config.yaml'), 'contextMode:\n  capture: false\n')
        expect((await ctx(args, EVENTS)).out).toBe('{"ok":false,"skipped":"contextMode.capture is false"}\n')
        writeFileSync(join(sb.buracleHome, 'config.yaml'), 'contextMode:\n  enabled: false\n')
        expect((await ctx(['session', 'restore', '--harness', 'claude', '--session', 's', '--project-dir', proj, '--json'])).out).toBe('{"ok":false,"skipped":"contextMode.enabled is false"}\n')
        writeFileSync(join(sb.buracleHome, 'config.yaml'), '{}\n')
        expect(await ctx(args, '{not json')).toEqual({ code: 0, out: '{"ok":true,"rows":0}\n', err: 'buracle ctx session capture: the events are not JSON; nothing recorded\n' })
        expect((await ctx(['session', 'capture', '--harness', 'claude', '--session', 's', '--project-dir', proj], EVENTS)).code).toBe(0)
      })
    })
  })
})

describe('buracle ctx stats and smoke', () => {
  test('stats per harness for the project, from the server stats files', async () => {
    await withSandbox(async sb => {
      const proj = join(sb.root, 'proj')
      mkdirSync(proj)
      const dir = cmSessionsDir(cmStorageRoot('codex', proj))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'stats-pid-55.json'), JSON.stringify({ schemaVersion: 2, updated_at: Date.now(), kept_out: 2 * 1024 * 1024, total_processed: 2 * 1024 * 1024 + 4096, reduction_pct: 99, tokens_saved: 524_288, total_calls: 12, bytes_returned: 4096, by_tool: {} }))
      const text = await ctx(['stats', '--cwd', proj])
      expect(text.code).toBe(0)
      expect(text.out.split('\n')).toEqual([
        'claude: no context-mode numbers for this project (its server writes them while it runs)',
        'codex: kept out 2.0 MB of 2.0 MB (99%) in 12 tool call(s), about 524k tokens (updated just now)',
        'opencode: no context-mode numbers for this project (its server writes them while it runs)',
        'omp: no context-mode numbers for this project (its server writes them while it runs)',
        '',
      ])
      const one = JSON.parse((await ctx(['stats', '--harness', 'codex', '--cwd', proj, '--pid', '55', '--json'])).out) as Record<string, { keptOut: number } | null>
      expect(Object.keys(one)).toEqual(['codex'])
      expect(one['codex']?.keptOut).toBe(2 * 1024 * 1024)
      const all = JSON.parse((await ctx(['stats', '--cwd', proj, '--json'])).out) as Record<string, unknown>
      expect(all['claude']).toBeNull()
    })
  })

  test('stats: a saving below a thousand tokens shows the count, not 0k', async () => {
    await withSandbox(async sb => {
      const proj = join(sb.root, 'small')
      mkdirSync(proj)
      const dir = cmSessionsDir(cmStorageRoot('codex', proj))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'stats-pid-56.json'), JSON.stringify({ schemaVersion: 2, updated_at: Date.now(), kept_out: 98, total_processed: 2262, reduction_pct: 4, tokens_saved: 25, total_calls: 5, bytes_returned: 2164, by_tool: {} }))
      const text = await ctx(['stats', '--harness', 'codex', '--cwd', proj])
      expect(text).toEqual({ code: 0, out: 'codex: kept out 98 B of 2.2 KB (4%) in 5 tool call(s), about 25 tokens (updated just now)\n', err: '' })
    })
  })

  test('smoke: exit 0 when the installed package works, 2 when none is installed', async () => {
    await withSandbox(async sb => {
      const none = await ctx(['smoke', '--json'])
      expect(none.code).toBe(2)
      expect(JSON.parse(none.out)).toMatchObject({ ok: false, problems: ['context-mode is not installed in the toolchain'] })
      installCmFixture(sb)
      const ok = await ctx(['smoke'])
      expect(ok.code).toBe(0)
      expect(ok.out).toMatch(/^context-mode 0\.0\.0-fixture works with Buracle's session bridge \(\d+ ms\)\n$/)
    })
  })
})
