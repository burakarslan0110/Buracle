export const STUB_PROTOCOL_VERSION = '2025-06-18'
export const STUB_VERSION = 'disabled'

type RpcId = string | number
type Reply = Record<string, unknown>

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function isId(x: unknown): x is RpcId {
  return typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x))
}

function rpcError(id: RpcId | null, code: number, message: string): Reply {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function one(msg: unknown, name: string): Reply | undefined {
  if (!isObj(msg) || !isId(msg['id'])) return undefined
  const id = msg['id']
  const method = msg['method']
  if (typeof method !== 'string') {
    return 'result' in msg || 'error' in msg ? undefined : rpcError(id, -32600, 'Invalid Request')
  }
  const params = isObj(msg['params']) ? msg['params'] : {}
  switch (method) {
    case 'initialize': {
      const asked = params['protocolVersion']
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: typeof asked === 'string' && asked !== '' ? asked : STUB_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name, version: STUB_VERSION },
        },
      }
    }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: [] } }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`)
  }
}

export function stubReply(message: unknown, name: string): Reply | Reply[] | undefined {
  if (Array.isArray(message)) {
    const out = message.map(m => one(m, name)).filter((r): r is Reply => r !== undefined)
    return out.length > 0 ? out : undefined
  }
  return one(message, name)
}

export function stubReplyLine(line: string, name: string): string | undefined {
  const t = line.trim()
  if (t === '') return undefined
  let msg: unknown
  try { msg = JSON.parse(t) } catch { return JSON.stringify(rpcError(null, -32700, 'Parse error')) }
  const reply = stubReply(msg, name)
  return reply === undefined ? undefined : JSON.stringify(reply)
}

export async function runStubServer(opts: { name: string, write: (line: string) => void, input?: AsyncIterable<Uint8Array | string> }): Promise<number> {
  const input = opts.input ?? (Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>)
  const decoder = new TextDecoder()
  let buf = ''
  const answer = (line: string) => {
    const out = stubReplyLine(line, opts.name)
    if (out !== undefined) opts.write(out + '\n')
  }
  for await (const chunk of input) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      answer(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  }
  buf += decoder.decode()
  answer(buf)
  return 0
}
