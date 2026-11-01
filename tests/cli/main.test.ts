import { describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { COMMAND_GROUPS, COMMANDS, helpText, main, parseArgs, type CommandIO } from '../../src/cli/router'
import { run } from '../../src/engine/proc'
import { withSandbox } from '../helpers/sandbox'

const REPO = join(import.meta.dir, '..', '..')
const CONTRACT_COMMANDS = ['build', 'install', 'uninstall', 'rollback', 'doctor', 'index', 'update', 'config', 'hook',
  'statusline', 'usage', 'mem', 'mcp', 'lsp', 'plan', 'flow', 'worktree', 'review-scope', 'notify', 'consent', 'project', 'skills', 'rules', 'diagram']

export function memoryIO(stdin = ''): Omit<CommandIO, 'flags'> & { out(): string, err(): string } {
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

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('parseArgs', () => {
  test('global flags anywhere before --; --json/--verbose also stay in argv', () => {
    expect(parseArgs(['--json', 'mem', 'search', '-v', 'term'])).toEqual({ command: 'mem', rest: ['--json', 'search', '-v', 'term'], flags: { json: true, verbose: true }, help: false, version: false })
    expect(parseArgs(['plan', '--help'])).toMatchObject({ command: 'plan', rest: [], help: true })
    expect(parseArgs(['-h'])).toMatchObject({ help: true, rest: [] })
    expect(parseArgs(['notify', '--', '--json', '-v'])).toEqual({ command: 'notify', rest: ['--', '--json', '-v'], flags: { json: false, verbose: false }, help: false, version: false })
    expect(parseArgs([])).toEqual({ rest: [], flags: { json: false, verbose: false }, help: false, version: false })
    expect(parseArgs(['--version'])).toMatchObject({ version: true })
    expect(parseArgs(['config', '--version'])).toMatchObject({ command: 'config', rest: ['--version'], version: false })
    expect(parseArgs(['--', 'hook', 'codex'])).toMatchObject({ command: 'hook', rest: ['codex'] })
  })
})

describe('router', () => {
  test('every contract command is registered and exports name/summary/usage/run', async () => {
    expect(COMMANDS.map(([n]) => n)).toEqual(CONTRACT_COMMANDS)
    for (const [name, load] of COMMANDS) {
      const mod = await load()
      expect(mod.name).toBe(name)
      expect(mod.summary.length).toBeGreaterThan(10)
      expect(mod.usage).toContain(`buracle ${name}`)
      expect(typeof mod.run).toBe('function')
    }
  })

  test('--help, help and a bare buracle outside a terminal print the same short help', async () => {
    const io = memoryIO()
    expect(await main(['--help'], io)).toBe(0)
    const text = io.out()
    for (const name of ['install', 'update', 'doctor', 'config', 'rollback', 'uninstall']) expect(text).toMatch(new RegExp(`^  ${name} +\\S`, 'm'))
    expect(text).toContain('\nRun `buracle` in a terminal to open the main menu.\n')
    expect(text).toContain('\n`buracle help --all` also lists the commands your agents and hooks use.\n')
    expect(text).not.toMatch(/^  (plan|hook|build|mem) /m)
    expect(text).toBe(await helpText())
    for (const argv of [[], ['help']]) {
      const other = memoryIO()
      expect(await main(argv, other)).toBe(0)
      expect({ argv, out: other.out() }).toEqual({ argv, out: text })
    }
  })

  test('help --all puts every command in exactly one of three groups', async () => {
    const io = memoryIO()
    expect(await main(['help', '--all'], io)).toBe(0)
    const text = io.out()
    expect(text.match(/^[A-Z][^:\n]*:$/gm)).toEqual(['Commands:', 'Used by your agents and hooks:', 'Buracle development:', 'Global flags:'])
    const grouped = COMMAND_GROUPS.flatMap(([, names]) => names)
    expect([...grouped].sort()).toEqual(COMMANDS.map(([n]) => n).sort())
    expect(new Set(grouped).size).toBe(grouped.length)
    for (const name of grouped) expect(text).toMatch(new RegExp(`^  ${name} +\\S`, 'm'))
    const agents = text.slice(text.indexOf('Used by your agents and hooks:'), text.indexOf('Buracle development:'))
    expect(agents).toContain('  review-scope ')
    expect(agents).not.toContain('  build ')
    const flag = memoryIO()
    await main(['--help', '--all'], flag)
    expect(flag.out()).toBe(text)
  })

  test('help <command> is <command> --help', async () => {
    for (const name of ['update', 'worktree', 'build']) {
      const a = memoryIO()
      const b = memoryIO()
      expect(await main(['help', name], a)).toBe(0)
      expect(await main([name, '--help'], b)).toBe(0)
      expect(a.out()).toBe(b.out())
      expect(a.out()).toStartWith(`Usage: buracle ${name}`)
    }
  })

  test('removed command names exit 1 with one line that says what to run instead', async () => {
    const want: Record<string, string> = {
      init: 'use `buracle install`',
      sync: 'use `buracle install`',
      toolchain: 'use `buracle install`, `buracle update tools`, `buracle doctor tools` or `buracle rollback toolchain`',
      menu: 'run `buracle` in a terminal',
      ctx: 'Context Mode was removed in 0.6.0',
    }
    for (const [name, instead] of Object.entries(want)) {
      for (const argv of [[name], [name, '--json'], [name, '--help'], ['help', name]]) {
        const io = memoryIO()
        expect({ argv, code: await main(argv, io) }).toEqual({ argv, code: 1 })
        expect(io.out()).toBe('')
        expect(io.err()).toBe(`buracle ${name} was removed; ${instead}\n`)
      }
    }
    for (const name of ['constructor', 'toString', '__proto__']) {
      const io = memoryIO()
      expect(await main([name], io)).toBe(1)
      expect(io.err()).toBe(`buracle: unknown command '${name}'. Run 'buracle --help' for the list of commands.\n`)
    }
    const flag = memoryIO()
    expect(await main(['update', '--toString', '--check'], flag)).toBe(1)
    expect(flag.err()).not.toContain('was removed')
    const sync = memoryIO()
    expect(await main(['sync', '--dry-run'], sync)).toBe(1)
    expect(sync.err()).toBe('buracle sync was removed; use `buracle install`\n')
  })

  test('an unknown command exits 1 with a hint on stderr and nothing on stdout, whatever the flags', async () => {
    for (const argv of [['frobnicate'], ['frobnicate', '--json'], ['frobnicate', '--help'], ['--json', '-v', 'nope', 'x', 'y'], ['--', 'nope']]) {
      const io = memoryIO()
      expect({ argv, code: await main(argv, io) }).toEqual({ argv, code: 1 })
      expect(io.out()).toBe('')
      expect(io.err()).toMatch(/^buracle: unknown command '(frobnicate|nope)'\. Run 'buracle --help' for the list of commands\.\n$/)
    }
  })

  test('<command> --help prints its usage', async () => {
    const io = memoryIO()
    expect(await main(['worktree', '--help'], io)).toBe(0)
    expect(io.out()).toStartWith('Usage: buracle worktree')
  })

  test('--version', async () => {
    const io = memoryIO()
    expect(await main(['--version'], io)).toBe(0)
    expect(io.out()).toMatch(/^buracle \d+\.\d+\.\d+\n$/)
    const j = memoryIO()
    await main(['--version', '--json'], j)
    expect(JSON.parse(j.out())).toEqual({ version: expect.any(String) })
  })

  test('src/cli/main.ts is only the process entry: it exports nothing and nothing imports it', () => {
    const entry = readFileSync(join(REPO, 'src', 'cli', 'main.ts'), 'utf8')
    expect(entry).not.toMatch(/^\s*export\b/m)
    expect(entry).toContain("from './router'")
    const offenders: string[] = []
    for (const file of [...sourceFiles(join(REPO, 'src')), ...sourceFiles(join(REPO, 'tests'))]) {
      if (file === join(REPO, 'src', 'cli', 'main.ts')) continue
      const text = readFileSync(file, 'utf8')
      if (/\bfrom\s+['"](?:\.\.?\/)+(?:[\w-]+\/)*main['"]|import\(\s*['"](?:\.\.?\/)+(?:[\w-]+\/)*cli\/main['"]\s*\)|import\(\s*['"]\.\.\/main['"]\s*\)/.test(text)) offenders.push(relative(REPO, file))
    }
    expect(offenders).toEqual([])
  })
})

describe('as a process', () => {
  test('bun src/cli/main.ts --help, the hook entry point and an unknown command', () => withSandbox(async ({ home, buracleHome }) => {
    const env = { HOME: home, BURACLE_HOME: buracleHome }
    const help = await run(['bun', 'src/cli/main.ts', 'help', '--all'], { cwd: REPO, env, timeoutMs: 30000 })
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('review-scope')
    const hook = await run(['bun', 'src/cli/main.ts', 'hook', 'codex', 'Stop'], { cwd: REPO, env, stdin: '', timeoutMs: 30000 })
    expect(hook).toMatchObject({ code: 0, stdout: '' })
    const unknown = await run(['bun', 'src/cli/main.ts', 'nope'], { cwd: REPO, env, timeoutMs: 30000 })
    expect(unknown).toMatchObject({ code: 1, stdout: '' })
    expect(unknown.stderr).toContain("unknown command 'nope'")
  }), 60_000)

  test('a running command can import the router and re-enter main() without hanging', () => withSandbox(async ({ root, home, buracleHome }) => {
    const copy = join(root, 'repo')
    mkdirSync(join(copy, 'canonical'), { recursive: true })
    cpSync(join(REPO, 'src'), join(copy, 'src'), { recursive: true })
    cpSync(join(REPO, 'package.json'), join(copy, 'package.json'))
    cpSync(join(REPO, 'canonical', 'buracle.yaml'), join(copy, 'canonical', 'buracle.yaml'))
    symlinkSync(join(REPO, 'node_modules'), join(copy, 'node_modules'))
    writeFileSync(join(copy, 'src', 'cli', 'commands', 'rules.ts'), [
      "import type { CommandIO } from '../router'",
      "export const name = 'rules'",
      "export const summary = 'test stand-in that re-enters the router in-process'",
      "export const usage = 'Usage: buracle rules'",
      'export async function run(argv: string[], io: CommandIO): Promise<number> {',
      "  const router = await import('../router')",
      "  const inner = await router.main(['--version', ...argv], { stdout: io.stdout, stderr: io.stderr, stdin: io.stdin })",
      "  io.stdout.write(`registry:${router.COMMANDS.length}\\n`)",
      '  return inner',
      '}',
    ].join('\n'))
    const r = await run([process.execPath, join(copy, 'src', 'cli', 'main.ts'), 'rules', '--json'], { cwd: copy, env: { HOME: home, BURACLE_HOME: buracleHome }, timeoutMs: 20_000 })
    expect(r.timedOut).toBe(false)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`{"version":"${(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }).version}"}\nregistry:${CONTRACT_COMMANDS.length}\n`)
  }), 60_000)
})
