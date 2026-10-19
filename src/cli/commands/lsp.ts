import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandIO } from '../router'

export const name = 'lsp'
export const summary = 'Run, bridge or check Buracle\'s language servers (buracle lsp run <id>, buracle lsp mcp)'
export const usage = `Usage: buracle lsp run <id>
       buracle lsp mcp
       buracle lsp list [--json]
       buracle lsp check [<id>…] [--json]

run <id>   Starts language server <id> (pyright, typescript, gopls, rust-analyzer, csharp-ls,
           jdtls) on stdin/stdout: Buracle's toolchain copy for servers marked prefer: toolchain
           (installed by \`buracle install\`), else the one on PATH or in the toolchain's go and
           dotnet folders. The server takes over this process (no launcher stays behind; on
           Windows it runs as a child). The Claude plugin's .lsp.json starts them this way.
mcp        Starts the lsp MCP server on stdin/stdout (newline-delimited JSON-RPC 2.0) for the
           harnesses without a language-server client of their own (Codex, OpenCode). Tools:
           diagnostics, hover, definition, references, symbols. It starts the server for a file's
           language when a tool first needs it, in the project root its markers name (the nearest
           folder with tsconfig.json, go.mod, Cargo.toml, ... up to the git top level; never the
           home folder), tells it which project files changed on disk before each call, and
           stops it after 15 idle minutes or when stdin closes. Buracle's file checks (H04) ask
           it for an edited file's diagnostics through a local channel it registers under
           ~/.buracle/run/lsp.
list       Every server and the command that starts it now.
check      Starts each server and runs the LSP initialize handshake.`

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

async function runServer(id: string | undefined, io: CommandIO): Promise<number> {
  if (id === undefined) { io.stderr.write(`buracle lsp run: missing <id>\n\n${usage}\n`); return 1 }
  const { lspLaunch, lspServers, readToolsCatalog } = await import('../../engine/toolchain/lsp')
  const { readToolchainState } = await import('../../engine/toolchain/state')
  const { execServer, spawnArgv, windowsVerbatim } = await import('../../engine/platform')
  let server
  try {
    server = lspServers(readToolsCatalog()).find(s => s.id === id)
  } catch (e) {
    io.stderr.write(`buracle lsp run: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
  if (server === undefined) { io.stderr.write(`buracle lsp run: unknown language server '${id}'\n`); return 1 }
  const plan = lspLaunch(server, readToolchainState())
  if ('error' in plan) {
    io.stderr.write(`buracle lsp run: ${plan.error}\n`)
    const { log } = await import('../../engine/log')
    log('error', 'lsp run: cannot start the language server', { id, error: plan.error })
    return 1
  }
  const failed = execServer(plan.argv, { ...process.env })
  if (failed !== undefined) {
    const { log } = await import('../../engine/log')
    log('warn', 'lsp run: could not hand the process over to the language server; starting it as a child', { id, error: failed })
  }
  let child: ReturnType<typeof Bun.spawn>
  try {
    const spawned = spawnArgv(plan.argv)
    child = Bun.spawn(spawned, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: { ...process.env }, windowsVerbatimArguments: windowsVerbatim(spawned) })
  } catch (e) {
    io.stderr.write(`buracle lsp run: cannot start ${plan.argv[0]}: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
  const forward = (sig: NodeJS.Signals) => () => { try { child.kill(sig) } catch {  } }
  const handlers: Array<[NodeJS.Signals, () => void]> = (['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]).map(s => [s, forward(s)])
  for (const [s, h] of handlers) { try { process.on(s, h) } catch {  } }
  const code = await child.exited
  for (const [s, h] of handlers) process.off(s, h)
  return typeof code === 'number' ? code : 1
}

export interface LspCheckRow { id: string; status: 'ok' | 'down' | 'missing'; required: boolean; source?: string; detail: string }

export async function checkLspServers(ids: readonly string[] = [], timeoutMs = 30_000): Promise<LspCheckRow[]> {
  const { lspLaunch, lspServers, probeLsp, readToolsCatalog } = await import('../../engine/toolchain/lsp')
  const { readToolchainState } = await import('../../engine/toolchain/state')
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const state = readToolchainState()
  const servers = lspServers(readToolsCatalog()).filter(s => ids.length === 0 || ids.includes(s.id))
  const temp = mkdtempSync(join(tmpdir(), 'buracle-lsp-'))
  const root = join(temp, 'buracle-lsp-probe')
  try {
    mkdirSync(root)
    writeFileSync(join(root, 'probe.py'), 'x = 1\n')
    writeFileSync(join(root, 'probe.ts'), 'export const x: number = 1\n')
    writeFileSync(join(root, 'go.mod'), 'module probe\n\ngo 1.21\n')
    writeFileSync(join(root, 'probe.go'), 'package probe\n')
    return await Promise.all(servers.map(async (s): Promise<LspCheckRow> => {
      const plan = lspLaunch(s, state)
      const required = s.tool.required
      if ('error' in plan) return { id: s.id, status: 'missing', required, detail: plan.error }
      const p = await probeLsp(plan.argv, { rootDir: root, timeoutMs })
      const src = plan.source === 'toolchain' ? `toolchain ${plan.version ?? ''}`.trim() : plan.source
      return p.status === 'ok'
        ? { id: s.id, status: 'ok', required, source: src, detail: `${p.serverName ?? s.id}${p.version !== undefined ? ` ${p.version}` : ''} answered initialize in ${p.ms} ms (${src})` }
        : { id: s.id, status: 'down', required, source: src, detail: `${p.error ?? 'down'} (${src})` }
    }))
  } finally {
    try { rmSync(temp, { recursive: true, force: true }) } catch {  }
  }
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const pos = argv.filter(a => !a.startsWith('-'))
  const json = io.flags.json || argv.includes('--json')
  const sub = pos[0]
  if (sub === 'run') return runServer(pos[1], io)
  if (sub === 'mcp') {
    const { runLspMcpServer } = await import('../../engine/toolchain/lsp-mcp')
    return runLspMcpServer({ version: packageVersion(), write: line => io.stdout.write(line) })
  }
  if (sub === 'list') {
    const { lspLaunch, lspServers, readToolsCatalog } = await import('../../engine/toolchain/lsp')
    const { readToolchainState } = await import('../../engine/toolchain/state')
    const state = readToolchainState()
    const rows = lspServers(readToolsCatalog()).map(s => {
      const p = lspLaunch(s, state)
      return 'error' in p ? { id: s.id, source: 'missing', start: p.error } : { id: s.id, source: p.source, start: p.argv.join(' ') }
    })
    if (json) io.stdout.write(JSON.stringify({ servers: rows }, null, 2) + '\n')
    else {
      const width = Math.max(12, ...rows.map(r => r.id.length + 2))
      for (const r of rows) io.stdout.write(`${r.id.padEnd(width)}${r.source.padEnd(11)}${r.start}\n`)
    }
    return 0
  }
  if (sub === 'check') {
    const rows = await checkLspServers(pos.slice(1))
    if (json) io.stdout.write(JSON.stringify({ servers: rows }, null, 2) + '\n')
    else {
      const width = Math.max(12, ...rows.map(r => r.id.length + 2))
      for (const r of rows) io.stdout.write(`${r.status === 'ok' ? 'ok  ' : 'FAIL'}  ${r.id.padEnd(width)}${r.detail}\n`)
    }
    return rows.every(r => r.status === 'ok') ? 0 : 2
  }
  io.stderr.write(sub === undefined ? `${usage}\n` : `buracle lsp: unknown subcommand '${sub}'\n\n${usage}\n`)
  return sub === undefined ? 0 : 1
}
