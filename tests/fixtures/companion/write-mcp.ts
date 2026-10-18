import { appendFileSync } from 'node:fs'

const marker = process.env['MCP_MARKER'] ?? ''
const dec = new TextDecoder()
let buf = ''
const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n')

for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true })
  let i: number
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (line === '') continue
    let msg: { id?: number | string, method?: string, params?: { protocolVersion?: string, name?: string } }
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id === undefined) continue
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'memtest', version: '0.0.0' } } })
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'memory_write', description: 'Write a memory', inputSchema: { type: 'object', properties: {} } }] } })
    } else if (msg.method === 'tools/call') {
      if (marker !== '') appendFileSync(marker, `${msg.params?.name ?? '?'}\n`)
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'written' }] } })
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
    }
  }
}
