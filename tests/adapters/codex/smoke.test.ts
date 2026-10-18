import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CanonicalBundle } from '../../../src/core/catalog'
import { defaultConfig } from '../../../src/core/config'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import { tomlRemove } from '../../../src/engine/merge'
import * as paths from '../../../src/engine/paths'
import { run } from '../../../src/engine/proc'
import { applyPlans } from '../../../src/engine/txn'
import { loadLedger } from '../../../src/workflow/ledger'
import type { AdapterContext } from '../../../src/adapters/registry'
import { adapter } from '../../../src/adapters/codex/index'
import { codexDoctor } from '../../../src/adapters/codex/doctor'
import { installTestHooks } from '../../../src/adapters/codex/install'
import { buracleHooksFile, CODEX_HOOK_EVENTS, findBuracleHandlers } from '../../../src/adapters/codex/hooks-config'
import { readOpenPlanSteps } from '../../../src/adapters/codex/rollout'
import { CODEX_FRESH_PLAN_PREFIX, CODEX_IMPLEMENT_PROMPT, lastAssistantText, proposedPlanOf } from '../../../src/adapters/codex/plan-capture'
import { codexTrustPlan } from '../../../src/adapters/codex/trust'
import { renderNeutralSkills } from '../../../src/adapters/shared/skills'
import { hostLimitsOf, probeClosers, probeMisses } from '../../../src/adapters/shared/host-limits'
import { withSandbox } from '../../helpers/sandbox'

const REPO = join(import.meta.dir, '..', '..', '..')
const canonical: CanonicalBundle = loadCanonicalSync(join(REPO, 'canonical'))
const CODEX = Bun.which('codex')
const codexServers = Object.keys(canonical.mcp.servers).filter(id => canonical.mcp.servers[id]?.harnesses.includes('codex')).sort()

beforeEach(() => { installTestHooks.codexPids = async () => [] })
afterEach(() => { delete installTestHooks.codexPids })

function isolatedEnv(root: string, home: string, codexHome = join(home, '.codex')): Record<string, string> {
  for (const d of ['config', 'data', 'state', 'cache']) mkdirSync(join(root, 'xdg', d), { recursive: true })
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin',
    HOME: home, CODEX_HOME: codexHome, TERM: 'dumb',
    XDG_CONFIG_HOME: join(root, 'xdg', 'config'), XDG_DATA_HOME: join(root, 'xdg', 'data'),
    XDG_STATE_HOME: join(root, 'xdg', 'state'), XDG_CACHE_HOME: join(root, 'xdg', 'cache'),
    PI_CODING_AGENT_DIR: join(home, '.omp', 'agent'),
  }
}

async function codex(env: Record<string, string>, cwd: string, ...args: string[]) {
  const clean: Record<string, string | undefined> = {}
  for (const k of Object.keys(process.env)) clean[k] = undefined
  return run([CODEX as string, ...args], { cwd, env: { ...clean, ...env }, timeoutMs: 60_000 })
}

async function hooksList(env: Record<string, string>, cwd: string): Promise<Array<Record<string, unknown>>> {
  const proc = Bun.spawn([CODEX as string, 'app-server'], { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  const send = (m: unknown) => { proc.stdin.write(JSON.stringify(m) + '\n'); proc.stdin.flush() }
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'buracle-smoke', version: '0' } } })
  send({ method: 'initialized' })
  send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + 30_000
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      for (const line of buf.split('\n')) {
        let msg: { id?: number, result?: { data?: Array<{ hooks?: Array<Record<string, unknown>> }> }, error?: unknown } | undefined
        try { msg = JSON.parse(line) } catch { continue }
        if (msg?.id === 2) {
          if (msg.error) throw new Error(`hooks/list failed: ${JSON.stringify(msg.error)}`)
          return msg.result?.data?.[0]?.hooks ?? []
        }
      }
    }
    throw new Error('codex app-server did not answer hooks/list in time')
  } finally {
    proc.kill()
  }
}

const CODEX_NATIVE = ((): string | undefined => {
  try {
    const real = realpathSync(CODEX as string)
    return statSync(real).size > 10_000_000 ? real : undefined
  } catch { return undefined }
})()

describe.skipIf(CODEX_NATIVE === undefined)('the installed codex binary carries the plan-mode text H12 matches', () => {
  test('the <proposed_plan> instruction, "Implement the plan." and the fresh-thread prefix are host text of this Codex', () => {
    const bin = readFileSync(CODEX_NATIVE as string)
    for (const text of ['wrap it in a `<proposed_plan>` block', '<proposed_plan>', CODEX_IMPLEMENT_PROMPT, CODEX_FRESH_PLAN_PREFIX, 'Yes, implement this plan', 'Yes, clear context and implement', 'No, stay in Plan mode']) {
      expect({ text, found: bin.includes(Buffer.from(text, 'utf8')) }).toEqual({ text, found: true })
    }
  }, 60_000)
})

describe.skipIf(CODEX_NATIVE === undefined)('host limits of the installed codex binary', () => {
  test('every recorded Codex limit with a probe still holds, and every probe still finds what it reads', () => {
    const text = readFileSync(CODEX_NATIVE as string).toString('latin1')
    for (const limit of hostLimitsOf('codex')) {
      if (limit.probe === undefined) continue
      expect({ id: limit.id, probeMisses: probeMisses(text, limit.probe) }).toEqual({ id: limit.id, probeMisses: [] })
      expect({ id: limit.id, canNowBeClosed: probeClosers(text, limit.probe) }).toEqual({ id: limit.id, canNowBeClosed: [] })
    }
  }, 60_000)
})

describe.skipIf(CODEX === null || CODEX === undefined)('real codex binary (isolated)', () => {
  test('loads the installed config: MCP servers, hooks feature, execpolicy rules, hook trust identity', () => withSandbox(async ({ root, home }) => {
    const ctx: AdapterContext = { repoRoot: REPO, config: defaultConfig(), canonical, paths, buracleBin: paths.shimPath() }
    const result = await applyPlans([await adapter.installPlan(ctx)])
    expect(result.conflicts).toEqual([])
    const env = isolatedEnv(root, home)
    const work = join(root, 'work')
    mkdirSync(work)

    const version = await codex(env, work, '--version')
    expect(version.stdout).toMatch(/^codex-cli \d+\.\d+\.\d+/)

    const mcp = await codex(env, work, 'mcp', 'list', '--json')
    expect(mcp.code).toBe(0)
    const servers = JSON.parse(mcp.stdout) as Array<{ name: string, enabled: boolean, transport: Record<string, unknown> }>
    expect(servers.map(s => s.name).sort()).toEqual(codexServers)
    expect(servers.find(s => s.name === 'buracle-memory')?.transport).toMatchObject({ type: 'stdio', command: paths.shimPath(), args: ['mcp', 'memory'] })
    expect(servers.find(s => s.name === 'grep')?.transport).toMatchObject({ type: 'streamable_http', url: 'https://mcp.grep.app' })
    expect(servers.find(s => s.name === 'codegraph')?.transport['env']).toEqual({ CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1', CODEGRAPH_MCP_TOOLS: 'explore,search,node,callers,callees,impact,status,files' })
    expect(servers.every(s => s.enabled)).toBe(true)

    const features = await codex(env, work, 'features', 'list')
    expect(features.code).toBe(0)
    expect(features.stdout).toMatch(/^hooks\s+\S+\s+true$/m)

    const rules = join(home, '.codex', 'rules', 'buracle.rules')
    const forbidden = await codex(env, work, 'execpolicy', 'check', '--rules', rules, '--', 'rm', '-rf', '/')
    expect(JSON.parse(forbidden.stdout)).toMatchObject({ decision: 'forbidden' })
    const fine = await codex(env, work, 'execpolicy', 'check', '--rules', rules, '--', 'rm', '-rf', 'dist')
    expect(JSON.parse(fine.stdout)).toEqual({ matchedRules: [] })

    const hooksPath = join(home, '.codex', 'hooks.json')
    const ours = findBuracleHandlers(JSON.parse(readFileSync(hooksPath, 'utf8')), hooksPath)
    expect(new Set(ours.map(h => h.event))).toEqual(new Set(CODEX_HOOK_EVENTS))
    const listed = (await hooksList(env, work)).filter(h => typeof h['command'] === 'string' && (h['command'] as string).includes('buracle" hook codex'))
    expect(listed.map(h => h['key']).sort()).toEqual(ours.map(h => h.key).sort())
    for (const h of ours) expect(listed.find(l => l['key'] === h.key)).toMatchObject({ currentHash: h.hash, trustStatus: 'untrusted' })

    const trust = codexTrustPlan(ctx)
    expect(trust).toBeDefined()
    expect((await applyPlans([trust as NonNullable<typeof trust>])).conflicts).toEqual([])
    const trusted = (await hooksList(env, work)).filter(h => ours.some(o => o.key === h['key']))
    expect(trusted.map(h => h['trustStatus'])).toEqual(ours.map(() => 'trusted'))
    mkdirSync(dirname(paths.shimPath()), { recursive: true })
    writeFileSync(paths.shimPath(), '#!/bin/sh\nexit 0\n')
    chmodSync(paths.shimPath(), 0o755)
    const doctor = await codexDoctor(ctx, {
      detect: async () => ({ installed: true, version: version.stdout.trim().split(' ')[1] as string, path: CODEX as string }),
      run: argv => (argv[1] === 'doctor'
        ? Promise.resolve({ code: 1, stdout: JSON.stringify({ checks: { 'config.load': { status: 'ok', summary: 'config loaded', details: {} } } }), stderr: '', timedOut: false })
        : codex(env, work, ...argv.slice(1))),
    })
    expect(doctor.filter(i => i.level === 'error')).toEqual([])
    expect(doctor.find(i => i.check === 'codex.hooks.trust')?.level).toBe('ok')
    for (const check of ['codex.permissions', 'codex.effort', 'codex.routing', 'codex.config']) expect({ check, level: doctor.find(i => i.check === check)?.level }).toEqual({ check, level: 'ok' })
    expect(doctor.find(i => i.check === 'codex.context-mode')).toEqual({ level: 'ok', check: 'codex.context-mode', detail: expect.stringContaining('8 tools offered, ctx_upgrade, ctx_insight, ctx_doctor hidden, calls up to 600 s, CONTEXT_MODE_PLATFORM=codex') })
  }), 120_000)

  test('next to the user\'s own hooks: their groups keep their keys, Buracle\'s are appended and Codex hashes them like Buracle', () => withSandbox(async ({ root, home }) => {
    const ctx: AdapterContext = { repoRoot: REPO, config: defaultConfig(), canonical, paths, buracleBin: paths.shimPath() }
    const hooksPath = join(home, '.codex', 'hooks.json')
    mkdirSync(join(home, '.codex'), { recursive: true })
    const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-guard', timeout: 5 }] }
    writeFileSync(hooksPath, JSON.stringify({ hooks: { PreToolUse: [mine], Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop' }] }] } }, null, 2) + '\n')
    const result = await applyPlans([await adapter.installPlan(ctx)])
    expect(result.conflicts).toEqual([])
    const file = JSON.parse(readFileSync(hooksPath, 'utf8'))
    expect(file.hooks.PreToolUse).toEqual([mine, ...(buracleHooksFile().hooks.PreToolUse ?? [])])
    const ours = findBuracleHandlers(file, hooksPath)
    expect(ours.find(h => h.event === 'PreToolUse')?.key).toBe(`${hooksPath}:pre_tool_use:1:0`)
    expect(ours.find(h => h.event === 'Stop')?.key).toBe(`${hooksPath}:stop:1:0`)
    const env = isolatedEnv(root, home)
    const work = join(root, 'work')
    mkdirSync(work)
    const listed = await hooksList(env, work)
    for (const h of ours) expect(listed.find(l => l['key'] === h.key)).toMatchObject({ currentHash: h.hash, trustStatus: 'untrusted' })
    expect(listed.find(l => l['key'] === `${hooksPath}:pre_tool_use:0:0`)?.['command']).toBe('echo user-guard')
    expect(listed.find(l => l['key'] === `${hooksPath}:stop:0:0`)?.['command']).toBe('echo user-stop')
    await applyPlans([codexTrustPlan(ctx) as NonNullable<ReturnType<typeof codexTrustPlan>>])
    const after = await hooksList(env, work)
    for (const h of ours) expect(after.find(l => l['key'] === h.key)?.['trustStatus']).toBe('trusted')
    expect(after.find(l => l['key'] === `${hooksPath}:pre_tool_use:0:0`)?.['trustStatus']).toBe('untrusted')
  }), 120_000)

  test('the model-visible prompt carries the AGENTS.md block and the neutral skills linked into ~/.agents/skills (explicit skills stay out of the catalog)', () => withSandbox(async ({ root, home }) => {
    const ctx: AdapterContext = { repoRoot: REPO, config: defaultConfig(), canonical, paths, buracleBin: paths.shimPath() }
    await applyPlans([await adapter.installPlan(ctx)])
    const tree = join(root, 'repo', 'harness', 'agents-skills')
    for (const f of renderNeutralSkills(canonical).files) {
      const dest = join(tree, f.path)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, f.content)
      if (f.mode !== undefined) chmodSync(dest, f.mode)
    }
    mkdirSync(join(paths.agentsDir(), 'skills'), { recursive: true })
    for (const s of canonical.skills) symlinkSync(join(tree, s.id), join(paths.agentsDir(), 'skills', s.id))
    const promptHome = join(root, 'prompt-codex')
    mkdirSync(promptHome)
    cpSync(join(home, '.codex', 'AGENTS.md'), join(promptHome, 'AGENTS.md'))
    const env = isolatedEnv(root, home, promptHome)
    const work = join(root, 'work')
    mkdirSync(work)
    const r = await codex(env, work, 'debug', 'prompt-input', 'ping')
    expect(r.code).toBe(0)
    const text = JSON.stringify(JSON.parse(r.stdout))
    expect(text).toContain('<!-- buracle:buracle:start -->')
    expect(text).toContain('# Core working rules')
    expect(text).toContain('# Path-scoped rules')
    const catalog = [...text.matchAll(/\\n- ([a-z0-9-]+): /g)].map(m => m[1])
    for (const s of canonical.skills) {
      const explicit = s.frontmatter['invocation'] === 'explicit'
      expect({ skill: s.id, listed: catalog.includes(s.id) }).toEqual({ skill: s.id, listed: !explicit })
    }
  }), 120_000)
})

type MockTurn = { call: string, arguments: Record<string, unknown>, then?: MockTurn } | { custom: string, input: string } | { say: string }
interface MockModel { url: string, requests: Array<Record<string, any>>, stop: () => void }

function toolSpecs(body: Record<string, any>): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [...(Array.isArray(body['tools']) ? body['tools'] : [])]
  for (const it of Array.isArray(body['input']) ? body['input'] : []) if (it?.type === 'additional_tools') out.push(...(it.tools ?? []))
  return out
}

function findTool(body: Record<string, any>, name: string): { namespace?: string, name: string } | undefined {
  for (const spec of toolSpecs(body)) {
    if (spec['type'] === 'namespace') {
      for (const inner of spec['tools'] ?? []) if (inner?.name === name) return { namespace: spec['name'], name }
    } else if (spec['name'] === name) return { name }
  }
  return undefined
}

function mockModel(turns: MockTurn[]): MockModel {
  const requests: Array<Record<string, any>> = []
  let next = 0
  let follow: MockTurn | undefined
  const sse = (events: Array<Record<string, unknown>>) => events.map(e => `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method !== 'POST' || !path.endsWith('/responses')) return Response.json({ error: { message: 'not served by the mock' } }, { status: 404 })
      const body = await req.json() as Record<string, any>
      requests.push(body)
      const id = `resp_${requests.length}`
      const input: Array<Record<string, any>> = Array.isArray(body['input']) ? body['input'] : []
      const answered = ['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(String(input[input.length - 1]?.['type']))
      const turn: MockTurn = answered ? (follow ?? { say: 'done' }) : (turns[next++] ?? { say: 'ok' })
      follow = 'call' in turn ? turn.then : undefined
      const say = (text: string) => ({ type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text }] })
      let item: Record<string, unknown>
      if ('call' in turn) {
        const found = findTool(body, turn.call)
        item = found === undefined ? say(`tool ${turn.call} is not visible`) : { type: 'function_call', call_id: `call_${id}`, name: found.name, arguments: JSON.stringify(turn.arguments), ...(found.namespace !== undefined ? { namespace: found.namespace } : {}) }
      } else if ('custom' in turn) {
        item = findTool(body, turn.custom) === undefined ? say(`tool ${turn.custom} is not visible`) : { type: 'custom_tool_call', call_id: `call_${id}`, name: turn.custom, input: turn.input }
      } else item = say(turn.say)
      const usage = { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 }
      return new Response(sse([{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id, usage } }]), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => { void server.stop(true) } }
}

const MOCK_MCP = `import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const [label, log] = process.argv.slice(2)
const tools = [
  { name: 'memory_search', description: 'Search the vault.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'memory-get', description: 'Get one note.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
]
const lists = { 'resources/list': 'resources', 'resources/templates/list': 'resourceTemplates', 'prompts/list': 'prompts' }
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (log) appendFileSync(log, JSON.stringify({ server: label, method: msg.method, params: msg.params }) + '\\n')
  if (msg.id === undefined) return
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: label, version: '0.0.1' } } })
  else if (msg.method === 'tools/list') send({ id: msg.id, result: { tools } })
  else if (msg.method === 'tools/call') send({ id: msg.id, result: { content: [{ type: 'text', text: label + ':' + msg.params?.name + ' ok' }], isError: false } })
  else if (msg.method === 'ping') send({ id: msg.id, result: {} })
  else if (lists[msg.method] !== undefined) send({ id: msg.id, result: { [lists[msg.method]]: [] } })
  else send({ id: msg.id, error: { code: -32601, message: 'method not found' } })
})
`

async function installEndToEnd(root: string, home: string, buracleHome: string): Promise<{ env: Record<string, string>, work: string, mcpLog: string }> {
  const ctx: AdapterContext = { repoRoot: REPO, config: defaultConfig(), canonical, paths, buracleBin: paths.shimPath() }
  expect((await applyPlans([await adapter.installPlan(ctx)])).conflicts).toEqual([])
  expect((await applyPlans([codexTrustPlan(ctx) as NonNullable<ReturnType<typeof codexTrustPlan>>])).conflicts).toEqual([])
  const configPath = join(home, '.codex', 'config.toml')
  writeFileSync(configPath, tomlRemove(readFileSync(configPath, 'utf8'), { tables: ['mcp_servers.grep'] }))
  const mcpScript = join(root, 'mock-mcp.mjs')
  const mcpLog = join(root, 'mcp.jsonl')
  writeFileSync(mcpScript, MOCK_MCP)
  mkdirSync(dirname(paths.shimPath()), { recursive: true })
  writeFileSync(paths.shimPath(), [
    '#!/bin/sh',
    'if [ "$1" = "mcp" ]; then',
    '  if [ "$2" = "run" ]; then id="$3"; else id="$2"; fi',
    `  exec '${process.execPath}' '${mcpScript}' "$id" '${mcpLog}'`,
    'fi',
    `exec '${process.execPath}' '${join(REPO, 'src', 'cli', 'main.ts')}' "$@"`,
    '',
  ].join('\n'))
  chmodSync(paths.shimPath(), 0o755)
  const work = join(root, 'work')
  mkdirSync(work)
  const env = {
    ...isolatedEnv(root, home), SHELL: '/bin/sh', BURACLE_HOME: buracleHome,
    BURACLE_NO_MEMORY: '1', BURACLE_NO_CAPTURE: '1', BURACLE_NO_AUTOSTART: '1', BURACLE_NO_NOTIFY: '1', BURACLE_NO_TOOLCHAIN: '1', BURACLE_NO_DISTILL: '1', BURACLE_NO_REFLECT: '1',
  }
  return { env, work, mcpLog }
}

function codexExec(env: Record<string, string>, work: string, model: MockModel, args: string[], prompt: string) {
  const provider = `{ name = "Mock", base_url = "${model.url}/v1", wire_api = "responses", request_max_retries = 0, stream_max_retries = 0, supports_standalone_web_search = true }`
  return codex(env, work, 'exec', '--skip-git-repo-check', '--json', '--strict-config', '--disable', 'plugins', '-C', work,
    '-c', 'model_provider="mock"', '-c', `model_providers.mock=${provider}`, '-c', `chatgpt_base_url="${model.url}/backend-api"`,
    '-c', 'check_for_update_on_startup=false', '-c', 'analytics.enabled=false', ...args, prompt)
}

function codexResume(env: Record<string, string>, work: string, model: MockModel, prompt: string) {
  const provider = `{ name = "Mock", base_url = "${model.url}/v1", wire_api = "responses", request_max_retries = 0, stream_max_retries = 0, supports_standalone_web_search = true }`
  return codex(env, work, 'exec', 'resume', '--last', '--skip-git-repo-check', '--json', '--strict-config', '--disable', 'plugins',
    '-c', 'model_provider="mock"', '-c', `model_providers.mock=${provider}`, '-c', `chatgpt_base_url="${model.url}/backend-api"`,
    '-c', 'check_for_update_on_startup=false', '-c', 'analytics.enabled=false', '-c', 'model="gpt-5.5"', prompt)
}

interface AppServer {
  request(method: string, params: unknown): Promise<Record<string, any>>
  until(method: string, timeoutMs?: number): Promise<Record<string, any>>
  stop(): void
}

function appServer(env: Record<string, string>, cwd: string, model: MockModel, onServerRequest?: (msg: Record<string, any>) => unknown): AppServer {
  const provider = `{ name = "Mock", base_url = "${model.url}/v1", wire_api = "responses", request_max_retries = 0, stream_max_retries = 0, supports_standalone_web_search = true }`
  const proc = Bun.spawn([CODEX as string, 'app-server', '--strict-config', '--disable', 'plugins',
    '-c', 'model_provider="mock"', '-c', `model_providers.mock=${provider}`, '-c', `chatgpt_base_url="${model.url}/backend-api"`,
    '-c', 'check_for_update_on_startup=false', '-c', 'analytics.enabled=false', '-c', 'model="gpt-5.5"'], { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  const replies = new Map<number, (m: Record<string, any>) => void>()
  const send = (m: unknown): void => { proc.stdin.write(JSON.stringify(m) + '\n'); proc.stdin.flush() }
  const notes: Array<Record<string, any>> = []
  const waiting: Array<{ method: string, from: number, done: (m: Record<string, any>) => void }> = []
  let id = 0
  let read = 0
  const wake = (): void => {
    for (const w of [...waiting]) {
      const hit = notes.slice(w.from).find(n => n['method'] === w.method)
      if (hit !== undefined) { waiting.splice(waiting.indexOf(w), 1); w.done(hit) }
    }
  }
  void (async () => {
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buf += decoder.decode(value, { stream: true })
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        nl = buf.indexOf('\n')
        let msg: Record<string, any>
        try { msg = JSON.parse(line) as Record<string, any> } catch { continue }
        if (typeof msg['id'] === 'number' && msg['method'] === undefined) replies.get(msg['id'])?.(msg)
        else if (msg['method'] !== undefined && msg['id'] === undefined) { notes.push(msg); wake() }
        else if (msg['method'] !== undefined && onServerRequest !== undefined) send({ id: msg['id'], result: onServerRequest(msg) ?? {} })
      }
    }
  })()
  return {
    request: (method, params) => new Promise((resolve, reject) => {
      const n = ++id
      replies.set(n, m => (m['error'] !== undefined ? reject(new Error(`${method}: ${JSON.stringify(m['error'])}`)) : resolve(m['result'] as Record<string, any>)))
      send({ id: n, method, params })
      if (method === 'initialize') send({ method: 'initialized' })
    }),
    until: (method, timeoutMs = 60_000) => {
      const from = read
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`codex app-server sent no ${method} in time`)), timeoutMs)
        waiting.push({ method, from, done: m => { clearTimeout(timer); read = notes.indexOf(m) + 1; resolve(m) } })
        wake()
      })
    },
    stop: () => { proc.kill() },
  }
}

function codexSessions(buracleHome: string): string[] {
  const dir = join(buracleHome, 'sessions', 'codex')
  return existsSync(dir) ? readdirSync(dir).filter(n => n !== 'aliases.json') : []
}

const developerTexts = (body: Record<string, any>): string => JSON.stringify((Array.isArray(body['input']) ? body['input'] : []).filter((i: Record<string, unknown>) => i['type'] === 'message'))

describe.skipIf(CODEX === null || CODEX === undefined)('real codex binary end to end (codex exec --strict-config, mock model)', () => {
  test('gpt-5.5: the config loads strictly; critical MCP tools are top-level on turn 1 and web search is gone; the hooks route the prompt and record the MCP call', () => withSandbox(async ({ root, home, buracleHome }) => {
    const { env, work, mcpLog } = await installEndToEnd(root, home, buracleHome)
    const model = mockModel([{ call: 'memory_search', arguments: { query: 'cache decision' } }])
    try {
      const r = await codexExec(env, work, model, ['-c', 'model="gpt-5.5"'], 'What did we decide last time about the cache?')
      expect({ code: r.code, timedOut: r.timedOut }).toEqual({ code: 0, timedOut: false })
      expect(r.stderr).not.toMatch(/unknown configuration field|unknown variant|Error loading config/)
      const first = model.requests[0] as Record<string, any>
      const specs = toolSpecs(first)
      for (const ns of ['mcp__buracle_memory', 'mcp__context7', 'mcp__codegraph', 'mcp__semble', 'mcp__web_search', 'mcp__web_fetch']) {
        expect({ ns, top: specs.some(s => s['type'] === 'namespace' && s['name'] === ns) }).toEqual({ ns, top: true })
      }
      expect(specs.some(s => s['name'] === 'mcp__chrome_devtools')).toBe(false)
      expect(specs.some(s => s['type'] === 'web_search')).toBe(false)
      const texts = developerTexts(first)
      expect(texts).toContain('Buracle capabilities (Codex)')
      expect(texts).toContain('Buracle routing for this prompt:')
      expect(texts).toContain('Earlier work: search memory first')
      expect(model.requests.length).toBe(2)
      expect(model.requests.some(b => JSON.stringify(b).includes('Buracle routing check:'))).toBe(false)
      const [sid] = codexSessions(buracleHome)
      expect(sid).toBeDefined()
      const ledger = loadLedger('codex', sid as string)
      expect(ledger.turn).toBe(1)
      expect(ledger.mcp['buracle-memory']?.n).toBe(1)
      expect(ledger.prompt?.route.memory.recall).toBe(true)
      expect(existsSync(join(buracleHome, 'sessions', 'codex', sid as string, 'workspace.json'))).toBe(true)
      const calls = readFileSync(mcpLog, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { server: string, method: string, params?: Record<string, unknown> }).filter(c => c.method === 'tools/call')
      expect(calls.map(c => [c.server, c.params?.['name'], c.params?.['arguments']])).toEqual([['memory', 'memory_search', { query: 'cache decision' }]])
      expect((calls[0]?.params?.['_meta'] as Record<string, any> | undefined)?.['x-codex-turn-metadata']?.['reasoning_effort']).toBe('xhigh')
    } finally { model.stop() }
  }), 120_000)

  test('gpt-5.5 control: with web_search cached the hosted search tool is offered (so its absence above is the config\'s doing)', () => withSandbox(async ({ root, home, buracleHome }) => {
    const { env, work } = await installEndToEnd(root, home, buracleHome)
    const model = mockModel([{ say: 'ok' }])
    try {
      const r = await codexExec(env, work, model, ['-c', 'model="gpt-5.5"', '-c', 'web_search="cached"'], 'hello')
      expect(r.code).toBe(0)
      expect(toolSpecs(model.requests[0] as Record<string, any>).some(s => s['type'] === 'web_search')).toBe(true)
    } finally { model.stop() }
  }), 120_000)

  test('gpt-6-sol (code mode): critical MCP tools are top-level namespaces outside `exec`, and the client-side web.run is gone', () => withSandbox(async ({ root, home, buracleHome }) => {
    const { env, work } = await installEndToEnd(root, home, buracleHome)
    const model = mockModel([{ say: 'ok' }, { say: 'ok' }])
    try {
      expect((await codexExec(env, work, model, ['-c', 'model="gpt-6-sol"'], 'hello')).code).toBe(0)
      const body = model.requests[0] as Record<string, any>
      const extra = (body['input'] as Array<Record<string, any>>).find(i => i['type'] === 'additional_tools')
      const namespaces = ((extra?.['tools'] ?? []) as Array<Record<string, any>>).map(t => t['name'])
      expect(namespaces).toEqual(expect.arrayContaining(['mcp__buracle_memory', 'mcp__codegraph', 'mcp__context7']))
      const exec = JSON.stringify(((extra?.['tools'] ?? []) as Array<Record<string, any>>).find(t => t['name'] === 'functions') ?? {})
      expect(exec).not.toContain('mcp__buracle_memory__memory_search')
      expect(JSON.stringify(body)).not.toContain('web__run')
      const control = mockModel([{ say: 'ok' }])
      try {
        expect((await codexExec(env, work, control, ['-c', 'model="gpt-6-sol"', '-c', 'web_search="cached"'], 'hello')).code).toBe(0)
        expect(JSON.stringify(control.requests[0])).toContain('web__run')
      } finally { control.stop() }
    } finally { model.stop() }
  }), 120_000)

  test('guards.redact: a secret a shell command prints reaches the model masked (the PostToolUse mask group)', () => withSandbox(async ({ root, home, buracleHome }) => {
    const { env, work } = await installEndToEnd(root, home, buracleHome)
    const model = mockModel([{ call: 'exec_command', arguments: { cmd: "printf 'KEY=AKIA%s\\nPORT=8080\\n' IOSFODNN7EXAMPLE" } }])
    try {
      const r = await codexExec(env, work, model, ['-c', 'model="gpt-5.5"'], 'print the key')
      expect({ code: r.code, timedOut: r.timedOut }).toEqual({ code: 0, timedOut: false })
      const outputs = model.requests.flatMap(b => (Array.isArray(b['input']) ? b['input'] : []).filter((i: Record<string, unknown>) => i['type'] === 'function_call_output'))
      expect(outputs.length).toBeGreaterThan(0)
      const seen = JSON.stringify(outputs)
      expect(seen).not.toContain('AKIA' + 'IOSFODNN7EXAMPLE')
      expect(seen).toContain('[REDACTED:aws]')
      expect(seen).toContain('PORT=8080')
    } finally { model.stop() }
  }), 120_000)

  test('PARITY-6: Codex starts `buracle lsp mcp` from its config, and the diagnostics tool answers from the language server in the folder Codex runs in', () => withSandbox(async ({ root, home, buracleHome }) => {
    const { env, work } = await installEndToEnd(root, home, buracleHome)
    const bin = join(root, 'lsp-bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'gopls'), `#!/bin/sh\nexec '${process.execPath}' '${join(REPO, 'tests', 'fixtures', 'lsp', 'stub-lsp.ts')}' push\n`, { mode: 0o755 })
    writeFileSync(join(work, 'go.mod'), 'module demo\n')
    writeFileSync(join(work, 'main.go'), 'package main\nvar x = 1 // ERROR: declared and not used: x\n')
    const model = mockModel([{ call: 'diagnostics', arguments: { file: 'main.go' } }])
    try {
      const r = await codexExec({ ...env, PATH: `${bin}:${env['PATH'] ?? ''}` }, work, model, ['-c', 'model="gpt-5.5"'], 'check main.go')
      expect({ code: r.code, timedOut: r.timedOut }).toEqual({ code: 0, timedOut: false })
      expect(toolSpecs(model.requests[0] as Record<string, any>).some(s => s['type'] === 'namespace' && s['name'] === 'mcp__lsp')).toBe(true)
      const outputs = JSON.stringify(model.requests.flatMap(b => (Array.isArray(b['input']) ? b['input'] : []).filter((i: Record<string, unknown>) => i['type'] === 'function_call_output')))
      expect(outputs).toContain('main.go (gopls): 1 error')
      expect(outputs).toContain('2:14  error E1  declared and not used: x [stub]')
      const [sid] = codexSessions(buracleHome)
      expect(loadLedger('codex', sid as string).mcp['lsp']?.n).toBe(1)
    } finally { model.stop() }
  }), 120_000)

  test('PARITY-6: after apply_patch, H04 asks the running `buracle lsp mcp` bridge and the next model request carries the language server\'s diagnostics of the patched file', () => withSandbox(async ({ root, home, buracleHome }) => {
    const { env, work } = await installEndToEnd(root, home, buracleHome)
    const bin = join(root, 'lsp-bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'gopls'), `#!/bin/sh\nexec '${process.execPath}' '${join(REPO, 'tests', 'fixtures', 'lsp', 'stub-lsp.ts')}' push\n`, { mode: 0o755 })
    writeFileSync(join(work, 'go.mod'), 'module demo\n')
    writeFileSync(join(work, 'main.go'), 'package main\n')
    const patch = '*** Begin Patch\n*** Update File: main.go\n@@\n package main\n+var x = 1 // ERROR: declared and not used: x\n*** End Patch\n'
    const model = mockModel([{ custom: 'apply_patch', input: patch }])
    try {
      const r = await codexExec({ ...env, PATH: `${bin}:${env['PATH'] ?? ''}` }, work, model, ['-c', 'model="gpt-5.5"', '--sandbox', 'workspace-write'], 'add x to main.go')
      expect({ code: r.code, timedOut: r.timedOut }).toEqual({ code: 0, timedOut: false })
      expect(readFileSync(join(work, 'main.go'), 'utf8')).toContain('ERROR: declared and not used')
      const after = JSON.stringify(model.requests.slice(1))
      expect(after).toContain('Buracle language server diagnostics after apply_patch:')
      expect(after).toContain('main.go (gopls): 1 error')
      expect(after).toContain('2:14  error E1  declared and not used: x [stub]')
    } catch (e) {
      throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- requests ---\n${model.requests.map(b => JSON.stringify(b['input'] ?? []).slice(-1500)).join('\n')}`)
    } finally { model.stop() }
  }), 120_000)

  test('G11: a shell command is judged in the exec workdir the model passed (H01 refuses `rm -rf .buracle` run in the home folder)', () => withSandbox(async ({ root, home, buracleHome }) => {
    const { env, work } = await installEndToEnd(root, home, buracleHome)
    const model = mockModel([{ call: 'exec_command', arguments: { cmd: 'rm -rf .buracle', workdir: home } }])
    try {
      const r = await codexExec(env, work, model, ['-c', 'model="gpt-5.5"'], 'clean up')
      expect(r.code).toBe(0)
      const outputs = JSON.stringify(model.requests.flatMap(b => (Array.isArray(b['input']) ? b['input'] : []).filter((i: Record<string, unknown>) => i['type'] === 'function_call_output')))
      expect(outputs).toContain('Buracle H01')
      expect(existsSync(buracleHome)).toBe(true)
    } finally { model.stop() }
  }), 120_000)

  test('P3: the update_plan checklist the model wrote is read back from the rollout (the H06 note\'s open todos)', () => withSandbox(async ({ root, home, buracleHome }) => {
    const { env, work } = await installEndToEnd(root, home, buracleHome)
    const plan = [{ step: 'Write the parser', status: 'completed' }, { step: 'Add the tests', status: 'in_progress' }, { step: 'Update the docs', status: 'pending' }]
    const model = mockModel([{ call: 'update_plan', arguments: { explanation: 'x', plan } }])
    try {
      expect((await codexExec(env, work, model, ['-c', 'model="gpt-5.5"'], 'plan it')).code).toBe(0)
      const rollouts = [...new Bun.Glob('**/rollout-*.jsonl').scanSync({ cwd: join(home, '.codex', 'sessions'), absolute: true })]
      expect(rollouts.length).toBe(1)
      expect(readOpenPlanSteps(rollouts[0] as string)).toEqual(['Add the tests', 'Update the docs'])
    } finally { model.stop() }
  }), 120_000)

  test('H12: a <proposed_plan> answer is kept at Stop and "Implement the plan." saves it; with the kept plan gone, the real rollout still has the block', () => withSandbox(async ({ root, home, buracleHome }) => {
    const { env, work } = await installEndToEnd(root, home, buracleHome)
    const plan = '# Add a cache\n\n1. Cache the index\n2. Test it'
    const answer = `Here is the plan.\n\n<proposed_plan>\n${plan}\n</proposed_plan>`
    const model = mockModel([{ say: answer }, { say: 'Implementing.' }, { say: answer }, { say: 'Implementing again.' }])
    const plans = (): string[] => (existsSync(join(work, 'docs', 'plans')) ? readdirSync(join(work, 'docs', 'plans')).sort() : [])
    try {
      expect((await codexExec(env, work, model, ['-c', 'model="gpt-5.5"'], 'draft a cache change')).code).toBe(0)
      const [sid] = codexSessions(buracleHome)
      const kept = join(buracleHome, 'sessions', 'codex', String(sid), 'proposed-plan.json')
      expect(existsSync(kept)).toBe(true)
      expect((await codexResume(env, work, model, CODEX_IMPLEMENT_PROMPT)).code).toBe(0)
      expect(plans().map(f => f.replace(/^\d{4}-\d{2}-\d{2}-/, ''))).toEqual(['add-a-cache.md'])
      const text = readFileSync(join(work, 'docs', 'plans', plans()[0] as string), 'utf8')
      expect(text).toContain('harness: codex')
      expect(text).toContain('> 2. Test it')
      expect((await codexResume(env, work, model, 'draft it again')).code).toBe(0)
      expect(existsSync(kept)).toBe(true)
      rmSync(kept)
      expect((await codexResume(env, work, model, CODEX_IMPLEMENT_PROMPT)).code).toBe(0)
      expect(plans().map(f => f.replace(/^\d{4}-\d{2}-\d{2}-/, ''))).toEqual(['add-a-cache-2.md', 'add-a-cache.md'])
    } finally { model.stop() }
  }), 240_000)

  test('H12 in a real Plan-mode turn: Codex keeps <proposed_plan> out of the hook\'s last message, the rollout keeps it, and "Implement the plan." saves it', () => withSandbox(async ({ root, home, buracleHome }) => {
    const { env, work } = await installEndToEnd(root, home, buracleHome)
    const plan = '# Add a cache\n\n1. Cache the index\n2. Test it'
    const model = mockModel([{ say: `Here is the plan.\n\n<proposed_plan>\n${plan}\n</proposed_plan>` }, { say: 'Implementing.' }])
    const server = appServer(env, work, model)
    const settings = { model: 'gpt-5.5', reasoning_effort: null, developer_instructions: null }
    try {
      await server.request('initialize', { clientInfo: { name: 'buracle-smoke', version: '0' }, capabilities: { experimentalApi: true, requestAttestation: false } })
      const thread = (await server.request('thread/start', { cwd: work, model: 'gpt-5.5' }))['thread'] as { id: string }
      await server.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'draft a cache change', text_elements: [] }], collaborationMode: { mode: 'plan', settings } })
      await server.until('turn/completed')
      expect(JSON.stringify(model.requests[0])).toContain('wrap it in a `<proposed_plan>` block')
      const [sid] = codexSessions(buracleHome)
      expect(sid).toBeDefined()
      expect(existsSync(join(buracleHome, 'sessions', 'codex', String(sid), 'proposed-plan.json'))).toBe(false)
      const rollouts = [...new Bun.Glob('**/rollout-*.jsonl').scanSync({ cwd: join(home, '.codex', 'sessions'), absolute: true })]
      expect(rollouts.length).toBe(1)
      const rollout = readFileSync(rollouts[0] as string, 'utf8')
      const completed = rollout.split('\n').filter(l => l.includes('"task_complete"')).map(l => (JSON.parse(l) as { payload: { last_agent_message?: string } }).payload.last_agent_message)
      expect(completed).toEqual(['Here is the plan.\n\n'])
      expect(proposedPlanOf(lastAssistantText(rollout) ?? '')).toBe(plan)
      await server.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: CODEX_IMPLEMENT_PROMPT, text_elements: [] }], collaborationMode: { mode: 'default', settings } })
      await server.until('turn/completed')
      const dir = join(work, 'docs', 'plans')
      const files = existsSync(dir) ? readdirSync(dir).sort() : []
      expect(files.map(f => f.replace(/^\d{4}-\d{2}-\d{2}-/, ''))).toEqual(['add-a-cache.md'])
      const text = readFileSync(join(dir, files[0] as string), 'utf8')
      expect(text).toContain('harness: codex')
      expect(text).toContain('> 2. Test it')
    } finally {
      server.stop()
      model.stop()
    }
  }), 180_000)

  test('H20: a held push asks in Codex\'s own approval prompt (app-server); accepting runs it once through `buracle consent run`, declining runs nothing and spends the hold before the next call', () => withSandbox(async ({ root, home, buracleHome }) => {
    const { env, work } = await installEndToEnd(root, home, buracleHome)
    const git = (cwd: string, ...args: string[]) => {
      const r = Bun.spawnSync(['git', ...args], { cwd, env: { ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } })
      return { code: r.exitCode, out: r.stdout.toString().trim() }
    }
    const remote = join(root, 'remote.git')
    expect(git(root, 'init', '-q', '--bare', remote).code).toBe(0)
    for (const args of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'one'], ['remote', 'add', 'origin', remote]]) expect(git(work, ...args).code).toBe(0)
    const model = mockModel([
      { call: 'exec_command', arguments: { cmd: 'git push -q origin HEAD:refs/heads/feature' } },
      { call: 'exec_command', arguments: { cmd: 'git push -q origin HEAD:refs/heads/other' }, then: { call: 'exec_command', arguments: { cmd: `ls -A ${join(buracleHome, 'state', 'consent-asks')}; echo "[$CODEX_THREAD_ID]"` } } },
    ])
    const asked: string[] = []
    let answer = 'accept'
    const server = appServer(env, work, model, msg => {
      if (msg['method'] !== 'item/commandExecution/requestApproval') return {}
      asked.push(String(msg['params']?.['command'] ?? ''))
      return { decision: answer }
    })
    try {
      await server.request('initialize', { clientInfo: { name: 'buracle-smoke', version: '0' }, capabilities: { experimentalApi: true, requestAttestation: false } })
      const thread = (await server.request('thread/start', { cwd: work, model: 'gpt-5.5' }))['thread'] as { id: string }
      await server.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'go on with the next step', text_elements: [] }] })
      await server.until('turn/completed', 90_000)
      expect(asked.length).toBe(1)
      expect(asked[0]).toContain(`${paths.shimPath()} consent run `)
      expect(asked[0]).toContain("'git push -q origin HEAD:refs/heads/feature'")
      expect(git(remote, 'rev-parse', '--verify', '-q', 'refs/heads/feature').code).toBe(0)
      answer = 'decline'
      await server.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'now the second step', text_elements: [] }] })
      await server.until('turn/completed', 90_000)
      expect(asked.length).toBe(2)
      expect(git(remote, 'rev-parse', '--verify', '-q', 'refs/heads/other').code).not.toBe(0)
      const listed = model.requests.flatMap(b => (Array.isArray(b['input']) ? b['input'] : []).filter((i: Record<string, unknown>) => i['type'] === 'function_call_output')).map(i => JSON.stringify(i['output']))
      expect(listed.some(o => o.includes(`[${thread.id}]`) && !o.includes('.json'))).toBe(true)
      expect(readdirSync(join(buracleHome, 'state', 'consent-asks'))).toEqual([])
    } finally {
      server.stop()
      model.stop()
    }
  }), 240_000)

  test('H23: an explicitly requested skill the model did not load holds the stop once; Codex feeds the reason back', () => withSandbox(async ({ root, home, buracleHome }) => {
    const { env, work } = await installEndToEnd(root, home, buracleHome)
    const model = mockModel([{ say: 'I will just answer.' }, { say: 'It does not apply here.' }])
    try {
      const r = await codexExec(env, work, model, ['-c', 'model="gpt-5.5"'], 'use the research skill to compare bun and deno')
      expect(r.code).toBe(0)
      expect(developerTexts(model.requests[0] as Record<string, any>)).toContain('read ~/.agents/skills/research/SKILL.md')
      expect(model.requests.length).toBe(2)
      expect(JSON.stringify(model.requests[1])).toContain('Buracle routing check: the user asked for research')
    } finally { model.stop() }
  }), 120_000)
})
