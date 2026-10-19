import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installPlan } from '../../../src/adapters/opencode/install'
import { OPENCODE_PLAN_AGENT } from '../../../src/adapters/opencode/runtime/plan-draft'
import { CONSENT_OPTIONS } from '../../../src/adapters/shared/consent-dialog'
import { readConsentState } from '../../../src/adapters/shared/consent-store'
import { catalogSkills } from '../../../src/core/catalog'
import { jsoncSet } from '../../../src/engine/merge'
import * as paths from '../../../src/engine/paths'
import { parseVersion } from '../../../src/engine/proc'
import { applyPlans } from '../../../src/engine/txn'
import { latestWindows } from '../../../src/usage/telemetry'
import { readFlow } from '../../../src/workflow/flow'
import { hostLimitsOf, probeClosers, probeMisses } from '../../../src/adapters/shared/host-limits'
import { narrowPath } from '../../helpers/fake-exe'
import { withSandbox } from '../../helpers/sandbox'
import { endsWithToolResult, lastUserText, offeredTools, startFakeProvider, systemTexts, type FakeProvider, type ToolRule } from './fake-provider'
import { adapterContext, canonical, REPO, until } from './helpers'

const OPENCODE = Bun.which('opencode', { PATH: process.env['PATH'] ?? '' })
const PASSWORD = 'buracle-smoke'
const MODEL = 'claude-opus-5-5'
const REVIEW_MARK = 'RUN_SPEC_REVIEW'
const BUSY_MARK = 'RUN_SLOW_STEP'
const QUEUED_MARK = 'QUEUED_COMPARE'

interface Server { url: string; proc: ReturnType<typeof Bun.spawn>; log: () => string }

function isolatedEnv(root: string, home: string, buracleHome: string, stubBin: string): Record<string, string> {
  return {
    PATH: [stubBin, dirname(OPENCODE as string), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    TMPDIR: join(root, 'tmp') + '/',
    BURACLE_HOME: buracleHome,
    OPENCODE_PASSWORD: PASSWORD,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    TERM: 'xterm-256color',
  }
}

async function startServer(env: Record<string, string>, cwd: string): Promise<Server> {
  const proc = Bun.spawn([OPENCODE as string, 'serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let out = ''
  const pump = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder()
    for await (const chunk of s) out += dec.decode(chunk, { stream: true })
  }
  void pump(proc.stdout as ReadableStream<Uint8Array>)
  void pump(proc.stderr as ReadableStream<Uint8Array>)
  await until(() => /listening on (http:\/\/127\.0\.0\.1:\d+)/.test(out) || proc.exitCode !== null, 30_000)
  const url = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out)?.[1]
  if (url === undefined) throw new Error(`opencode serve did not start:\n${out}`)
  return { url, proc, log: () => out }
}

async function api(server: Server, method: string, path: string, directory: string, body?: unknown): Promise<any> {
  const url = new URL(path.replace(/^\//, ''), server.url + '/')
  url.searchParams.set('location[directory]', directory)
  const res = await fetch(url, {
    method,
    headers: { authorization: `Basic ${btoa(`opencode:${PASSWORD}`)}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 500)}`)
  return text === '' ? undefined : JSON.parse(text)
}

async function stop(server: Server): Promise<void> {
  server.proc.kill('SIGTERM')
  const done = await Promise.race([server.proc.exited.then(() => true), Bun.sleep(5000).then(() => false)])
  if (!done) server.proc.kill('SIGKILL')
  await server.proc.exited
}

function versionOk(): boolean {
  if (OPENCODE === null) return false
  const r = Bun.spawnSync([OPENCODE, '--version'], { env: { PATH: narrowPath(), HOME: join(paths.home(), 'version-probe'), XDG_DATA_HOME: join(paths.home(), 'version-probe', 'data'), XDG_CONFIG_HOME: join(paths.home(), 'version-probe', 'config'), XDG_STATE_HOME: join(paths.home(), 'version-probe', 'state'), XDG_CACHE_HOME: join(paths.home(), 'version-probe', 'cache') } })
  const v = parseVersion(r.stdout.toString())
  return v !== undefined && Number(v.split('.')[0]) >= 2
}

const available = process.env['BURACLE_SKIP_SMOKE'] !== '1' && versionOk()

async function newSession(server: Server, project: string): Promise<string> {
  const created = await api(server, 'POST', '/api/session', project, { location: { directory: project } })
  const sid: string = created?.data?.id ?? created?.id
  expect(sid).toMatch(/^ses/)
  return sid
}

function primary(body: Record<string, unknown> | undefined): boolean {
  return Array.isArray(body?.['tools']) && (body['tools'] as unknown[]).length > 0
}

async function requestWith(provider: FakeProvider, test: (lastUser: string) => boolean): Promise<Record<string, unknown>> {
  const hit = () => provider.requests.find(r => primary(r.body) && test(lastUserText(r.body)))
  await until(() => hit() !== undefined, 30_000)
  return hit()?.body ?? {}
}

async function launch(root: string, home: string, buracleHome: string, rules: ToolRule[]) {
  const stubBin = join(root, 'stub-bin')
  mkdirSync(stubBin, { recursive: true })
  for (const name of ['npx', 'uvx']) {
    writeFileSync(join(stubBin, name), '#!/bin/sh\nexit 1\n')
    chmodSync(join(stubBin, name), 0o755)
  }
  const shimLog = join(root, 'shim-calls.log')
  mkdirSync(dirname(paths.shimPath()), { recursive: true })
  writeFileSync(paths.shimPath(), `#!/bin/sh\necho "$@" >> "${shimLog}"\nexit 0\n`)
  chmodSync(paths.shimPath(), 0o755)
  mkdirSync(join(home, 'Documents', 'Buracle'), { recursive: true })
  mkdirSync(join(root, 'tmp'), { recursive: true })
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  mkdirSync(join(paths.agentsDir(), 'skills'), { recursive: true })
  for (const id of ['plan-build', 'research']) symlinkSync(join(REPO, 'harness', 'agents-skills', id), join(paths.agentsDir(), 'skills', id))

  const res = await applyPlans([await installPlan(adapterContext(), { opencode: null })])
  expect(res.conflicts).toEqual([])
  const provider = startFakeProvider(rules)
  const cfgFile = join(paths.opencodeConfigDir(), 'opencode.jsonc')
  let cfgText = jsoncSet(readFileSync(cfgFile, 'utf8'), ['mcp', 'servers', 'grep', 'disabled'], true)
  cfgText = jsoncSet(cfgText, ['providers', 'anthropic', 'settings'], { baseURL: provider.baseURL, apiKey: 'fake-key' })
  cfgText = jsoncSet(cfgText, ['model'], `anthropic/${MODEL}`)
  writeFileSync(cfgFile, cfgText)

  const server = await startServer(isolatedEnv(root, home, buracleHome, stubBin), project)
  let plugins: any[] = []
  try {
    for (let i = 0; i < 120 && !plugins.some(p => p.id === 'buracle'); i++) {
      plugins = (await api(server, 'GET', '/api/plugin', project)).data
      if (!plugins.some(p => p.id === 'buracle')) await Bun.sleep(250)
    }
  } catch (e) {
    await stop(server)
    provider.stop()
    throw e
  }
  return { project, provider, server, shimLog, plugins }
}

interface LspRun { provider: FakeProvider; project: string; prompt: (text: string, tool: string, done: () => boolean) => Promise<void> }

async function withLspServer({ root, home, buracleHome }: { root: string, home: string, buracleHome: string }, mainGo: string, rules: ToolRule[], fn: (run: LspRun) => Promise<void>): Promise<void> {
  const stubBin = join(root, 'stub-bin')
  mkdirSync(stubBin, { recursive: true })
  for (const name of ['npx', 'uvx']) {
    writeFileSync(join(stubBin, name), '#!/bin/sh\nexit 1\n')
    chmodSync(join(stubBin, name), 0o755)
  }
  writeFileSync(join(stubBin, 'gopls'), `#!/bin/sh\nexec '${process.execPath}' '${join(REPO, 'tests', 'fixtures', 'lsp', 'stub-lsp.ts')}' push\n`, { mode: 0o755 })
  mkdirSync(dirname(paths.shimPath()), { recursive: true })
  writeFileSync(paths.shimPath(), `#!/bin/sh\nif [ "$1 $2" = "lsp mcp" ]; then exec '${process.execPath}' '${join(REPO, 'src', 'cli', 'main.ts')}' lsp mcp; fi\nexit 0\n`)
  chmodSync(paths.shimPath(), 0o755)
  mkdirSync(join(root, 'tmp'), { recursive: true })
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'go.mod'), 'module demo\n')
  writeFileSync(join(project, 'main.go'), mainGo)
  expect((await applyPlans([await installPlan(adapterContext(), { opencode: null })])).conflicts).toEqual([])
  const provider = startFakeProvider(rules)
  const cfgFile = join(paths.opencodeConfigDir(), 'opencode.jsonc')
  let cfgText = jsoncSet(readFileSync(cfgFile, 'utf8'), ['mcp', 'servers', 'grep', 'disabled'], true)
  cfgText = jsoncSet(cfgText, ['providers', 'anthropic', 'settings'], { baseURL: provider.baseURL, apiKey: '[REDACTED:secret]' })
  cfgText = jsoncSet(cfgText, ['model'], `anthropic/${MODEL}`)
  writeFileSync(cfgFile, cfgText)
  const server = await startServer(isolatedEnv(root, home, buracleHome, stubBin), project)
  let mcp: unknown
  try {
    for (let i = 0; i < 120; i++) {
      mcp = await api(server, 'GET', '/api/mcp', project)
      if (/"lsp"[^}]*connected/.test(JSON.stringify(mcp))) break
      await Bun.sleep(250)
    }
    expect(JSON.stringify(mcp)).toMatch(/"lsp"[^}]*connected/)
    const prompt = async (text: string, tool: string, done: () => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 5 && !done(); attempt++) {
        const before = provider.requests.length
        const sid = await newSession(server, project)
        await api(server, 'POST', `/api/session/${sid}/prompt`, project, { text })
        const withoutTool = () => provider.requests.slice(before).some(r => primary(r.body) && !offeredTools(r.body).includes(tool))
        await until(() => done() || withoutTool(), 60_000)
        if (!done()) await Bun.sleep(1000)
      }
      expect(done()).toBe(true)
    }
    await fn({ provider, project, prompt })
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- /api/mcp ---\n${JSON.stringify(mcp).slice(0, 2000)}\n--- opencode output ---\n${server.log().slice(-4000)}\n--- requests ---\n${provider.requests.map(r => `${r.path} [${offeredTools(r.body).filter(n => n.startsWith('lsp_') || n === 'write').join(',')}] ${JSON.stringify(r.body?.['messages'] ?? []).slice(-600)}`).join('\n')}`)
  } finally {
    await stop(server)
    provider.stop()
  }
}

describe('opencode smoke (real binary, isolated)', () => {
  (available ? test : test.skip)('the generated config parses; the plugin loads, reacts to session events, runs the workflow commands, attaches skills, sets the effort and re-prompts once for H23', () => withSandbox(async ({ root, home, buracleHome }) => {
    const review = { agent: 'plan-build-review', description: 'review the plan', prompt: 'Review docs/plans/x.md and return your report.' }
    const { project, provider, server, shimLog, plugins } = await launch(root, home, buracleHome, [
      { when: t => t.includes(REVIEW_MARK), name: 'subagent', input: review },
      { when: t => t.includes(BUSY_MARK), name: 'subagent', input: review, delayMs: 2500 },
    ])
    try {
      const ours = plugins.find(p => p.id === 'buracle')
      expect(ours).toMatchObject({ source: { type: 'local' }, features: { server: true, tui: true }, state: { status: 'active' } })
      expect(ours.source.path).toBe(join(paths.opencodeConfigDir(), 'plugins', 'buracle', 'index.js'))

      const agents = (await api(server, 'GET', '/api/agent', project)).data as any[]
      for (const a of canonical().agents) {
        const agent = agents.find(x => x.id === a.id)
        expect(agent?.mode).toBe('subagent')
        expect(agent?.permissions).toContainEqual({ action: 'edit', resource: '*', effect: 'deny' })
        expect(agent?.permissions).toContainEqual({ action: 'edit', resource: '*.env', effect: 'deny' })
      }
      const build = agents.find(x => x.id === 'build')
      expect(build?.permissions).toContainEqual({ action: 'shell', resource: 'rm -rf /', effect: 'deny' })

      const commands = ((await api(server, 'GET', '/api/command', project)).data as any[]).map(c => c.name)
      for (const s of catalogSkills(canonical().skills)) {
        if (s.userInvocable) expect(commands).toContain(s.id)
        else expect(commands).not.toContain(s.id)
      }

      const body = await api(server, 'GET', '/api/config', project)
      const entries = (Array.isArray(body) ? body : body?.data) as any[]
      const doc = entries.find(e => e.type === 'document' && e.path === join(paths.opencodeConfigDir(), 'opencode.jsonc'))
      expect(doc?.info?.share).toBe('disabled')
      expect(doc?.info?.mcp?.servers?.context7?.codemode).toBe(false)
      expect(doc?.info?.mcp?.servers?.['buracle-memory']?.command?.[0]).toBe(paths.shimPath())
      expect(doc?.info?.mcp?.servers?.grep).toMatchObject({ type: 'remote', url: 'https://mcp.grep.app', oauth: false, disabled: true })

      const s1 = await newSession(server, project)
      await api(server, 'POST', `/api/session/${s1}/command`, project, { name: 'plan-build', text: 'add a health check endpoint' })
      expect(readFlow('opencode', s1)?.stack[0]).toMatchObject({ workflow: 'plan-build', source: 'command', title: 'add a health check endpoint' })
      const specReq = await requestWith(provider, t => t.includes('add a health check endpoint'))
      const specText = lastUserText(specReq)
      expect(specText).toContain('<skill_content name="plan-build">')
      expect(specText).toContain('Run this with the Buracle plan-build workflow')
      expect(specReq['output_config']).toEqual({ effort: 'xhigh' })
      await until(() => latestWindows('opencode', Date.now()).length === 2, 15_000)
      expect(latestWindows('opencode', Date.now()).map(w => `${w.label} ${w.pct}`)).toEqual(['5h 42', '7d 18'])

      const s2 = await newSession(server, project)
      await api(server, 'POST', `/api/session/${s2}/prompt`, project, { text: 'use the research skill to compare bun and node for scripts' })
      const askReq = await requestWith(provider, t => t.includes('compare bun and node for scripts'))
      expect(lastUserText(askReq)).toContain('<skill_content name="research">')
      expect(systemTexts(askReq).join('\n')).toContain('Buracle routing for this prompt:')
      expect(readFlow('opencode', s2)?.stack[0]).toMatchObject({ workflow: 'research', source: 'prompt' })

      const s3 = await newSession(server, project)
      await api(server, 'POST', `/api/session/${s3}/prompt`, project, { text: 'what did we decide last time about the cache?' })
      const auditReq = await requestWith(provider, t => t.includes('Buracle routing check:'))
      expect(lastUserText(auditReq)).toContain('memory was not searched')
      await Bun.sleep(4000)
      expect(provider.requests.filter(r => primary(r.body) && lastUserText(r.body).includes('Buracle routing check:')).length).toBe(1)

      const s4 = await newSession(server, project)
      await api(server, 'POST', `/api/session/${s4}/prompt`, project, { text: `${REVIEW_MARK} please` })
      await until(() => provider.requests.some(r => primary(r.body) && JSON.stringify(r.body?.['messages'] ?? []).includes('Buracle H19 (review.gate): the plan-build-review report is not valid review JSON')), 30_000)

      const s5 = await newSession(server, project)
      await api(server, 'POST', `/api/session/${s5}/prompt`, project, { text: `${BUSY_MARK} please start` })
      await requestWith(provider, t => t.includes(BUSY_MARK))
      await api(server, 'POST', `/api/session/${s5}/prompt`, project, { text: `use the research skill to compare bun and deno ${QUEUED_MARK}`, delivery: 'queue' })
      const queuedReq = await requestWith(provider, t => t.includes(QUEUED_MARK))
      expect(lastUserText(queuedReq)).toContain('<skill_content name="research">')
      expect(systemTexts(queuedReq).join('\n')).toContain('The user asked for the research skill: its skill is attached to this message')
      const busyStep = provider.requests.findIndex(r => primary(r.body) && endsWithToolResult(r.body) && JSON.stringify(r.body?.['messages'] ?? []).includes(BUSY_MARK))
      expect(busyStep).toBeGreaterThanOrEqual(0)
      expect(busyStep).toBeLessThan(provider.requests.findIndex(r => r.body === queuedReq))
      expect(JSON.stringify(provider.requests[busyStep]?.body?.['messages'] ?? [])).not.toContain(QUEUED_MARK)
      expect(systemTexts(provider.requests[busyStep]?.body).join('\n')).not.toContain('research skill')

      const sid = await newSession(server, project)
      const record = join(buracleHome, 'state', 'memory', 'sessions', `opencode-${sid}.json`)
      await until(() => existsSync(record), 15_000)
      await api(server, 'DELETE', `/api/session/${sid}`, project)
      await until(() => existsSync(shimLog) && readFileSync(shimLog, 'utf8').includes(`mem finalize --harness opencode --session ${sid}`), 15_000)
    } catch (e) {
      throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- opencode output ---\n${server.log().slice(-4000)}\n--- requests ---\n${provider.requests.map(r => `${r.path} ${lastUserText(r.body).slice(0, 160)}`).join('\n')}`)
    } finally {
      await stop(server)
      provider.stop()
    }
  }), 180_000)

  test.skipIf(!available)('H20 without a TUI (opencode serve): the denial names the question tool; "Allow once" in the question form records the grant and the retried push runs', () => withSandbox(async ({ root, home, buracleHome }) => {
    const question = 'Buracle consent: `git push origin main` pushes to a remote. Run it?'
    const push = { command: 'git push origin main', description: 'Push the branch' }
    const { project, provider, server } = await launch(root, home, buracleHome, [
      { when: t => t.includes('PUSH_FIRST'), name: 'shell', input: push, then: { name: 'question', input: { questions: [{ question, header: 'Consent', options: CONSENT_OPTIONS.map(label => ({ label, description: label })) }] } } },
      { when: t => t.includes('PUSH_AGAIN'), name: 'shell', input: push },
    ])
    const resultAfter = async (from: number): Promise<string> => {
      const hit = () => provider.requests.slice(from).find(r => primary(r.body) && endsWithToolResult(r.body))
      await until(() => hit() !== undefined, 30_000)
      return JSON.stringify((hit()?.body?.['messages'] as unknown[]).slice(-1))
    }
    const prompt = async (sid: string, text: string): Promise<number> => {
      const from = provider.requests.length
      await api(server, 'POST', `/api/session/${sid}/prompt`, project, { text, delivery: 'queue' })
      return from
    }
    try {
      const sid = await newSession(server, project)
      const denied = await resultAfter(await prompt(sid, 'PUSH_FIRST please'))
      expect(denied).toContain('Buracle H20 consent.gate')
      expect(denied).toContain('call the `question` tool')
      let forms: any[] = []
      for (let i = 0; i < 120 && forms.length === 0; i++) {
        const listed = await api(server, 'GET', `/api/session/${sid}/form`, project)
        forms = (Array.isArray(listed) ? listed : listed?.data) ?? []
        if (forms.length === 0) await Bun.sleep(250)
      }
      expect(forms.length).toBe(1)
      await api(server, 'POST', `/api/session/${sid}/form/${forms[0].id}/reply`, project, { answer: { q0: 'Allow once' } })
      await until(() => JSON.stringify(provider.requests.at(-1)?.body?.['messages'] ?? []).includes('User has answered your questions'), 30_000)
      await until(() => readConsentState('opencode', sid).grants.length > 0, 15_000)
      expect(readConsentState('opencode', sid).grants.map(g => [g.kind, g.source])).toEqual([['push', 'ask']])
      const ran = await resultAfter(await prompt(sid, 'PUSH_AGAIN please'))
      expect(ran).not.toContain('Buracle H20')
      expect(ran.toLowerCase()).toContain('not a git repository')
    } catch (e) {
      throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- opencode output ---\n${server.log().slice(-4000)}\n--- requests ---\n${provider.requests.map(r => `${r.path} ${lastUserText(r.body).slice(0, 160)} ${JSON.stringify((r.body?.['messages'] as unknown[] | undefined)?.slice(-1) ?? []).slice(0, 400)}`).join('\n')}`)
    } finally {
      await stop(server)
      provider.stop()
    }
  }), 180_000)

  test.skipIf(!available)('PARITY-6: OpenCode starts `buracle lsp mcp` from opencode.jsonc in the project folder, and lsp_diagnostics answers from the language server', () => withSandbox(async sb => {
    await withLspServer(sb, 'package main\nvar x = 1 // ERROR: declared and not used: x\n', [{ when: t => t.includes('LSP_CHECK'), name: 'lsp_diagnostics', input: { file: 'main.go' }, offered: true }], async ({ provider, prompt }) => {
      const answered = () => provider.requests.find(r => endsWithToolResult(r.body) && JSON.stringify(r.body?.['messages'] ?? []).includes('main.go (gopls)'))
      await prompt('LSP_CHECK main.go please', 'lsp_diagnostics', () => answered() !== undefined)
      const seen = JSON.stringify(answered()?.body?.['messages'] ?? [])
      expect(seen).toContain('main.go (gopls): 1 error')
      expect(seen).toContain('2:14  error E1  declared and not used: x [stub]')
    })
  }), 360_000)

  test.skipIf(!available)('PARITY-6: after an edit, the plugin asks the running `buracle lsp mcp` bridge and the tool result carries the language server\'s diagnostics of the edited file', () => withSandbox(async sb => {
    const content = 'package main\nvar y = 2 // ERROR: declared and not used: y\n'
    await withLspServer(sb, 'package main\n', [{ when: t => t.includes('LSP_EDIT'), name: 'write', input: { path: 'main.go', content }, offered: true }], async ({ provider, project, prompt }) => {
      const answered = () => provider.requests.find(r => endsWithToolResult(r.body) && JSON.stringify(r.body?.['messages'] ?? []).includes('Buracle language server diagnostics (H04)'))
      await prompt('LSP_EDIT write main.go', 'write', () => answered() !== undefined)
      expect(readFileSync(join(project, 'main.go'), 'utf8')).toBe(content)
      const seen = JSON.stringify(answered()?.body?.['messages'] ?? [])
      expect(seen).toContain('main.go (gopls): 1 error')
      expect(seen).toContain('2:14  error E1  declared and not used: y [stub]')
    })
  }), 360_000)

  test.skipIf(!available)('H12: this OpenCode\'s plan agent is "plan", it leaves Plan mode only on an agent switch, and the texts the draft reads are its events', () => {
    const bin = readFileSync(realpathSync(OPENCODE as string))
    for (const text of [`.make("${OPENCODE_PLAN_AGENT}")`, 'id:"opencode.plan"', 'You remain in Plan mode until the user switches agents.', 'You are NO LONGER in Plan mode.', 'type:"session.agent.selected"', 'session.text.ended']) {
      expect({ text, found: bin.includes(Buffer.from(text, 'utf8')) }).toEqual({ text, found: true })
    }
  }, 60_000)

  test.skipIf(!available)('host limits: every recorded OpenCode limit still holds on this binary, and every probe still finds what it reads', () => {
    const text = readFileSync(realpathSync(OPENCODE as string)).toString('latin1')
    for (const limit of hostLimitsOf('opencode')) {
      if (limit.probe === undefined) continue
      expect({ id: limit.id, probeMisses: probeMisses(text, limit.probe) }).toEqual({ id: limit.id, probeMisses: [] })
      expect({ id: limit.id, canNowBeClosed: probeClosers(text, limit.probe) }).toEqual({ id: limit.id, canNowBeClosed: [] })
    }
  }, 60_000)
})
