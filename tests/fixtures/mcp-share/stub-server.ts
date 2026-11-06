#!/usr/bin/env bun
// A stub stdio MCP server for the shared-backend and lazy-start tests.
// Environment (all optional):
//   STUB_STARTS      a file: one line "start <pid>" per process start
//   STUB_INIT_FILE   a file: the params of each `initialize` this process got, one JSON line each
//   STUB_ROOTS_FILE  a file: the client's answer to this server's `roots/list` request
//   STUB_EXIT_AT_START  exit at once with this code (a server that cannot start)
//   STUB_IGNORE_TERM    ignore SIGTERM and the end of stdin (a server that only SIGKILL stops)
//   STUB_INIT_ERROR     answer initialize with this error message and keep running
import { appendFileSync } from 'node:fs'

const env = process.env
if (env['STUB_IGNORE_TERM']) {
  process.on('SIGTERM', () => { /* ignored on purpose */ })
  setInterval(() => { /* stays alive after its input ends */ }, 60_000)
}
if (env['STUB_STARTS']) appendFileSync(env['STUB_STARTS'], `start ${process.pid}\n`)
process.stderr.write(`stub server ${process.pid} started\n`)
if (env['STUB_EXIT_AT_START']) process.exit(Number(env['STUB_EXIT_AT_START']))

type Msg = Record<string, unknown>
let tools: Msg[] = [
  { name: 'ping', description: 'answers pong', inputSchema: { type: 'object', properties: {} } },
  { name: 'echo', description: 'answers its text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'sleep', description: 'answers after ms', inputSchema: { type: 'object', properties: { ms: { type: 'number' }, label: { type: 'string' } } } },
  { name: 'crash', description: 'exits the process', inputSchema: { type: 'object', properties: {} } },
  { name: 'change', description: 'changes the tool list', inputSchema: { type: 'object', properties: {} } },
  { name: 'noise', description: 'writes bytes to stderr', inputSchema: { type: 'object', properties: { bytes: { type: 'number' } } } },
]

const send = (m: Msg): void => { process.stdout.write(`${JSON.stringify(m)}\n`) }
const text = (id: unknown, t: string): void => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: t }] } })

function handle(m: Msg): void {
  const id = m['id']
  const method = m['method']
  const params = (m['params'] ?? {}) as Msg
  if (method === undefined) {
    if (id === 'roots-1' && env['STUB_ROOTS_FILE']) appendFileSync(env['STUB_ROOTS_FILE'], `${JSON.stringify(m['result'] ?? m['error'])}\n`)
    return
  }
  if (id === undefined) return
  switch (method) {
    case 'initialize': {
      if (env['STUB_INIT_ERROR']) { send({ jsonrpc: '2.0', id, error: { code: -32603, message: env['STUB_INIT_ERROR'] } }); return }
      if (env['STUB_INIT_FILE']) appendFileSync(env['STUB_INIT_FILE'], `${JSON.stringify(params)}\n`)
      send({ jsonrpc: '2.0', id, result: { protocolVersion: params['protocolVersion'] ?? '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'stub', version: '1.0.0' }, instructions: 'stub instructions' } })
      const caps = params['capabilities'] as Msg | undefined
      if (caps !== undefined && caps['roots'] !== undefined) send({ jsonrpc: '2.0', id: 'roots-1', method: 'roots/list' })
      return
    }
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools } })
      return
    case 'tools/call': {
      const name = params['name']
      const args = (params['arguments'] ?? {}) as Msg
      if (name === 'ping') return text(id, 'pong')
      if (name === 'echo') return text(id, String(args['text'] ?? ''))
      if (name === 'crash') process.exit(3)
      if (name === 'noise') {
        const line = `${'x'.repeat(1023)}\n`
        for (let left = Number(args['bytes'] ?? 0); left > 0; left -= line.length) process.stderr.write(line)
        return text(id, 'noisy')
      }
      if (name === 'change') {
        tools = [...tools, { name: 'extra', description: 'added', inputSchema: { type: 'object', properties: {} } }]
        send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
        return text(id, 'changed')
      }
      if (name === 'sleep') {
        const ms = Number(args['ms'] ?? 100)
        const token = ((params['_meta'] ?? {}) as Msg)['progressToken']
        if (token !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 2 } })
        setTimeout(() => text(id, String(args['label'] ?? 'slept')), ms)
        return
      }
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${String(name)}` } })
      return
    }
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } })
  }
}

let buf = ''
process.stdin.on('data', (chunk: Buffer) => {
  buf += chunk.toString('utf8')
  let nl = buf.indexOf('\n')
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (line !== '') {
      try { handle(JSON.parse(line) as Msg) } catch { /* not JSON */ }
    }
    nl = buf.indexOf('\n')
  }
})
process.stdin.on('end', () => { if (!env['STUB_IGNORE_TERM']) process.exit(0) })
