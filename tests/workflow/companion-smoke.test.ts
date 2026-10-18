import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness } from '../../src/core/events'
import * as paths from '../../src/engine/paths'
import { companionRun, companionStart } from '../../src/workflow/companion'
import { companionTestHooks } from '../../src/workflow/companion-hosts'
import { jobFile, readJobAt, type CompanionJob } from '../../src/workflow/companion-job'
import { planRegister } from '../../src/workflow/plan'
import type { ResolvedSession } from '../../src/workflow/session-store'
import { claudeVersionGate, claudeVersionText } from '../helpers/claude-version'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { ctxAt, makeRepo, planDoc, write } from './fixture'

const SKIP = process.env['BURACLE_SKIP_SMOKE'] === '1' || process.platform === 'win32'
const BIN = (h: Harness): string | undefined => (SKIP ? undefined : Bun.which(h, { PATH: process.env['PATH'] ?? '' }) ?? undefined)
const CLAUDE_RUNS = BIN('claude') !== undefined && claudeVersionGate(claudeVersionText(BIN('claude') as string)).runs

type Body = Record<string, any>
interface Mock { url: string, requests: Body[], stop(): void }

function report(plan: string): string {
  return JSON.stringify({ verdict: 'needs_changes', summary: `${plan}: the retry path is missing.`, findings: [{ severity: 'should_fix', category: 'missing_test', title: 'No test for Retry-After', evidence: 'Task 1 names only the status code.', suggested_fix: 'Add a test for the header.' }] })
}

function lastUserHasToolResult(body: Body): boolean {
  const msgs: Body[] = Array.isArray(body['messages']) ? body['messages'] : []
  const last = [...msgs].reverse().find(m => m['role'] === 'user')
  return Array.isArray(last?.['content']) && (last['content'] as Body[]).some(b => b['type'] === 'tool_result')
}

function toolResultCount(body: Body): number {
  const msgs: Body[] = Array.isArray(body['messages']) ? body['messages'] : []
  return msgs.filter(m => m['role'] === 'user' && Array.isArray(m['content']) && (m['content'] as Body[]).some(b => b['type'] === 'tool_result')).length
}

function toolResultText(requests: Body[]): string {
  return JSON.stringify(requests.flatMap(b => (Array.isArray(b['messages']) ? b['messages'] as Body[] : []).flatMap(m => (Array.isArray(m['content']) ? m['content'] as Body[] : []).filter(c => c['type'] === 'tool_result'))))
}

function toolNames(body: Body): string[] {
  return (Array.isArray(body['tools']) ? body['tools'] as Body[] : []).map(t => String(t['name'] ?? t['function']?.['name'] ?? t['type']))
}

function anthropicMock(final: string, pickTool: (offered: string[], step: number) => { name: string, input: Body } | undefined): Mock {
  const requests: Body[] = []
  let n = 0
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method !== 'POST') return path.includes('/models') ? Response.json({ data: [], has_more: false }) : new Response('{}', { status: 404 })
      const body = await req.json().catch(() => ({})) as Body
      if (path.includes('count_tokens')) return Response.json({ input_tokens: 42 })
      if (!path.endsWith('/messages')) return new Response('{}', { status: 404 })
      requests.push(body)
      n++
      const call = pickTool(toolNames(body), toolResultCount(body))
      const content: Body[] = call !== undefined ? [{ type: 'tool_use', id: `toolu_${n}`, name: call.name, input: call.input }] : [{ type: 'text', text: final }]
      const stop = call !== undefined ? 'tool_use' : 'end_turn'
      const model = typeof body['model'] === 'string' ? body['model'] : 'mock'
      const usage = { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      if (body['stream'] !== true) return Response.json({ id: `msg_${n}`, type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage })
      const ev: string[] = []
      const push = (name: string, data: unknown) => ev.push(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      push('message_start', { type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } })
      content.forEach((b, i) => {
        if (b['type'] === 'text') {
          push('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } })
          push('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b['text'] } })
        } else {
          push('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b['id'], name: b['name'], input: {} } })
          push('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b['input']) } })
        }
        push('content_block_stop', { type: 'content_block_stop', index: i })
      })
      push('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 2 } })
      push('message_stop', { type: 'message_stop' })
      return new Response(ev.join(''), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => { void server.stop(true) } }
}

function responsesMock(final: string, call: { name: string, arguments: Body }): Mock {
  const requests: Body[] = []
  const sse = (events: Body[]) => events.map(e => `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      if (req.method !== 'POST' || !new URL(req.url).pathname.endsWith('/responses')) return Response.json({ error: { message: 'not served by the mock' } }, { status: 404 })
      const body = await req.json() as Body
      requests.push(body)
      const id = `resp_${requests.length}`
      const input: Body[] = Array.isArray(body['input']) ? body['input'] : []
      const answered = ['function_call_output', 'custom_tool_call_output'].includes(String(input.at(-1)?.['type']))
      const offered = JSON.stringify(body['tools'] ?? []).includes(`"${call.name}"`)
      const item: Body = !answered && offered
        ? { type: 'function_call', call_id: `call_${id}`, name: call.name, arguments: JSON.stringify(call.arguments) }
        : { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: final }] }
      const usage = { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 }
      return new Response(sse([{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id, usage } }]), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => { void server.stop(true) } }
}

function chatMock(final: string, steps: ReadonlyArray<(offered: string[]) => { name: string, args: Body } | undefined> = []): Mock {
  const requests: Body[] = []
  const sse = (body: Body) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'offline', ...body })}\n\n`
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      if (req.method !== 'POST' || !new URL(req.url).pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
      const body = await req.json() as Body
      requests.push(body)
      const step = (Array.isArray(body['messages']) ? body['messages'] as Body[] : []).filter(m => m['role'] === 'tool').length
      const call = steps[step]?.(toolNames(body))
      const out = (call !== undefined
        ? sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${step}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: null }] })
          + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
        : sse({ choices: [{ index: 0, delta: { role: 'assistant', content: final }, finish_reason: null }] })
          + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
        + sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
        + 'data: [DONE]\n\n'
      return new Response(out, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => { void server.stop(true) } }
}

interface Reviewed { job: CompanionJob | undefined, repo: string, plan: string }

async function review(h: Harness, root: string, env: Record<string, string | undefined>, extra: string[], setup?: (repo: string) => void): Promise<Reviewed> {
  const repo = realpathSync(await makeRepo(root))
  setup?.(repo)
  const plan = join(repo, 'docs', 'plans', '2026-10-08-rate-limit.md')
  write(plan, planDoc())
  const s: ResolvedSession = { harness: h === 'claude' ? 'codex' : 'claude', sessionId: `smoke-${h}`, source: '--session' }
  await planRegister(plan, 'plan', ctxAt(repo), s)
  write(paths.userConfigFile(), `version: 1\nplan:\n  reviews:\n    companion: ${h}\n`)
  companionTestHooks.extraArgs = x => (x === h ? extra : [])
  try {
    return await withEnv(env, async () => {
      const decoy = Bun.spawn(['sleep', '300'], { env: { ...process.env }, stdio: ['ignore', 'ignore', 'ignore'], detached: true })
      let pending: Promise<number> = Promise.resolve(0)
      const r = await companionStart({ role: 'plan', timeoutMin: '3' }, ctxAt(repo), s, { spawnRunner: file => { pending = companionRun(file, { pid: decoy.pid }); return decoy.pid } })
      expect(r.data['state']).toBe('running')
      await pending
      decoy.kill()
      return { job: readJobAt(jobFile(s, 'plan')), repo, plan }
    })
  } finally {
    delete companionTestHooks.extraArgs
  }
}

const QUIET = { BURACLE_NO_MEMORY: '1', BURACLE_NO_CAPTURE: '1', BURACLE_NO_AUTOSTART: '1', BURACLE_NO_NOTIFY: '1', BURACLE_NO_TOOLCHAIN: '1' }
const WRITE_MCP = join(import.meta.dir, '..', 'fixtures', 'companion', 'write-mcp.ts')
const OMP_EXTENSION = join(paths.repoRoot(), 'harness', 'omp', 'extensions', 'buracle.js')
const FENCED = 'read-only second opinion (plan-build-review)'

function writeMcp(marker: string): Body {
  return { type: 'stdio', command: process.execPath, args: [WRITE_MCP], env: { MCP_MARKER: marker } }
}

function ompAgentDir(home: string, url: string, extra: { config?: string, mcp?: Body } = {}): string {
  const agent = join(home, '.omp', 'agent')
  mkdirSync(agent, { recursive: true })
  writeFileSync(join(agent, 'models.yml'), [
    'providers:', '  buracle-smoke:', `    baseUrl: ${url}/v1`, '    apiKey: BURACLE_SMOKE_DUMMY_KEY', '    api: openai-completions',
    '    models:', '      - id: offline', '        name: Buracle smoke (offline)', '        reasoning: false', '        input: [text]',
    '        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }', '        contextWindow: 200000', '        maxTokens: 1024', '',
  ].join('\n'))
  if (extra.config !== undefined) writeFileSync(join(agent, 'config.yml'), extra.config)
  if (extra.mcp !== undefined) writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: extra.mcp }))
  return agent
}

function ompEnv(agent: string): Record<string, string> {
  return { ...QUIET, PI_CODING_AGENT_DIR: agent, OMP_SKIP_SETUP: '1', PI_NO_TITLE: '1', OMP_MCP_STARTUP_TIMEOUT_MS: '0', NO_COLOR: '1' }
}

function toolMessages(requests: Body[]): string {
  return JSON.stringify(requests.flatMap(b => (Array.isArray(b['messages']) ? b['messages'] as Body[] : []).filter(m => m['role'] === 'tool')))
}

describe('second opinion on the real hosts (fake models; skipped where the host is not installed)', () => {
  test.skipIf(!CLAUDE_RUNS)('Claude Code: print mode in dontAsk refuses a shell write, offers no edit tools, and the JSON result is read', () => withSandbox(async ({ root, home }) => {
    const repoDir = join(realpathSync(root), 'repo')
    const mock = anthropicMock(report(join(repoDir, 'docs', 'plans', '2026-10-08-rate-limit.md')), (offered, step) => (step === 0 && offered.includes('Bash') ? { name: 'Bash', input: { command: `touch ${repoDir}/pwned.txt`, description: 'probe' } } : undefined))
    try {
      const env = {
        ...QUIET, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: '[REDACTED:anthropic]', CLAUDE_CONFIG_DIR: join(home, '.claude'),
        DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      }
      const r = await review('claude', root, env, [])
      expect(r.job?.state, JSON.stringify(r.job?.attempts)).toBe('done')
      expect(r.job?.report?.verdict).toBe('needs_changes')
      expect(existsSync(join(r.repo, 'pwned.txt'))).toBe(false)
      expect(mock.requests.some(lastUserHasToolResult)).toBe(true)
      const offered = toolNames(mock.requests[0] ?? {})
      expect(offered).toContain('Read')
      expect(offered).toContain('Bash')
      for (const t of ['Write', 'Edit', 'NotebookEdit', 'WebFetch']) expect(offered).not.toContain(t)
      expect(JSON.stringify(mock.requests)).toContain('You are a second-opinion reviewer running on Claude Code. A Codex session asked for this review')
    } finally {
      mock.stop()
    }
  }), 240_000)

  test.skipIf(BIN('codex') === undefined)('Codex: exec in the read-only sandbox blocks a write, runs codegraph but not the memory server or a server with a dotted or quoted name, and -o carries the report', () => withSandbox(async ({ root, home }) => {
    const codexHome = join(home, '.codex')
    mkdirSync(codexHome, { recursive: true })
    const marker = (n: string) => join(root, `${n}-started`)
    writeFileSync(join(codexHome, 'config.toml'), [
      '[mcp_servers.buracle-memory]', 'command = "/bin/sh"', `args = ["-c", "touch ${marker('memory')}; sleep 3"]`, 'startup_timeout_sec = 2', '',
      '[mcp_servers.codegraph]', 'command = "/bin/sh"', `args = ["-c", "touch ${marker('codegraph')}; sleep 3"]`, 'startup_timeout_sec = 2', '',
      '[mcp_servers."my.server"]', 'command = "/bin/sh"', `args = ["-c", "touch ${marker('dotted')}; sleep 3"]`, 'startup_timeout_sec = 2', '',
      "[mcp_servers.'with space']", 'command = "/bin/sh"', `args = ["-c", "touch ${marker('spaced')}; sleep 3"]`, 'startup_timeout_sec = 2', '',
    ].join('\n'))
    const planPath = join(realpathSync(root), 'repo', 'docs', 'plans', '2026-10-08-rate-limit.md')
    const mock = responsesMock(report(planPath), { name: 'exec_command', arguments: { cmd: 'touch pwned.txt', workdir: join(realpathSync(root), 'repo') } })
    try {
      const provider = `{ name = "Mock", base_url = "${mock.url}/v1", wire_api = "responses", request_max_retries = 0, stream_max_retries = 0 }`
      const r = await review('codex', root, { ...QUIET, CODEX_HOME: codexHome }, [
        '-c', 'model_provider="mock"', '-c', `model_providers.mock=${provider}`, '-c', `chatgpt_base_url="${mock.url}/backend-api"`,
        '-c', 'check_for_update_on_startup=false', '-c', 'analytics.enabled=false', '-c', 'model="gpt-5.5"',
      ])
      expect(r.job?.state, JSON.stringify(r.job?.attempts)).toBe('done')
      expect(r.job?.report?.findings[0]?.title).toBe('No test for Retry-After')
      expect(existsSync(join(r.repo, 'pwned.txt'))).toBe(false)
      const outputs = JSON.stringify(mock.requests.flatMap(b => (Array.isArray(b['input']) ? b['input'] : []).filter((i: Body) => i['type'] === 'function_call_output')))
      expect(outputs.length).toBeGreaterThan(2)
      expect(existsSync(marker('codegraph'))).toBe(true)
      expect(existsSync(marker('memory'))).toBe(false)
      expect(existsSync(marker('dotted'))).toBe(false)
      expect(existsSync(marker('spaced'))).toBe(false)
    } finally {
      mock.stop()
    }
  }), 240_000)

  test.skipIf(BIN('opencode') === undefined)('OpenCode: run --standalone uses the scratch primary agent (never the build fallback), its policies block a write, and the text answer is read', () => withSandbox(async ({ root, home }) => {
    const planPath = join(realpathSync(root), 'repo', 'docs', 'plans', '2026-10-08-rate-limit.md')
    const target = join(realpathSync(root), 'repo', 'pwned.txt')
    const mock = anthropicMock(report(planPath), (offered, step) => (step > 0 ? undefined : offered.includes('write') ? { name: 'write', input: { filePath: target, content: 'x' } } : offered.includes('shell') ? { name: 'shell', input: { command: `touch ${target}`, description: 'probe' } } : undefined))
    try {
      const cfgDir = join(home, '.config', 'opencode')
      mkdirSync(cfgDir, { recursive: true })
      writeFileSync(join(cfgDir, 'opencode.jsonc'), JSON.stringify({ model: 'anthropic/claude-opus-5-5', providers: { anthropic: { settings: { baseURL: `${mock.url}/v1`, apiKey: '[REDACTED:secret]' } } } }, null, 2))
      const r = await review('opencode', root, { ...QUIET, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1' }, [])
      expect(r.job?.state, JSON.stringify(r.job?.attempts)).toBe('done')
      expect(existsSync(target)).toBe(false)
      const offered = toolNames(mock.requests.find(b => Array.isArray(b['tools'])) ?? {})
      expect(offered.includes('write') || offered.includes('shell'), offered.join(',')).toBe(true)
      expect(mock.requests.some(lastUserHasToolResult)).toBe(true)
      const sys = JSON.stringify(mock.requests.map(b => b['system']))
      expect(sys).toContain("You are Buracle's second-opinion reviewer.")
      expect(JSON.stringify(mock.requests)).toContain('You are a second-opinion reviewer running on OpenCode.')
    } finally {
      mock.stop()
    }
  }), 240_000)

  test.skipIf(BIN('omp') === undefined)('omp: print mode offers only the read tools and the stdout answer is read', () => withSandbox(async ({ root, home }) => {
    const planPath = join(realpathSync(root), 'repo', 'docs', 'plans', '2026-10-08-rate-limit.md')
    const mock = chatMock(report(planPath))
    try {
      const agent = ompAgentDir(home, mock.url)
      const r = await review('omp', root, ompEnv(agent), ['--model', 'buracle-smoke/offline'])
      expect(r.job?.state, JSON.stringify(r.job?.attempts)).toBe('done')
      const offered = toolNames(mock.requests.find(b => Array.isArray(b['tools'])) ?? {})
      for (const t of ['read', 'grep', 'glob']) expect(offered).toContain(t)
      for (const t of ['write', 'edit', 'bash', 'python', 'notebook', 'browser', 'task']) expect(offered).not.toContain(t)
      expect(JSON.stringify(mock.requests)).toContain('You have no shell in this run')
    } finally {
      mock.stop()
    }
  }), 240_000)

  test.skipIf(!CLAUDE_RUNS)('Claude Code: settings that allow Bash and an MCP write tool widen dontAsk, and Buracle\'s PreToolUse fence still refuses both', () => withSandbox(async ({ root, home }) => {
    const repoDir = join(realpathSync(root), 'repo')
    const marker = join(root, 'mcp-called')
    const cfg = join(home, '.claude')
    mkdirSync(cfg, { recursive: true })
    const hook = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(paths.repoRoot(), 'src', 'cli', 'main.ts'))} hook claude PreToolUse`
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash', 'mcp__memtest__memory_write'] }, hooks: { PreToolUse: [{ matcher: 'Bash|mcp__.*', hooks: [{ type: 'command', command: hook, timeout: 60 }] }] } }))
    writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { memtest: writeMcp(marker) } }))
    const mock = anthropicMock(report(join(repoDir, 'docs', 'plans', '2026-10-08-rate-limit.md')), (offered, step) => (
      step === 0 ? { name: 'Bash', input: { command: `touch ${repoDir}/pwned.txt`, description: 'probe' } }
        : step === 1 && offered.includes('mcp__memtest__memory_write') ? { name: 'mcp__memtest__memory_write', input: {} } : undefined))
    try {
      const env = {
        ...QUIET, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: '[REDACTED:anthropic]', CLAUDE_CONFIG_DIR: cfg,
        DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      }
      const r = await review('claude', root, env, [])
      expect(r.job?.state, JSON.stringify(r.job?.attempts)).toBe('done')
      expect(existsSync(join(r.repo, 'pwned.txt'))).toBe(false)
      expect(existsSync(marker)).toBe(false)
      expect(toolNames(mock.requests[0] ?? {})).toContain('mcp__memtest__memory_write')
      const results = toolResultText(mock.requests.slice(-1))
      expect(results.split(FENCED).length - 1, results.slice(0, 2000)).toBe(2)
    } finally {
      mock.stop()
    }
  }), 240_000)

  test.skipIf(!CLAUDE_RUNS)('Claude Code: the reviewed repository\'s own settings are not loaded, so its permissions.allow rule cannot widen dontAsk and its hooks do not run', () => withSandbox(async ({ root, home }) => {
    const repoDir = join(realpathSync(root), 'repo')
    const marker = join(root, 'project-hook-ran')
    const mock = anthropicMock(report(join(repoDir, 'docs', 'plans', '2026-10-08-rate-limit.md')), (offered, step) => (step === 0 && offered.includes('Bash') ? { name: 'Bash', input: { command: `touch ${repoDir}/pwned.txt`, description: 'probe' } } : undefined))
    try {
      const env = {
        ...QUIET, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: '[REDACTED:anthropic]', CLAUDE_CONFIG_DIR: join(home, '.claude'),
        DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      }
      const r = await review('claude', root, env, [], repo => {
        mkdirSync(join(repo, '.claude'), { recursive: true })
        writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] }, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `touch ${JSON.stringify(marker)}` }] }] } }))
      })
      expect(r.job?.state, JSON.stringify(r.job?.attempts)).toBe('done')
      expect(mock.requests.some(lastUserHasToolResult)).toBe(true)
      expect(existsSync(join(r.repo, 'pwned.txt'))).toBe(false)
      expect(existsSync(marker)).toBe(false)
    } finally {
      mock.stop()
    }
  }), 240_000)

  test.skipIf(BIN('omp') === undefined)('omp: with Buracle\'s extension loaded, a configured MCP server\'s write tool is hidden and never runs (tools.xdev: false)', () => withSandbox(async ({ root, home }) => {
    const planPath = join(realpathSync(root), 'repo', 'docs', 'plans', '2026-10-08-rate-limit.md')
    const marker = join(root, 'mcp-called')
    const mock = chatMock(report(planPath), [() => ({ name: 'mcp__memtest_memory_write', args: {} })])
    try {
      const agent = ompAgentDir(home, mock.url, { config: 'tools:\n  xdev: false\n', mcp: { memtest: writeMcp(marker) } })
      const r = await review('omp', root, ompEnv(agent), ['--model', 'buracle-smoke/offline', '-e', OMP_EXTENSION])
      expect(r.job?.state, JSON.stringify(r.job?.attempts)).toBe('done')
      expect(existsSync(marker)).toBe(false)
      const offered = toolNames(mock.requests.find(b => Array.isArray(b['tools'])) ?? {})
      for (const t of ['read', 'grep', 'glob']) expect(offered).toContain(t)
      expect(offered.filter(t => t.startsWith('mcp__')), offered.join(',')).toEqual([])
      expect(toolMessages(mock.requests)).not.toContain('written')
    } finally {
      mock.stop()
    }
  }), 240_000)

  test.skipIf(BIN('omp') === undefined)('omp: with xd:// devices (omp\'s default), the write tool cannot reach the MCP server or a file', () => withSandbox(async ({ root, home }) => {
    const repoDir = join(realpathSync(root), 'repo')
    const planPath = join(repoDir, 'docs', 'plans', '2026-10-08-rate-limit.md')
    const marker = join(root, 'mcp-called')
    const mock = chatMock(report(planPath), [
      offered => (offered.includes('write') ? { name: 'write', args: { path: 'xd://mcp__memtest_memory_write', content: '{}' } } : undefined),
      () => ({ name: 'write', args: { path: join(repoDir, 'pwned.txt'), content: 'x' } }),
    ])
    try {
      const agent = ompAgentDir(home, mock.url, { mcp: { memtest: writeMcp(marker) } })
      const r = await review('omp', root, ompEnv(agent), ['--model', 'buracle-smoke/offline', '-e', OMP_EXTENSION])
      expect(r.job?.state, JSON.stringify(r.job?.attempts)).toBe('done')
      expect(toolNames(mock.requests.find(b => Array.isArray(b['tools'])) ?? {})).toContain('write')
      expect(existsSync(marker)).toBe(false)
      expect(existsSync(join(repoDir, 'pwned.txt'))).toBe(false)
      const results = toolMessages(mock.requests.slice(-1))
      expect(results.split(FENCED).length - 1, results.slice(0, 2000)).toBe(2)
      expect(results).toContain('`write` changes files')
    } finally {
      mock.stop()
    }
  }), 240_000)
})
