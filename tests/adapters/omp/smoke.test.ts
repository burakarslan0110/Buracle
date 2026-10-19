import { describe, expect, test } from 'bun:test'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { adapter } from '../../../src/adapters/omp/index'
import { buildOmp } from '../../../src/adapters/omp/build'
import { checkLink } from '../../../src/adapters/omp/check-link'
import { buracleVersion, OMP_MIN_VERSION, OMP_TESTED_WITH, ompCommandSkills } from '../../../src/adapters/omp/generated'
import { OMP_UTILITY_COMMANDS } from '../../../src/adapters/omp/runtime/commands'
import { OMP_PLAN_APPROVED, OMP_PLAN_CLOSE, OMP_PLAN_OPEN } from '../../../src/adapters/omp/runtime/plan-capture'
import { devContext, writeTree } from '../../../src/adapters/omp/dev-build'
import * as paths from '../../../src/engine/paths'
import { which } from '../../../src/engine/proc'
import { applyPlans, rollbackTxn } from '../../../src/engine/txn'
import { pathOf } from '../../helpers/fake-exe'
import { withEnv, withSandbox, type Sandbox } from '../../helpers/sandbox'
import { fixtureCanonical } from './fixture'

const OMP = which('omp')
const REPO = paths.repoRoot()
const HARNESS = join(REPO, 'harness', 'omp')
const READY = OMP !== undefined && existsSync(join(HARNESS, 'package.json'))
const smoke = READY ? describe : describe.skip

function ompEnv(sb: Sandbox): Record<string, string> {
  const bunDir = dirname(process.execPath)
  return {
    PATH: [dirname(OMP as string), bunDir, '/usr/bin', '/bin'].join(':'),
    HOME: sb.home,
    PI_CODING_AGENT_DIR: join(sb.home, '.omp', 'agent'),
    XDG_CONFIG_HOME: join(sb.home, '.config'), XDG_DATA_HOME: join(sb.home, '.local', 'share'),
    XDG_STATE_HOME: join(sb.home, '.local', 'state'), XDG_CACHE_HOME: join(sb.home, '.cache'),
    BURACLE_HOME: sb.buracleHome,
    TERM: 'dumb', NO_COLOR: '1', OMP_SKIP_SETUP: '1', PI_NO_TITLE: '1',
    OMP_MCP_STARTUP_TIMEOUT_MS: '0', BURACLE_NO_NOTICES: '1',
  }
}

function omp(sb: Sandbox, args: string[], cwd = sb.root): { code: number, stdout: string, stderr: string } {
  const p = Bun.spawnSync([OMP as string, ...args], { cwd, env: ompEnv(sb), stdout: 'pipe', stderr: 'pipe', timeout: 60_000 })
  return { code: p.exitCode ?? -1, stdout: p.stdout.toString(), stderr: p.stderr.toString() }
}

function offlineAgentDir(sb: Sandbox): void {
  const agent = join(sb.home, '.omp', 'agent')
  mkdirSync(agent, { recursive: true })
  writeFileSync(join(agent, 'models.yml'), [
    'providers:', '  buracle-smoke:', '    baseUrl: http://127.0.0.1:9/v1', '    apiKey: BURACLE_SMOKE_DUMMY_KEY', '    api: openai-completions',
    '    models:', '      - id: offline', '        name: Buracle smoke (offline)', '        reasoning: false', '        input: [text]',
    '        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }', '        contextWindow: 200000', '        maxTokens: 1024', '',
  ].join('\n'))
  const ids = Object.keys(devContext(REPO).canonical.mcp.servers).filter(id => id !== 'buracle-memory')
  writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ disabledServers: ids }) + '\n')
  const shim = join(sb.buracleHome, 'bin', 'buracle')
  mkdirSync(dirname(shim), { recursive: true })
  writeFileSync(shim, [
    '#!/bin/sh',
    `if [ "$1" = "mcp" ]; then exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, 'fixtures', 'fake-mcp.ts'))}; fi`,
    'if [ "$1 $2" = "mem remember" ]; then echo \'{"action":"created","id":"capture-smoke-note","layer":"project"}\'; exit 0; fi',
    'if [ "$1 $2" = "mem ui" ]; then echo \'{"url":"http://127.0.0.1:41777","started":false,"opened":false}\'; exit 0; fi',
    'exit 0',
    '',
  ].join('\n'))
  chmodSync(shim, 0o755)
}

interface Frame { type?: string, id?: string, method?: string, message?: string, data?: { commands?: Array<{ name: string }>, systemPrompt?: unknown, dumpTools?: unknown, sessionId?: string, output?: string, messages?: unknown[] } }

async function rpc(sb: Sandbox, commands: Array<Record<string, unknown>>, cwd: string, env: Record<string, string> = ompEnv(sb), args: string[] = ['--no-session', '--model', 'buracle-smoke/offline']): Promise<Frame[]> {
  const proc = Bun.spawn([OMP as string, '--mode', 'rpc', ...args], { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const frames: Frame[] = []
  const pending = new Set(commands.map(c => String(c['id'])))
  const reader = proc.stdout.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let sent = false
  let reading: ReturnType<typeof reader.read> | undefined
  const deadline = Date.now() + 60_000
  try {
    while (Date.now() < deadline && (pending.size > 0 || !sent)) {
      reading ??= reader.read()
      const chunk = await Promise.race([reading, Bun.sleep(1000).then(() => undefined)])
      if (chunk === undefined) continue
      reading = undefined
      if (chunk.done) break
      buf += dec.decode(chunk.value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let f: Frame
        try { f = JSON.parse(line) as Frame } catch { continue }
        frames.push(f)
        if (f.type === 'ready' && !sent) {
          sent = true
          for (const c of commands) proc.stdin.write(JSON.stringify(c) + '\n')
          proc.stdin.flush()
        }
        const isPrompt = commands.some(c => c['id'] === f.id && c['type'] === 'prompt')
        if (f.id !== undefined && (isPrompt ? f.type === 'prompt_result' : f.type === 'response')) pending.delete(f.id)
      }
    }
  } finally {
    try { proc.stdin.end() } catch {  }
    proc.kill('SIGTERM')
    await Promise.race([proc.exited, Bun.sleep(5000)])
  }
  return frames
}

async function planYolo(sb: Sandbox, userConfig: string | undefined): Promise<{ work: string, files: string[], requests: Array<{ messages?: Array<{ role?: string }> }> }> {
  const plan = '# Add a cache\n\n1. Cache the index\n2. Test it\n'
  const requests: Array<{ messages?: Array<{ role?: string, content?: unknown }>, tools?: Array<{ function?: { name?: string } }> }> = []
  const sse = (body: Record<string, unknown>) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'offline', ...body })}\n\n`
  const reply = (delta: Record<string, unknown>, finish: string) => sse({ choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })
    + sse({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })
    + sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    + 'data: [DONE]\n\n'
  const call = (n: number, args: Record<string, unknown>) => reply({ tool_calls: [{ index: 0, id: `call_${n}`, type: 'function', function: { name: 'write', arguments: JSON.stringify(args) } }] }, 'tool_calls')
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      if (req.method !== 'POST' || !new URL(req.url).pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
      const body = await req.json() as (typeof requests)[number]
      requests.push(body)
      const tools = (body.tools ?? []).map(t => t.function?.name)
      const results = (body.messages ?? []).filter(m => m.role === 'tool').length
      const text = !tools.includes('write') || results >= 2 ? reply({ content: 'Implementing.' }, 'stop')
        : results === 0 ? call(1, { path: 'local://add-a-cache-plan.md', content: plan }) : call(2, { path: 'xd://propose', content: 'add-a-cache' })
      return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const env = ompEnv(sb)
  try {
    return await withEnv({ PI_CODING_AGENT_DIR: env['PI_CODING_AGENT_DIR'], XDG_CONFIG_HOME: env['XDG_CONFIG_HOME'], XDG_DATA_HOME: env['XDG_DATA_HOME'], XDG_STATE_HOME: env['XDG_STATE_HOME'], XDG_CACHE_HOME: env['XDG_CACHE_HOME'] }, async () => {
      const work = join(sb.root, 'work')
      mkdirSync(work, { recursive: true })
      const agentDir = join(sb.home, '.omp', 'agent')
      mkdirSync(agentDir, { recursive: true })
      if (userConfig !== undefined) writeFileSync(join(agentDir, 'config.yml'), userConfig)
      const first = await applyPlans([await adapter.installPlan(devContext(REPO))])
      expect(first.conflicts).toEqual([])
      offlineAgentDir(sb)
      const models = join(agentDir, 'models.yml')
      writeFileSync(models, readFileSync(models, 'utf8').replace('http://127.0.0.1:9/v1', `http://127.0.0.1:${server.port}/v1`))
      const frames = await rpc(sb, [{ id: 'y1', type: 'prompt', message: 'plan a cache for the index' }], work, env,
        ['--model', 'buracle-smoke/offline', '--plan-yolo', '--plan-yolo-into', 'buracle-smoke/offline'])
      expect(frames.filter(f => f.type === 'extension_error')).toEqual([])
      expect(JSON.stringify(requests.at(-1)?.messages ?? [])).toContain('Plan approved. Implementing now with ')
      const dir = join(work, 'docs', 'plans')
      const files = existsSync(dir) ? readdirSync(dir).sort() : []
      await rollbackTxn(first.txn)
      return { work, files, requests }
    })
  } finally {
    server.stop(true)
  }
}

smoke('omp smoke (real binary, sandboxed)', () => {
  test('H12: the plan-mode text and settings Buracle relies on are in this omp (the execution prompt, the approving tool results, the local:// root, plan.autosave)', () => {
    const bin = readFileSync(realpathSync(OMP as string))
    for (const text of [`${OMP_PLAN_APPROVED}\n{{#if contextPreserved}}`, `${OMP_PLAN_OPEN}{{planFilePath}}">\n{{planContent}}\n${OMP_PLAN_CLOSE}`, 'Plan approved. Implementing now with ', 'Plan approved at ', 'planExists: true', 'sessionManager: this.sessionManager,', 'Session-scoped scratch space for large intermediate data', 'Invalid URL encoding in local:// path', 'id: "plan.autosave"', 'id: "plan.autosaveDir"', 'Empty uses <project>/.omp/plans/.']) {
      expect({ text, found: bin.includes(Buffer.from(text, 'utf8')) }).toEqual({ text, found: true })
    }
  }, 60_000)

  test('the generated package links, loads and round-trips through the install plan', () => withSandbox(async sb => {
    const env = ompEnv(sb)
    await withEnv({ PI_CODING_AGENT_DIR: env['PI_CODING_AGENT_DIR'], XDG_CONFIG_HOME: env['XDG_CONFIG_HOME'], XDG_DATA_HOME: env['XDG_DATA_HOME'], XDG_STATE_HOME: env['XDG_STATE_HOME'], XDG_CACHE_HOME: env['XDG_CACHE_HOME'] }, async () => {
      const ctx = devContext(REPO)
      const work = join(sb.root, 'work')
      mkdirSync(work, { recursive: true })

      const first = await applyPlans([await adapter.installPlan(ctx)])
      expect(first.conflicts).toEqual([])
      expect(first.applied).toBe(4)
      expect((await checkLink(HARNESS, OMP as string)).state).toBe('linked')
      expect(existsSync(join(sb.home, '.omp', 'plugins', 'node_modules', 'buracle-omp', 'package.json'))).toBe(true)

      const doctor = JSON.parse(omp(sb, ['plugin', 'doctor', '--json']).stdout) as Array<{ name: string, status: string }>
      expect(doctor.find(c => c.name === 'plugin:buracle-omp')?.status).toBe('ok')
      const get = (key: string) => (JSON.parse(omp(sb, ['config', 'get', key, '--json']).stdout) as { value: unknown }).value
      expect(get('statusLine.preset')).toBe('custom')
      expect(get('statusLine.rightSegments')).toContain('status')
      expect(get('statusLine.showHookStatus')).toBe(false)
      expect(get('tools.approvalMode')).toBe('yolo')
      expect(get('tools.xdev')).toBe(false)
      expect(get('defaultThinkingLevel')).toBe('xhigh')
      expect(get('memory.backend')).toBe('off')
      expect(get('lsp.diagnosticsOnEdit')).toBe(true)
      expect(get('enabledProviders')).toEqual([])
      expect(get('plan.autosave')).toBe(true)
      expect(get('plan.autosaveDir')).toBe(paths.ompPlanStagingDir())

      const py = JSON.parse(omp(sb, ['ttsr', 'test', '--source', 'tool', '--tool', 'write', '--path', 'src/app.py', '--json', 'print(1)'], work).stdout) as { triggered: Array<{ name: string, sourceProvider: string }> }
      expect(py.triggered.filter(t => t.name.startsWith('buracle-')).map(t => [t.name, t.sourceProvider])).toEqual([['buracle-python', 'omp-plugins']])
      const prose = JSON.parse(omp(sb, ['ttsr', 'test', '--source', 'text', '--json', 'I will edit app.py and package.json next'], work).stdout) as { triggered: Array<{ name: string }> }
      expect(prose.triggered.filter(t => t.name.startsWith('buracle-'))).toEqual([])

      offlineAgentDir(sb)
      const frames = await rpc(sb, [
        { id: 'c1', type: 'get_available_commands' },
        { id: 'c2', type: 'prompt', message: '/buracle' },
        { id: 'c3', type: 'get_state' },
        { id: 'c4', type: 'bash', command: 'echo "SID=$BURACLE_SESSION_ID H=$BURACLE_HARNESS"' },
        { id: 'c5', type: 'prompt', message: '/remember -- the smoke note' },
        { id: 'c6', type: 'prompt', message: '/brain' },
        { id: 'c7', type: 'prompt', message: '/buracle-status flow' },
      ], work)
      expect(frames.filter(f => f.type === 'extension_error')).toEqual([])
      const names = frames.find(f => f.id === 'c1' && f.type === 'response')?.data?.commands?.map(c => c.name) ?? []
      for (const n of [...ompCommandSkills(ctx.canonical), ...OMP_UTILITY_COMMANDS]) expect(names).toContain(n)
      const notices = frames.filter(f => f.type === 'extension_ui_request' && f.method === 'notify').map(f => f.message ?? '')
      expect(notices[0]).toStartWith(`Buracle ${buracleVersion(REPO)} · Oh My Pi (tested ${OMP_TESTED_WITH}, minimum ${OMP_MIN_VERSION})`)
      expect(notices).toContain('Remembered: capture-smoke-note')
      expect(notices).toContain('Memory UI: http://127.0.0.1:41777')
      expect(notices).toContain('No workflow is running.')
      for (const id of ['c2', 'c5', 'c6', 'c7']) expect(frames.find(f => f.type === 'prompt_result' && f.id === id)).toMatchObject({ agentInvoked: false, status: 'completed' })
      const state = frames.find(f => f.id === 'c3' && f.type === 'response')?.data
      const system = JSON.stringify(state?.systemPrompt ?? '')
      for (const heading of ['# Core working rules', '# Tool routing (strict)', '# Memory']) expect(system).toContain(heading)
      expect(JSON.stringify(state ?? {})).toContain('mcp__buracle_memory_memory_search')
      const sid = state?.sessionId
      expect(sid).toMatch(/^[0-9a-f-]{36}$/)
      expect(frames.find(f => f.id === 'c4' && f.type === 'response')?.data?.output).toBe(`SID=${sid} H=omp\n`)
      expect(existsSync(join(sb.buracleHome, 'sessions', 'omp'))).toBe(true)

      const findings = await adapter.doctor(ctx)
      expect(findings.filter(f => f.level === 'error')).toEqual([])
      expect(findings.find(f => f.check === 'omp plugin')?.level).toBe('ok')

      const again = await applyPlans([await adapter.installPlan(ctx)])
      expect(again.applied).toBe(0)
      const back = await rollbackTxn(first.txn)
      expect(back.errors).toEqual([])
      expect((await checkLink(HARNESS, OMP as string)).state).toBe('absent')
      expect(existsSync(join(sb.home, '.omp', 'agent', 'config.yml'))).toBe(false)
      expect(existsSync(join(sb.home, '.omp', 'agent', 'lsp.json'))).toBe(false)
    })
  }), 240_000)

  test('OMP-AGENTSMD-SHADOW: a ~/.agents/AGENTS.md created after the install still reaches the system prompt', () => withSandbox(async sb => {
    const env = ompEnv(sb)
    await withEnv({ PI_CODING_AGENT_DIR: env['PI_CODING_AGENT_DIR'], XDG_CONFIG_HOME: env['XDG_CONFIG_HOME'], XDG_DATA_HOME: env['XDG_DATA_HOME'], XDG_STATE_HOME: env['XDG_STATE_HOME'], XDG_CACHE_HOME: env['XDG_CACHE_HOME'] }, async () => {
      const ctx = devContext(REPO)
      const work = join(sb.root, 'work')
      mkdirSync(work, { recursive: true })
      const first = await applyPlans([await adapter.installPlan(ctx)])
      expect(first.conflicts).toEqual([])
      mkdirSync(join(sb.home, '.agents'), { recursive: true })
      writeFileSync(join(sb.home, '.agents', 'AGENTS.md'), 'SHARED-MARKER-XYZ: always answer in Turkish.\n')
      offlineAgentDir(sb)
      const frames = await rpc(sb, [{ id: 's1', type: 'get_state' }], work)
      const system = JSON.stringify(frames.find(f => f.id === 's1' && f.type === 'response')?.data?.systemPrompt ?? '')
      expect(system).toContain('SHARED-MARKER-XYZ')
      expect(system).toContain('Buracle is active through the')
      await rollbackTxn(first.txn)
    })
  }), 240_000)

  test('I8: the buracle-memory server starts from a custom BURACLE_HOME through the generated .mcp.json', () => withSandbox(async sb => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'buracle-omp-mcp-'))
    try {
      cpSync(HARNESS, dir, { recursive: true })
      const ctx = devContext(REPO)
      const mcp = (await buildOmp(ctx)).find(f => f.path === '.mcp.json')
      writeFileSync(join(dir, '.mcp.json'), mcp?.content ?? '')
      const custom = join(sb.root, 'custom-buracle')
      const env = { ...ompEnv(sb), BURACLE_HOME: custom }
      offlineAgentDir(sb)
      mkdirSync(join(custom, 'bin'), { recursive: true })
      cpSync(join(sb.buracleHome, 'bin', 'buracle'), join(custom, 'bin', 'buracle'))
      rmSync(join(sb.buracleHome, 'bin', 'buracle'))
      const link = Bun.spawnSync([OMP as string, 'plugin', 'link', dir], { cwd: sb.root, env, stdout: 'pipe', stderr: 'pipe' })
      expect(link.exitCode).toBe(0)
      const work = join(sb.root, 'work')
      mkdirSync(work, { recursive: true })
      const frames = await rpc(sb, [{ id: 'm1', type: 'get_state' }], work, env)
      expect(JSON.stringify(frames.find(f => f.id === 'm1' && f.type === 'response')?.data ?? {})).toContain('mcp__buracle_memory_memory_search')
      Bun.spawnSync([OMP as string, 'plugin', 'uninstall', 'buracle-omp'], { cwd: sb.root, env })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }), 240_000)

  test('/buracle-ping answers without a turn; /aside asks the model once and leaves the session empty', () => withSandbox(async sb => {
    const requests: Array<{ messages?: Array<{ role?: string, content?: unknown }>, tools?: unknown[], tool_choice?: unknown }> = []
    const sse = (body: Record<string, unknown>) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'offline', ...body })}\n\n`
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(req) {
        if (req.method !== 'POST' || !new URL(req.url).pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
        requests.push(await req.json() as (typeof requests)[number])
        const body = sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'four' }, finish_reason: null }] })
          + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
          + sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
          + 'data: [DONE]\n\n'
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    const env = ompEnv(sb)
    try {
      await withEnv({ PI_CODING_AGENT_DIR: env['PI_CODING_AGENT_DIR'], XDG_CONFIG_HOME: env['XDG_CONFIG_HOME'], XDG_DATA_HOME: env['XDG_DATA_HOME'], XDG_STATE_HOME: env['XDG_STATE_HOME'], XDG_CACHE_HOME: env['XDG_CACHE_HOME'] }, async () => {
        const work = join(sb.root, 'work')
        mkdirSync(work, { recursive: true })
        const first = await applyPlans([await adapter.installPlan(devContext(REPO))])
        expect(first.conflicts).toEqual([])
        offlineAgentDir(sb)
        const models = join(sb.home, '.omp', 'agent', 'models.yml')
        writeFileSync(models, readFileSync(models, 'utf8').replace('http://127.0.0.1:9/v1', `http://127.0.0.1:${server.port}/v1`))
        const frames = await rpc(sb, [
          { id: 'a1', type: 'prompt', message: '/buracle-ping' },
          { id: 'a2', type: 'prompt', message: '/aside what is 2+2' },
          { id: 'a3', type: 'get_messages' },
        ], work)
        expect(frames.filter(f => f.type === 'extension_error')).toEqual([])
        const notices = frames.filter(f => f.type === 'extension_ui_request' && f.method === 'notify').map(f => f.message ?? '')
        expect(notices).toContain('buracle: pong')
        expect(notices).toContain('aside: four')
        for (const id of ['a1', 'a2']) expect(frames.find(f => f.type === 'prompt_result' && f.id === id)).toMatchObject({ agentInvoked: false, status: 'completed' })
        const asked = requests.filter(r => JSON.stringify(r.messages ?? []).includes('what is 2+2'))
        expect(asked.length).toBe(1)
        expect(JSON.stringify(asked[0]?.messages?.at(-1))).toContain('Answer briefly, from this conversation alone, without changing anything: what is 2+2')
        expect(asked[0]?.tools ?? []).toEqual([])
        expect(frames.find(f => f.id === 'a3' && f.type === 'response')?.data?.messages).toEqual([])
        await rollbackTxn(first.txn)
      })
    } finally {
      server.stop(true)
    }
  }), 240_000)

  test('PARITY-6: omp loads the csharp-ls server the install adds to ~/.omp/agent/lsp.json (omp has none built in), also in a repository whose project sits in a subfolder, and its lsp tool answers from it', () => withSandbox(async sb => {
    const requests: Array<{ messages?: Array<{ role?: string, content?: unknown }>, tools?: Array<{ function?: { name?: string } }> }> = []
    const sse = (body: Record<string, unknown>) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'offline', ...body })}\n\n`
    const end = (finish: string) => sse({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + 'data: [DONE]\n\n'
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(req) {
        if (req.method !== 'POST' || !new URL(req.url).pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
        const body = await req.json() as (typeof requests)[number]
        requests.push(body)
        const offered = (body.tools ?? []).some(t => t.function?.name === 'lsp')
        const answered = (body.messages ?? []).some(m => m.role === 'tool')
        const call = { tool_calls: [{ index: 0, id: 'call_lsp', type: 'function', function: { name: 'lsp', arguments: JSON.stringify({ action: 'diagnostics', file: 'src/a.cs' }) } }] }
        const text = offered && !answered
          ? sse({ choices: [{ index: 0, delta: { role: 'assistant', ...call }, finish_reason: null }] }) + end('tool_calls')
          : sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] }) + end('stop')
        return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    const env = ompEnv(sb)
    try {
      await withEnv({ PI_CODING_AGENT_DIR: env['PI_CODING_AGENT_DIR'], XDG_CONFIG_HOME: env['XDG_CONFIG_HOME'], XDG_DATA_HOME: env['XDG_DATA_HOME'], XDG_STATE_HOME: env['XDG_STATE_HOME'], XDG_CACHE_HOME: env['XDG_CACHE_HOME'] }, async () => {
        const work = join(sb.root, 'work')
        mkdirSync(join(work, '.git'), { recursive: true })
        mkdirSync(join(work, 'src'), { recursive: true })
        writeFileSync(join(work, 'src', 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />\n')
        writeFileSync(join(work, 'src', 'a.cs'), 'class A {}\n// ERROR: the name B does not exist\n')
        const bin = join(sb.root, 'lsp-bin')
        mkdirSync(bin, { recursive: true })
        writeFileSync(join(bin, 'csharp-ls'), `#!/bin/sh\nexec '${process.execPath}' '${join(REPO, 'tests', 'fixtures', 'lsp', 'stub-lsp.ts')}' pull\n`, { mode: 0o755 })
        const first = await applyPlans([await adapter.installPlan(devContext(REPO))])
        expect(first.conflicts).toEqual([])
        expect(existsSync(join(sb.home, '.omp', 'agent', 'lsp.json'))).toBe(true)
        offlineAgentDir(sb)
        const models = join(sb.home, '.omp', 'agent', 'models.yml')
        writeFileSync(models, readFileSync(models, 'utf8').replace('http://127.0.0.1:9/v1', `http://127.0.0.1:${server.port}/v1`))
        const frames = await rpc(sb, [{ id: 'l1', type: 'prompt', message: 'check src/a.cs' }], work, { ...env, PATH: pathOf(bin, env['PATH'] ?? '') })
        expect(frames.filter(f => f.type === 'extension_error')).toEqual([])
        const results = JSON.stringify(requests.flatMap(r => (r.messages ?? []).filter(m => m.role === 'tool')))
        expect(results).toContain('the name B does not exist')
        await rollbackTxn(first.txn)
      })
    } finally {
      server.stop(true)
    }
  }), 240_000)

  test('H12 with --plan-yolo: the approving tool result (wrapped by omp\'s xd:// device) names the plan file; the extension reads it from the session\'s local:// folder, even with the user\'s plan.autosave off', () => withSandbox(async sb => {
    const { work, files, requests } = await planYolo(sb, 'plan:\n  autosave: false\n')
    expect(files.map(f => f.replace(/^\d{4}-\d{2}-\d{2}-/, ''))).toEqual(['add-a-cache.md'])
    const text = readFileSync(join(work, 'docs', 'plans', files[0] as string), 'utf8')
    expect(text).toContain('harness: omp')
    expect(text).toContain('> 2. Test it')
    expect(JSON.stringify(requests.at(-1)?.messages ?? [])).toContain('(H12)')
  }), 240_000)

  test('H12 with --plan-yolo and Buracle\'s autosave keys: omp writes its copy into the staging folder, the plan is saved once and the identical copy is removed', () => withSandbox(async sb => {
    const { files } = await planYolo(sb, undefined)
    expect(files.map(f => f.replace(/^\d{4}-\d{2}-\d{2}-/, ''))).toEqual(['add-a-cache.md'])
    const staging = paths.ompPlanStagingDir()
    expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([])
    expect(existsSync(staging)).toBe(true)
  }), 240_000)

  test('non-glob path tokens become explicit edit/write scopes that omp honors', () => withSandbox(async sb => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'buracle-omp-fixture-'))
    try {
      const canonical = fixtureCanonical()
      writeTree(dir, await buildOmp({ repoRoot: REPO, config: canonical.config, canonical, paths, buracleBin: '/x' }))
      const work = join(sb.root, 'work')
      mkdirSync(work, { recursive: true })
      expect(omp(sb, ['plugin', 'link', dir]).code).toBe(0)
      const docker = JSON.parse(omp(sb, ['ttsr', 'test', '--source', 'tool', '--tool', 'edit', '--path', 'Dockerfile', '--json', 'FROM node:22'], work).stdout) as { triggered: Array<{ name: string }> }
      expect(docker.triggered.map(t => t.name)).toContain('buracle-docker')
      const other = JSON.parse(omp(sb, ['ttsr', 'test', '--source', 'tool', '--tool', 'edit', '--path', 'README.md', '--json', 'Dockerfile notes'], work).stdout) as { triggered: Array<{ name: string }> }
      expect(other.triggered.map(t => t.name)).not.toContain('buracle-docker')
      expect(omp(sb, ['plugin', 'uninstall', 'buracle-omp']).code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }), 120_000)
})

if (!READY) {
  test.skip(`omp smoke skipped: ${OMP === undefined ? 'omp is not on PATH' : 'harness/omp is not built'}`, () => undefined)
}
