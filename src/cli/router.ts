import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isatty } from 'node:tty'

export interface Writer {
  write(chunk: string): void
  readonly isTTY?: boolean
  readonly columns?: number
  readonly rows?: number
  readonly fd?: number
}
export interface Reader {
  text(): Promise<string>
  readonly isTTY: boolean
}
export interface GlobalFlags { json: boolean; verbose: boolean }
export interface CommandIO { stdout: Writer; stderr: Writer; stdin: Reader; flags: GlobalFlags }
export interface Command {
  name: string
  summary: string
  usage: string
  run(argv: string[], io: CommandIO): Promise<number>
}

export const EXIT = { ok: 0, error: 1, partial: 2 } as const

const REFRESHES_SNAPSHOT: ReadonlySet<string> = new Set(['hook', 'statusline', 'install', 'config'])

async function refreshSnapshot(): Promise<void> {
  try {
    const { refreshRuntimeConfigIfStale } = await import('../engine/config')
    refreshRuntimeConfigIfStale()
  } catch {  }
}

export const COMMANDS: ReadonlyArray<readonly [string, () => Promise<Command>]> = [
  ['build', () => import('./commands/build')],
  ['install', () => import('./commands/install')],
  ['uninstall', () => import('./commands/uninstall')],
  ['rollback', () => import('./commands/rollback')],
  ['doctor', () => import('./commands/doctor')],
  ['index', () => import('./commands/code-index')],
  ['update', () => import('./commands/update')],
  ['config', () => import('./commands/config')],
  ['hook', () => import('./commands/hook')],
  ['statusline', () => import('./commands/statusline')],
  ['usage', () => import('./commands/usage')],
  ['mem', () => import('./commands/mem')],
  ['mcp', () => import('./commands/mcp')],
  ['lsp', () => import('./commands/lsp')],
  ['ctx', () => import('./commands/ctx')],
  ['plan', () => import('./commands/plan')],
  ['flow', () => import('./commands/flow')],
  ['worktree', () => import('./commands/worktree')],
  ['review-scope', () => import('./commands/review-scope')],
  ['notify', () => import('./commands/notify')],
  ['consent', () => import('./commands/consent')],
  ['project', () => import('./commands/project')],
  ['skills', () => import('./commands/skills')],
  ['rules', () => import('./commands/rules')],
]

export interface ParsedArgs { command?: string; rest: string[]; flags: GlobalFlags; help: boolean; version: boolean }

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: GlobalFlags = { json: false, verbose: false }
  let help = false
  let version = false
  let command: string | undefined
  const rest: string[] = []
  let passthrough = false
  for (const a of argv) {
    if (passthrough) { if (command === undefined) command = a; else rest.push(a); continue }
    if (a === '--') { passthrough = true; if (command !== undefined) rest.push(a); continue }
    if (a === '--help' || a === '-h') { help = true; continue }
    if (a === '--version' && command === undefined) { version = true; continue }
    if (a === '--json') flags.json = true
    if (a === '--verbose' || a === '-v') flags.verbose = true
    if (command === undefined && !a.startsWith('-')) { command = a; continue }
    rest.push(a)
  }
  return command === undefined ? { rest, flags, help, version } : { command, rest, flags, help, version }
}

export const CHECKOUT_COMMANDS: ReadonlySet<string> = new Set(['build', 'install', 'update', 'uninstall', 'skills', 'rules'])
const NEEDS_CHECKOUT: ReadonlySet<string> = new Set(['build', 'install', 'update'])

// An older `buracle update` runs exactly `main.ts sync --yes` in the new checkout after a self
// update and moves the checkout back when that exits 1; until 0.6.0 that one form still installs.
function syncBridge(argv: readonly string[], parsed: ParsedArgs): { argv: string[], parsed: ParsedArgs } | undefined {
  if (parsed.command !== 'sync' || parsed.rest.length !== 1 || (parsed.rest[0] !== '--yes' && parsed.rest[0] !== '-y')) return undefined
  const next = argv.map(a => (a === 'sync' ? 'install' : a))
  return { argv: next, parsed: { ...parsed, command: 'install' } }
}

const RUNTIME_MARKER_FILE = '.buracle-runtime.json'

export function runningFrozen(): boolean {
  return existsSync(join(import.meta.dir, '..', '..', RUNTIME_MARKER_FILE))
}

async function runInCheckout(command: string, argv: readonly string[], io: Omit<CommandIO, 'flags'>): Promise<number | undefined> {
  if (!runningFrozen()) return undefined
  const { checkoutRoot } = await import('../engine/paths')
  const checkout = process.env['BURACLE_REEXEC'] === '1' ? undefined : checkoutRoot()
  if (checkout === undefined) {
    const why = process.env['BURACLE_REEXEC'] === '1' ? 'the checkout runs this command from a frozen runtime itself' : 'no Buracle checkout was found (`repo` in ~/.buracle/config.yaml)'
    if (NEEDS_CHECKOUT.has(command)) {
      io.stderr.write(`buracle ${command}: ${why}. Run \`bun src/cli/main.ts ${command}\` in the Buracle checkout, or set its path with \`buracle config set repo <path>\`.\n`)
      return EXIT.error
    }
    io.stderr.write(`buracle ${command}: ${why}; running it from the live runtime.\n`)
    return undefined
  }
  const inherit = io.stdout.fd === 1 && io.stderr.fd === 2
  const stdinText = inherit || io.stdin.isTTY ? undefined : await io.stdin.text()
  const child = Bun.spawn([process.execPath, join(checkout, 'src', 'cli', 'main.ts'), ...argv], {
    cwd: process.cwd(),
    env: { ...process.env, BURACLE_REEXEC: '1' },
    stdin: inherit || io.stdin.isTTY ? 'inherit' : new TextEncoder().encode(stdinText ?? ''),
    stdout: inherit ? 'inherit' : 'pipe',
    stderr: inherit ? 'inherit' : 'pipe',
  })
  const forward = (sig: NodeJS.Signals) => { try { child.kill(sig) } catch {  } }
  const onInt = () => {  }
  const onTerm = () => forward('SIGTERM')
  const onHup = () => forward('SIGHUP')
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)
  process.on('SIGHUP', onHup)
  try {
    const pump = async (stream: ReadableStream<Uint8Array> | number | undefined | null, w: Writer) => {
      if (stream === undefined || stream === null || typeof stream === 'number') return
      const dec = new TextDecoder()
      for await (const chunk of stream) w.write(dec.decode(chunk, { stream: true }))
    }
    await Promise.all([pump(child.stdout as ReadableStream<Uint8Array> | undefined, io.stdout), pump(child.stderr as ReadableStream<Uint8Array> | undefined, io.stderr)])
    const code = await child.exited
    return child.signalCode ? 128 + (child.signalCode === 'SIGINT' ? 2 : child.signalCode === 'SIGHUP' ? 1 : 15) : code
  } finally {
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
    process.off('SIGHUP', onHup)
  }
}

async function loadCommand(name: string): Promise<Command | undefined> {
  const entry = COMMANDS.find(([n]) => n === name)
  if (!entry) return undefined
  const mod = await entry[1]()
  return { name: mod.name, summary: mod.summary, usage: mod.usage, run: mod.run }
}

// Every name in COMMANDS sits in exactly one group (tests/cli/main.test.ts checks it).
export const COMMAND_GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Commands', ['install', 'update', 'doctor', 'config', 'rollback', 'uninstall']],
  ['Used by your agents and hooks', ['plan', 'flow', 'worktree', 'review-scope', 'notify', 'project', 'skills', 'rules', 'mem', 'index', 'usage', 'hook', 'statusline', 'mcp', 'lsp', 'ctx', 'consent']],
  ['Buracle development', ['build']],
]

// Names a release removed; until 0.6.0 they say what to run instead.
export const REMOVED_COMMANDS: Readonly<Record<string, string>> = {
  init: 'use `buracle install`',
  sync: 'use `buracle install`',
  toolchain: 'use `buracle install`, `buracle update tools`, `buracle doctor tools` or `buracle rollback toolchain`',
  menu: 'run `buracle` in a terminal',
}

export async function helpText(all = false): Promise<string> {
  const groups = all ? COMMAND_GROUPS : COMMAND_GROUPS.slice(0, 1)
  const names = groups.flatMap(([, n]) => n)
  const cmds = new Map((await Promise.all(names.map(async n => [n, await loadCommand(n)] as const))))
  const width = Math.max(...names.map(n => n.length)) + 2
  const lines = [
    'buracle: everything your coding agents need, in one place (Claude Code, Codex CLI, OpenCode and Oh My Pi)',
    '',
    'Usage: buracle <command> [args…] [--json]',
  ]
  for (const [title, group] of groups) lines.push('', `${title}:`, ...group.map(n => `  ${n.padEnd(width)}${cmds.get(n)?.summary ?? ''}`))
  lines.push('')
  if (all) {
    lines.push(
      'Global flags:',
      '  --json       machine-readable output',
      '  --verbose    more detail on stderr',
      '  --help       show help (`buracle <command> --help` for one command)',
      '  --version    print the Buracle version',
      '',
      'Exit codes: 0 ok, 1 error, 2 partial success or user action needed.',
    )
  } else {
    lines.push(
      'Run `buracle` in a terminal to open the main menu.',
      '`buracle help <command>` shows the options of one command.',
      '`buracle help --all` also lists the commands your agents and hooks use.',
    )
  }
  return lines.join('\n') + '\n'
}

export function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export async function main(rawArgv: readonly string[], io: Omit<CommandIO, 'flags'>): Promise<number> {
  let argv = rawArgv
  let parsed = parseArgs(argv)
  const bridged = syncBridge(argv, parsed)
  if (bridged !== undefined) {
    io.stderr.write('buracle sync was renamed; use buracle install\n')
    argv = bridged.argv
    parsed = bridged.parsed
  }
  const cio: CommandIO = { ...io, flags: parsed.flags }
  if (parsed.version && parsed.command === undefined) {
    io.stdout.write(parsed.flags.json ? JSON.stringify({ version: cliVersion() }) + '\n' : `buracle ${cliVersion()}\n`)
    return EXIT.ok
  }
  if (parsed.command === undefined) {
    if (!parsed.help && parsed.rest.length === 0) {
      const { dashboardFits, openDashboard } = await import('./dashboard')
      if (dashboardFits({ stdinTTY: io.stdin.isTTY, stdoutTTY: io.stdout.isTTY === true, json: parsed.flags.json, term: process.env['TERM'], columns: io.stdout.columns, rows: io.stdout.rows })) return openDashboard()
    }
    io.stdout.write(await helpText(parsed.rest.includes('--all')))
    return EXIT.ok
  }
  const removed = Object.hasOwn(REMOVED_COMMANDS, parsed.command) ? REMOVED_COMMANDS[parsed.command] : undefined
  if (removed !== undefined) {
    io.stderr.write(`buracle ${parsed.command} was removed; ${removed}\n`)
    return EXIT.error
  }
  if (parsed.command === 'help') {
    const topic = parsed.rest.find(a => !a.startsWith('-'))
    if (topic !== undefined) return main([topic, '--help'], io)
    io.stdout.write(await helpText(parsed.rest.includes('--all')))
    return EXIT.ok
  }
  if (CHECKOUT_COMMANDS.has(parsed.command)) {
    const code = await runInCheckout(parsed.command, argv, io)
    if (code !== undefined) return code
  }
  const cmd = await loadCommand(parsed.command)
  if (!cmd) {
    io.stderr.write(`buracle: unknown command '${parsed.command}'. Run 'buracle --help' for the list of commands.\n`)
    return EXIT.error
  }
  if (parsed.help) {
    io.stdout.write(cmd.usage.endsWith('\n') ? cmd.usage : cmd.usage + '\n')
    return EXIT.ok
  }
  if (REFRESHES_SNAPSHOT.has(parsed.command)) await refreshSnapshot()
  return cmd.run(parsed.rest, cio)
}

export function processIO(opts: { bindNow?: boolean } = {}): Omit<CommandIO, 'flags'> & { flush(): Promise<void> } {
  let chain: Promise<void> = Promise.resolve()
  type RawWrite = (chunk: string, cb: () => void) => boolean
  const sink = (fd: 1 | 2, open: () => NodeJS.WriteStream): Writer => {
    let rawWrite: RawWrite | undefined
    const bind = (): RawWrite => {
      if (rawWrite === undefined) {
        const stream = open()
        stream.on('error', () => {  })
        rawWrite = stream.write.bind(stream) as RawWrite
      }
      return rawWrite
    }
    if (opts.bindNow === true) bind()
    const isTTY = isatty(fd)
    return {
      isTTY,
      fd,
      get columns(): number | undefined {
        const c = isTTY ? open().columns : undefined
        return typeof c === 'number' ? c : undefined
      },
      get rows(): number | undefined {
        const r = isTTY ? open().rows : undefined
        return typeof r === 'number' ? r : undefined
      },
      write(chunk: string) {
        const write = bind()
        chain = chain.then(() => new Promise<void>(res => {
          try { write(chunk, () => res()) } catch { res() }
        }))
      },
    }
  }
  const isTTY = isatty(0)
  return {
    stdout: sink(1, () => process.stdout),
    stderr: sink(2, () => process.stderr),
    stdin: { isTTY, text: async () => (isTTY ? '' : await Bun.stdin.text()) },
    flush: () => chain,
  }
}

export async function escapedErrorExit(argv: readonly string[], e: unknown, io: Pick<CommandIO, 'stderr'> & { stdout?: Writer }): Promise<number> {
  const parsed = parseArgs(argv)
  if (parsed.command === 'hook') {
    const [harness, event] = parsed.rest.filter(a => a !== '--' && !a.startsWith('-'))
    let closed: { stdout: string } | undefined
    try {
      const { failClosedOutcome, shortError } = await import('../engine/hook-fail')
      closed = failClosedOutcome(harness ?? '', event ?? '', shortError(e))
    } catch {  }
    try {
      const { log } = await import('../engine/log')
      log('error', 'hook command failed before dispatch', { argv: [...argv], harness, event, error: e, result: closed ? 'fail-closed' : 'fail-open' })
    } catch {  }
    if (closed !== undefined && io.stdout !== undefined) io.stdout.write(closed.stdout)
    return EXIT.ok
  }
  io.stderr.write(`buracle: ${e instanceof Error ? e.message : String(e)}\n`)
  return EXIT.error
}

export async function runProcess(argv: readonly string[]): Promise<number> {
  const io = processIO({ bindNow: parseArgs(argv).command === 'hook' })
  let code: number
  try {
    code = await main(argv, io)
  } catch (e) {
    code = await escapedErrorExit(argv, e, io)
  }
  await io.flush()
  return code
}
