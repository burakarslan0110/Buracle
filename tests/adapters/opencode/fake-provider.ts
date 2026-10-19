export interface RecordedRequest { path: string; body: Record<string, unknown> | undefined }

export interface FakeProvider {
  baseURL: string
  requests: RecordedRequest[]
  stop(): void
}

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

function reply(model: string): string {
  return sse([
    ['message_start', { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ])
}

function toolCall(model: string, name: string, input: unknown): string {
  return sse([
    ['message_start', { type: 'message_start', message: { id: 'msg_fake_tool', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_fake_${name}`, name, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ])
}

export interface ToolRule { when: (lastUser: string) => boolean; name: string; input: unknown; delayMs?: number; then?: { name: string; input: unknown }; offered?: boolean }

export function offeredTools(body: Record<string, unknown> | undefined): string[] {
  const tools = Array.isArray(body?.['tools']) ? body['tools'] as Array<Record<string, unknown>> : []
  return tools.map(t => (typeof t['name'] === 'string' ? t['name'] : '')).filter(n => n !== '')
}

function afterTool(body: Record<string, unknown> | undefined): boolean {
  const messages = Array.isArray(body?.['messages']) ? body['messages'] as Array<Record<string, unknown>> : []
  const content = messages[messages.length - 1]?.['content']
  return Array.isArray(content) && content.some(c => (c as { type?: unknown }).type === 'tool_result')
}

export function rateLimitHeaders(nowMs: number): Record<string, string> {
  const s = Math.floor(nowMs / 1000)
  return {
    'anthropic-ratelimit-unified-5h-utilization': '0.42', 'anthropic-ratelimit-unified-5h-reset': String(s + 3_600),
    'anthropic-ratelimit-unified-7d-utilization': '0.18', 'anthropic-ratelimit-unified-7d-reset': String(s + 5 * 86_400),
  }
}

export function startFakeProvider(rules: readonly ToolRule[] = []): FakeProvider {
  const requests: RecordedRequest[] = []
  let follow: { name: string; input: unknown } | undefined
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      let body: Record<string, unknown> | undefined
      try { body = await req.json() as Record<string, unknown> } catch { body = undefined }
      requests.push({ path: url.pathname, body })
      if (req.method === 'POST' && url.pathname.endsWith('/messages')) {
        const model = typeof body?.['model'] === 'string' ? body['model'] : 'fake'
        const offersTools = Array.isArray(body?.['tools']) && (body['tools'] as unknown[]).length > 0
        const rule = offersTools && !afterTool(body) ? rules.find(r => r.when(lastUserText(body)) && (r.offered !== true || offeredTools(body).includes(r.name))) : undefined
        if (rule?.delayMs !== undefined) await Bun.sleep(rule.delayMs)
        const next = rule ?? (offersTools && afterTool(body) ? follow : undefined)
        if (offersTools) follow = rule?.then
        const payload = next !== undefined ? toolCall(model, next.name, next.input) : reply(model)
        return new Response(payload, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...rateLimitHeaders(Date.now()) } })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => { void server.stop(true) } }
}

export function endsWithToolResult(body: Record<string, unknown> | undefined): boolean {
  return afterTool(body)
}

export function lastUserText(body: Record<string, unknown> | undefined): string {
  const messages = Array.isArray(body?.['messages']) ? body['messages'] as Array<Record<string, unknown>> : []
  const last = [...messages].reverse().find(m => m['role'] === 'user')
  const content = last?.['content']
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map(c => (typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('\n') : ''
}

export function systemTexts(body: Record<string, unknown> | undefined): string[] {
  const system = body?.['system']
  if (typeof system === 'string') return [system]
  return Array.isArray(system) ? system.map(s => (typeof (s as { text?: unknown }).text === 'string' ? (s as { text: string }).text : '')) : []
}
