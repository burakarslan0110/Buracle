import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { devContext } from '../../../src/adapters/omp/dev-build'
import { adapter } from '../../../src/adapters/pi/index'
import { EXTENSION_PATH, piMcpServers } from '../../../src/adapters/pi/build'
import { piArgv } from '../../../src/workflow/companion-hosts'
import * as paths from '../../../src/engine/paths'
import { which } from '../../../src/engine/proc'
import { applyPlans } from '../../../src/engine/txn'
import { saveState } from '../../../src/workflow/session-store'
import { withEnv, withSandbox, type Sandbox } from '../../helpers/sandbox'
import { BUILT } from '../../helpers/built-harness'

// Against the real `pi` program, with its home and agent folder in the sandbox. Pi needs a model to call a tool, and no
// login is used here: a local server answers as an OpenAI-compatible endpoint, first with a tool call and then with text.
// What is checked is Pi's own loading of the extension and its tool_call hook, not a model.

const PI = which('pi')
const REPO = paths.repoRoot()
const READY = PI !== undefined && existsSync(join(BUILT.harness, 'pi', EXTENSION_PATH))
const smoke = READY ? describe : describe.skip

function piEnv(sb: Sandbox, agent: string): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    PATH: [dirname(PI as string), dirname(process.execPath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':'),
    HOME: sb.home, PI_CODING_AGENT_DIR: agent, BURACLE_HOME: sb.buracleHome,
    XDG_CONFIG_HOME: join(sb.home, '.config'), XDG_DATA_HOME: join(sb.home, '.local', 'share'), XDG_STATE_HOME: join(sb.home, '.local', 'state'), XDG_CACHE_HOME: join(sb.home, '.cache'),
    PI_OFFLINE: '1', TERM: 'dumb', NO_COLOR: '1', BURACLE_NO_NOTICES: '1',
  }
}

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
}

type Step = { tool: string } | { text: string }
type Chat = { messages?: Array<{ role: string, content?: unknown }>, tools?: Array<{ function?: { name?: string } }> }

/** Answers request n with step n (the last step repeats). */
function fakeModel(steps: Step[]): { url: string, requests: Chat[], stop(): void } {
  const requests: Chat[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push(await req.json() as Chat)
      const step = steps[Math.min(requests.length - 1, steps.length - 1)] as Step
      const sse = 'tool' in step
        ? chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: step.tool }) } }] }, null) + chunk({}, 'tool_calls')
        : chunk({ role: 'assistant', content: step.text }, null) + chunk({}, 'stop')
      return new Response(sse + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => { void server.stop(true) } }
}

async function runPi(sb: Sandbox, agent: string, args: string[], cwd: string): Promise<{ code: number, out: string }> {
  const proc = Bun.spawn([PI as string, ...args], { cwd, env: piEnv(sb, agent), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => proc.kill(), 90_000)
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  return { code, out: out + err }
}

smoke('the real Pi (isolated home and agent folder)', () => {
  test('the installed extension loads and its tool_call hook holds a git push (H20) before the tool runs', () => withSandbox(async sb => {
    const agent = join(sb.root, 'agent')
    const work = join(sb.root, 'work')
    mkdirSync(work, { recursive: true })
    const model = fakeModel([{ tool: 'git push origin main' }, { text: 'done' }])
    try {
      await withEnv({ PI_CODING_AGENT_DIR: agent }, async () => { await applyPlans([await adapter.installPlan(devContext(REPO))]) })
      expect(existsSync(join(agent, EXTENSION_PATH))).toBe(true)
      writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: model.url, api: 'openai-completions', apiKey: 'unused', models: [{ id: 'm', contextWindow: 8000 }] } } }))
      const r = await runPi(sb, agent, ['-p', '--no-session', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-mcp', '--model', 'fake/m', 'push the branch'], work)
      expect(r.out).not.toContain('Failed to load extension')
      const toolMessage = model.requests.flatMap(q => q.messages ?? []).find(m => m.role === 'tool')
      expect(JSON.stringify(toolMessage?.content ?? '')).toContain('Buracle Stack H20')
      // The session start ran through the shared pipeline: Pi's session is recorded under the sandbox's BURACLE_HOME.
      expect(readdirSync(join(sb.buracleHome, 'sessions', 'pi')).length).toBeGreaterThan(0)
    } finally {
      model.stop()
    }
  }), 120_000)

  test('the stop guard blocks the end of a turn through agent_before_settle: the model gets one more turn with the reason', () => withSandbox(async sb => {
    const agent = join(sb.root, 'agent')
    const work = join(sb.root, 'work')
    const id = '0197a118-8d01-740c-9360-f4f796699f4b'
    mkdirSync(work, { recursive: true })
    const model = fakeModel([{ text: 'all done' }, { text: 'sorry, continuing' }])
    try {
      await withEnv({ PI_CODING_AGENT_DIR: agent }, async () => { await applyPlans([await adapter.installPlan(devContext(REPO))]) })
      writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: model.url, api: 'openai-completions', apiKey: 'unused', models: [{ id: 'm', contextWindow: 8000 }] } } }))
      // A plan that is in progress, registered for the session Pi will open under this id.
      saveState('pi', id, { v: 1, plan: { path: 'docs/plans/2026-10-08-demo.md', slug: 'demo', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: 1 }, guard: { blocksForPlan: 0, blocksInChain: 0 } })
      const r = await runPi(sb, agent, ['-p', '--no-session', '--session-id', id, '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-mcp', '--model', 'fake/m', 'finish the plan'], work)
      expect(r.out).not.toContain('Failed to load extension')
      expect(model.requests.length).toBeGreaterThanOrEqual(2)
      const last = JSON.stringify(model.requests[1]?.messages ?? [])
      expect(last).toContain('stop guard')
      expect(last).toContain('buracle plan')
    } finally {
      model.stop()
    }
  }), 120_000)

  test('the AGENTS.md block reaches the model: Pi loads it from the agent folder as user instructions', () => withSandbox(async sb => {
    const agent = join(sb.root, 'agent')
    const work = join(sb.root, 'work')
    mkdirSync(work, { recursive: true })
    const model = fakeModel([{ text: 'ok' }])
    try {
      await withEnv({ PI_CODING_AGENT_DIR: agent }, async () => { await applyPlans([await adapter.installPlan(devContext(REPO))]) })
      writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: model.url, api: 'openai-completions', apiKey: 'unused', models: [{ id: 'm', contextWindow: 8000 }] } } }))
      const r = await runPi(sb, agent, ['-p', '--no-session', '--no-skills', '--no-prompt-templates', '--no-mcp', '--model', 'fake/m', 'hello'], work)
      expect(r.code).toBe(0)
      expect(JSON.stringify(model.requests[0]?.messages ?? [])).toContain('Managed by Buracle Stack')
    } finally {
      model.stop()
    }
  }), 120_000)

  test('the second-opinion run: the prompt on stdin, only the read tools offered, the answer on stdout', () => withSandbox(async sb => {
    const agent = join(sb.root, 'agent')
    const work = join(sb.root, 'work')
    mkdirSync(work, { recursive: true })
    const model = fakeModel([{ text: 'REVIEW-ANSWER' }])
    mkdirSync(agent, { recursive: true })
    try {
      writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: model.url, api: 'openai-completions', apiKey: 'unused', models: [{ id: 'm', contextWindow: 8000 }] } } }))
      const proc = Bun.spawn([PI as string, ...piArgv().slice(1), '--model', 'fake/m'], { cwd: work, env: piEnv(sb, agent), stdin: new Blob(['Please review the change.']), stdout: 'pipe', stderr: 'pipe' })
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      expect(code).toBe(0)
      expect(out).toContain('REVIEW-ANSWER')
      const names = (model.requests[0]?.tools ?? []).map(t => t.function?.name).sort()
      expect(names).toEqual(['find', 'grep', 'ls', 'read'])
      expect(JSON.stringify(model.requests[0]?.messages ?? [])).toContain('Please review the change.')
    } finally {
      model.stop()
    }
  }), 120_000)

  test('the MCP entries Buracle Stack writes are valid for Pi: `pi mcp list` reads them (servers off, so none starts)', () => withSandbox(async sb => {
    const agent = join(sb.root, 'agent')
    mkdirSync(agent, { recursive: true })
    const c = devContext(REPO)
    const ids = Object.keys(piMcpServers(c.canonical))
    writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: piMcpServers(c.canonical, ids) }))
    const r = await runPi(sb, agent, ['mcp', 'list'], sb.root)
    expect(r.code).toBe(0)
    expect(r.out).toContain('buracle-memory')
    expect(readFileSync(join(agent, 'mcp.json'), 'utf8')).toContain('"enabled":false')
  }), 60_000)
})
