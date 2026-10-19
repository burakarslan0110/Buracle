import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readTemplate, readTree, packageVersion } from '../../../src/adapters/claude/build'
import { TESTED_WITH } from '../../../src/adapters/claude/constants'
import { devContext, syncTree } from '../../../src/adapters/claude/dev-build'
import { generatePlugin } from '../../../src/adapters/claude/plugin'
import * as paths from '../../../src/engine/paths'
import { shimContent } from '../../../src/engine/update/install-core'
import { claudeVersionGate, claudeVersionText } from '../../helpers/claude-version'
import { withSandbox, type Sandbox } from '../../helpers/sandbox'

const REPO = paths.repoRoot()
const OVERRIDE = process.env['BURACLE_CLAUDE_BIN']
const BIN = OVERRIDE ?? Bun.which('claude') ?? undefined

const SKIPPED = process.env['BURACLE_SKIP_CLAUDE_SMOKE'] === '1'
const GATE = BIN !== undefined && !SKIPPED && OVERRIDE === undefined ? claudeVersionGate(claudeVersionText(BIN)) : undefined
const RUNS = BIN !== undefined && !SKIPPED && (OVERRIDE !== undefined || GATE?.runs === true)
if (GATE?.note !== undefined) console.warn(`claude smoke: ${GATE.note}`)

type Body = Record<string, unknown>
interface Mock { url: string; requests: Body[]; tool?: { name: string, input: Record<string, unknown> }; toolUsed: boolean; stop(): void }

function toolNames(body: Body): string[] {
  return (Array.isArray(body['tools']) ? body['tools'] as Body[] : []).map(t => String(t['name'] ?? t['type']))
}

function lastUserHasToolResult(body: Body): boolean {
  const msgs = Array.isArray(body['messages']) ? body['messages'] as Body[] : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as Body
    if (m['role'] !== 'user') continue
    const c = m['content']
    return Array.isArray(c) && (c as Body[]).some(b => b['type'] === 'tool_result')
  }
  return false
}

function startMock(): Mock {
  const mock: Mock = { url: '', requests: [], toolUsed: false, stop: () => undefined }
  let n = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method !== 'POST') return path.startsWith('/v1/models') ? Response.json({ data: [], has_more: false }) : new Response('{}', { status: 404 })
      const body = await req.json().catch(() => ({})) as Body
      if (path.includes('count_tokens')) return Response.json({ input_tokens: 42 })
      if (!path.startsWith('/v1/messages')) return new Response('{}', { status: 404 })
      mock.requests.push(body)
      n++
      let content: Body[] = [{ type: 'text', text: lastUserHasToolResult(body) ? 'DONE' : 'OK' }]
      let stop = 'end_turn'
      if (mock.tool !== undefined && !mock.toolUsed && toolNames(body).includes(mock.tool.name) && !lastUserHasToolResult(body)) {
        mock.toolUsed = true
        content = [{ type: 'tool_use', id: `toolu_mock_${n}`, name: mock.tool.name, input: mock.tool.input }]
        stop = 'tool_use'
      }
      const model = typeof body['model'] === 'string' ? body['model'] : 'mock'
      const usage = { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      if (body['stream'] !== true) return Response.json({ id: `msg_mock_${n}`, type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage })
      const events: string[] = []
      const ev = (name: string, data: unknown) => events.push(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      ev('message_start', { type: 'message_start', message: { id: `msg_mock_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } })
      content.forEach((block, i) => {
        if (block['type'] === 'text') {
          ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } })
          ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block['text'] } })
        } else {
          ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: block['id'], name: block['name'], input: {} } })
          ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block['input']) } })
        }
        ev('content_block_stop', { type: 'content_block_stop', index: i })
      })
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 2 } })
      ev('message_stop', { type: 'message_stop' })
      return new Response(events.join(''), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
    },
  })
  mock.url = `http://127.0.0.1:${server.port}`
  mock.stop = () => { void server.stop(true) }
  return mock
}

interface World { sb: Sandbox; plugin: string; proj: string; mock: Mock }

async function setUp(sb: Sandbox): Promise<World> {
  const ctx = devContext()
  const plugin = join(sb.root, 'plugin')
  mkdirSync(plugin, { recursive: true })
  syncTree(plugin, generatePlugin({
    canonical: ctx.canonical,
    buracleVersion: packageVersion(REPO),
    coreFiles: readTree(join(REPO, 'src', 'core'), rel => rel.endsWith('.ts')),
    templateFiles: readTemplate(REPO).filter(f => f.path !== 'register.tsx'),
  }))
  const generated = JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, Body> }
  const stub = join(import.meta.dir, 'fixtures', 'mcp-stub.ts')
  const servers: Record<string, Body> = {}
  for (const [id, entry] of Object.entries(generated.mcpServers)) {
    if (entry['type'] === 'http') continue
    servers[id] = { command: process.execPath, args: [stub, id], ...(entry['alwaysLoad'] === true ? { alwaysLoad: true } : {}) }
  }
  writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2))
  const shim = join(paths.binDir(), 'buracle')
  mkdirSync(dirname(shim), { recursive: true })
  writeFileSync(shim, shimContent({ bun: process.execPath, repoRoot: REPO }))
  chmodSync(shim, 0o755)
  const proj = join(sb.home, 'proj')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 'package.json'), '{ "name": "smoke-proj", "dependencies": { "zod": "3.25.0" } }\n')
  mkdirSync(join(sb.root, 'tmp'), { recursive: true })
  return { sb, plugin, proj, mock: startMock() }
}

function settings(w: World, value: Body | undefined): void {
  const file = join(w.sb.home, '.claude', 'settings.json')
  if (value === undefined) { rmSync(file, { force: true }); return }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2))
}

function claudeEnv(w: World): Record<string, string> {
  const h = w.sb.home
  return {
    PATH: [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: h, USER: process.env['USER'] ?? 'smoke', LOGNAME: process.env['USER'] ?? 'smoke', SHELL: '/bin/sh', TERM: 'dumb', LANG: 'en_US.UTF-8',
    TMPDIR: `${join(w.sb.root, 'tmp')}/`,
    CLAUDE_CONFIG_DIR: join(h, '.claude'),
    XDG_CONFIG_HOME: join(h, '.config'), XDG_DATA_HOME: join(h, '.local', 'share'), XDG_STATE_HOME: join(h, '.local', 'state'), XDG_CACHE_HOME: join(h, '.cache'),
    ANTHROPIC_BASE_URL: w.mock.url, ANTHROPIC_API_KEY: 'sk-ant-smoke-test-not-a-real-key',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ENABLE_TOOL_SEARCH: 'true',
    BURACLE_HOME: w.sb.buracleHome,
    BURACLE_NO_AUTOSTART: '1', BURACLE_NO_TOOLCHAIN: '1', BURACLE_NO_NOTIFY: '1', BURACLE_NO_DISTILL: '1', BURACLE_NO_REFLECT: '1', BURACLE_NO_MEMORY: '1',
  }
}

interface Run { code: number; events: Body[]; stderr: string; sid: string }

async function claude(w: World, prompt: string): Promise<Run> {
  const p = Bun.spawn([BIN as string, '-p', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--plugin-dir', w.plugin, prompt], {
    cwd: w.proj, env: claudeEnv(w), stdout: 'pipe', stderr: 'pipe',
  })
  const timer = setTimeout(() => p.kill(), 120_000)
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  clearTimeout(timer)
  const events = stdout.split('\n').filter(l => l.trim().startsWith('{')).map(l => JSON.parse(l) as Body)
  const sid = String(events.find(e => typeof e['session_id'] === 'string')?.['session_id'] ?? '')
  const dump = process.env['BURACLE_SMOKE_DUMP']
  if (dump !== undefined && dump !== '') {
    mkdirSync(dump, { recursive: true })
    writeFileSync(join(dump, `${sid || 'run'}.events.jsonl`), stdout)
    writeFileSync(join(dump, `${sid || 'run'}.requests.json`), JSON.stringify(w.mock.requests, null, 2))
  }
  return { code, events, stderr, sid }
}

function hookOutputs(r: Run, event: string): Body[] {
  return r.events
    .filter(e => e['subtype'] === 'hook_response' && e['hook_event'] === event)
    .map(e => { const o = String(e['output'] ?? '').trim(); return o === '' ? {} : JSON.parse(o) as Body })
}

function contextOf(o: Body): string {
  return String((o['hookSpecificOutput'] as Body | undefined)?.['additionalContext'] ?? '')
}

function sessionFile(w: World, sid: string, name: string): Body | undefined {
  const f = join(w.sb.buracleHome, 'sessions', 'claude', sid, name)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) as Body : undefined
}

async function eventually<T>(fn: () => T | undefined, ms = 8_000): Promise<T | undefined> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v !== undefined || Date.now() > end) return v
    await Bun.sleep(100)
  }
}

const smoke = RUNS ? describe : describe.skip

smoke(`Claude Code ${OVERRIDE !== undefined ? '(BURACLE_CLAUDE_BIN)' : (GATE?.version || TESTED_WITH)} runs the plugin's command hooks`, () => {
  test('session start context, alwaysLoad, a typed workflow, the router and the turn-end check, the permission warning, the Skill tool', async () => {
    await withSandbox(async sb => {
      const w = await setUp(sb)
      try {
        const bypass = { permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }

        settings(w, bypass)
        const typed = await claude(w, '/buracle:plan-build add rate limiting')
        expect(typed.code, typed.stderr).toBe(0)
        const start = hookOutputs(typed, 'SessionStart')[0] ?? {}
        expect(contextOf(start)).toContain('Buracle capabilities (Claude Code)')
        expect(contextOf(start)).toContain(`Project root: ${w.proj}.`)
        expect(hookOutputs(typed, 'UserPromptExpansion')).toHaveLength(1)
        expect(((sessionFile(w, typed.sid, 'flow.json')?.['stack'] as Body[] | undefined) ?? []).map(e => [e['workflow'], e['title']])).toEqual([['plan-build', 'add rate limiting']])
        expect((sessionFile(w, typed.sid, 'ledger.json')?.['skills'] as Record<string, Body> | undefined)?.['plan-build']?.['n']).toBe(1)
        expect(hookOutputs(typed, 'UserPromptSubmit').some(o => o['systemMessage'] !== undefined)).toBe(false)
        const sent = JSON.stringify(w.mock.requests)
        expect(sent).toContain('Buracle capabilities (Claude Code)')
        expect(sent).toContain('Base directory for this skill')
        const first = w.mock.requests.find(b => toolNames(b).includes('Skill')) as Body
        const tools = (first['tools'] as Body[]).filter(t => typeof t['name'] === 'string')
        const upfront = (name: string) => tools.some(t => t['name'] === name && t['defer_loading'] !== true)
        for (const id of ['context7', 'codegraph', 'semble', 'buracle-memory']) expect(upfront(`mcp__plugin_buracle_${id}__ping`), id).toBe(true)
        expect(upfront('mcp__plugin_buracle_chrome-devtools__ping')).toBe(false)

        settings(w, undefined)
        w.mock.requests.length = 0
        const asked = await claude(w, 'use the plan-build workflow to add rate limiting')
        expect(asked.code, asked.stderr).toBe(0)
        const ups = hookOutputs(asked, 'UserPromptSubmit')[0] ?? {}
        expect(contextOf(ups)).toContain('Buracle routing for this prompt:')
        expect(contextOf(ups)).toContain(`read ${join(w.plugin, 'skills', 'plan-build', 'SKILL.md')}`)
        expect(String(ups['systemMessage'])).toContain('permission mode, not bypassPermissions')
        const stops = hookOutputs(asked, 'Stop')
        const feedback = (o: Body | undefined): unknown => (o?.['hookSpecificOutput'] as Body | undefined)?.['additionalContext']
        expect(stops[0]?.['decision']).toBeUndefined()
        expect(String(feedback(stops[0]))).toStartWith('Buracle routing check: the user asked for plan-build and it was not loaded.')
        expect(stops.slice(1).every(o => o['decision'] === undefined && feedback(o) === undefined)).toBe(true)
        expect(JSON.stringify(w.mock.requests)).toContain('Buracle routing check:')

        settings(w, bypass)
        w.mock.tool = { name: 'Skill', input: { skill: 'buracle:research', args: 'bun 1.4 release notes' } }
        const loaded = await claude(w, 'what changed in bun lately?')
        expect(loaded.code, loaded.stderr).toBe(0)
        expect((sessionFile(w, loaded.sid, 'ledger.json')?.['skills'] as Record<string, Body> | undefined)?.['research']?.['n']).toBe(1)
        const flow = await eventually(() => sessionFile(w, loaded.sid, 'flow.json'))
        expect(((flow?.['stack'] as Body[] | undefined) ?? []).map(e => [e['workflow'], e['source']])).toEqual([['research', 'skill']])
      } finally {
        w.mock.stop()
      }
    })
  }, 300_000)
})
