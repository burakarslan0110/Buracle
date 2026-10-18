#!/usr/bin/env bun

const id = process.argv[2] ?? 'stub'
let buffer = ''

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handle(line: string): void {
  let msg: { id?: unknown, method?: unknown, params?: { protocolVersion?: unknown } }
  try { msg = JSON.parse(line) as typeof msg } catch { return }
  if (msg.id === undefined) return
  switch (msg.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `stub-${id}`, version: '0.0.0' } } })
      return
    case 'tools/list':
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', description: `Stub tool of ${id}`, inputSchema: { type: 'object', properties: {} } }] } })
      return
    case 'tools/call':
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'pong' }] } })
      return
    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${String(msg.method)}` } })
  }
}

process.stdin.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8')
  let nl = buffer.indexOf('\n')
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (line !== '') handle(line)
    nl = buffer.indexOf('\n')
  }
})
