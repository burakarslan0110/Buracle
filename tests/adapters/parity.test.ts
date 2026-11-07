import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { readOpenPlanSteps } from '../../src/adapters/codex/rollout'
import { OMP_BUILTIN_LSP, ompLspServers, ompMcpServerIds } from '../../src/adapters/omp/generated'
import { ompConfigKeys } from '../../src/adapters/omp/install'
import { HOST_LIMITS } from '../../src/adapters/shared/host-limits'
import { OMP_BUILTIN_COMMANDS } from '../../src/adapters/omp/runtime/commands'
import { openTodosOf } from '../../src/adapters/omp/runtime/tool-output'
import { openTodosOf as opencodeOpenTodos } from '../../src/adapters/opencode/runtime/todos'
import { renderRule as renderClaudeRule } from '../../src/adapters/claude/install'
import { CLAUDE_TODO, renderClaudeMarkdown } from '../../src/adapters/claude/render'
import { allAdapters } from '../../src/adapters/registry'
import { HARNESS_LABEL, placeholderLiteral, renderMarkdown } from '../../src/adapters/shared/render'
import { pathRuleFiles } from '../../src/adapters/shared/rules'
import { buildAgentsSkills } from '../../src/adapters/shared/skills'
import type { CanonicalBundle, HookBinding, HookSpec, HookUnsupported } from '../../src/core/catalog'
import { catalogSkills, hookFallbacks } from '../../src/core/catalog'
import type { Harness } from '../../src/core/events'
import { HARNESSES } from '../../src/core/events'
import { loadCanonicalSync } from '../../src/engine/canonical'
import { jsoncParse } from '../../src/engine/merge'
import { lspServers } from '../../src/engine/toolchain/lsp'
import * as paths from '../../src/engine/paths'
import { buildContext, inCheckout } from '../../src/engine/update/context'
import { readClaudePayload } from '../../src/usage/bar'
import { writeUsageEntries } from '../../src/usage/cache'
import { collectCodex } from '../../src/usage/codex'
import { windowsFromOmpUsage } from '../../src/usage/omp'
import { collectOpencode } from '../../src/usage/opencode'
import { monthKeyOf } from '../../src/usage/month'
import { withSandbox } from '../helpers/sandbox'
import { rateLimitHeaders } from './opencode/fake-provider'
import { FIXTURES as USAGE_FIXTURES, NOW as USAGE_NOW, installFixture as installUsageFixture } from '../usage/helpers'

const REPO = paths.repoRoot()

type Files = ReadonlyMap<string, string>
interface Built { canonical: CanonicalBundle; files: Readonly<Record<Harness, Files>>; agentsSkills: Files }

let builtOnce: Promise<Built> | undefined

function built(): Promise<Built> {
  builtOnce ??= (async () => {
    const canonical = loadCanonicalSync(join(REPO, 'canonical'))
    const ctx = buildContext(REPO, canonical)
    const files: Partial<Record<Harness, Files>> = {}
    for (const a of allAdapters()) files[a.harness] = new Map((await inCheckout(REPO, () => a.build(ctx))).map(f => [f.path, f.content]))
    const agentsSkills = new Map(buildAgentsSkills(ctx).map(f => [f.path, f.content]))
    return { canonical, files: files as Record<Harness, Files>, agentsSkills }
  })()
  return builtOnce
}

function file(files: Files, path: string): string {
  const text = files.get(path)
  if (text === undefined) throw new Error(`missing from the build: ${path}`)
  return text
}

function frontmatter(text: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  const fm = m !== null ? parseYaml(m[1] ?? '') as unknown : undefined
  return fm !== null && typeof fm === 'object' ? fm as Record<string, unknown> : {}
}

function userInvocable(c: CanonicalBundle): string[] {
  return catalogSkills(c.skills).filter(s => s.userInvocable).map(s => s.id)
}

function protocolSkills(c: CanonicalBundle): string[] {
  return catalogSkills(c.skills).filter(s => !s.userInvocable).map(s => s.id)
}

function commandFiles(files: Files): Set<string> {
  return new Set([...files.keys()].flatMap(p => /^commands\/([a-z0-9-]+)\.md$/.exec(p)?.[1] ?? []))
}

interface Registered { events: Set<string>; commands: Set<string> }

function anything(): unknown {
  const fn = (): unknown => anything()
  return new Proxy(fn, { get: (_t, p) => (p === 'then' || typeof p === 'symbol' ? undefined : anything()) })
}

async function ompRegistrations(code: string, dir: string): Promise<Registered> {
  const entry = join(dir, 'omp-buracle.js')
  writeFileSync(entry, code)
  const mod = await import(entry) as { default: (pi: unknown) => void }
  const out: Registered = { events: new Set(), commands: new Set() }
  const pi = new Proxy({}, {
    get: (_t, p) => {
      if (p === 'on') return (event: unknown) => { if (typeof event === 'string') out.events.add(event) }
      if (p === 'registerCommand') return (name: unknown) => { if (typeof name === 'string') out.commands.add(name) }
      return p === 'then' || typeof p === 'symbol' ? undefined : anything()
    },
  })
  mod.default(pi)
  return out
}

async function openCodeServerRegistrations(code: string, dir: string): Promise<Registered & { handles(event: string): boolean }> {
  const entry = join(dir, 'opencode-index.js')
  writeFileSync(entry, code)
  const mod = await import(entry) as { default: { id: string, setup: (ctx: unknown) => Promise<unknown> } }
  const out: Registered = { events: new Set(), commands: new Set() }
  const registration = { dispose: async () => undefined }
  const done = async () => ({ done: true as const, value: undefined })
  const empty = { [Symbol.asyncIterator]: () => ({ next: done, return: done }) }
  const domain = (name: string): unknown => new Proxy({}, {
    get: (_t, p) => {
      if (typeof p !== 'string' || p === 'then') return undefined
      if (p === 'hook') return async (hook: unknown) => { if (typeof hook === 'string') out.events.add(`${name}.${hook}`); return registration }
      if (p === 'transform') {
        return async (edit: (editor: unknown) => void) => {
          if (name === 'command') edit({ add: (def: { name?: unknown }) => { if (typeof def?.name === 'string') out.commands.add(def.name) } })
          return registration
        }
      }
      if (p === 'subscribe') return () => empty
      if (p === 'list') return async () => []
      return async () => undefined
    },
  })
  const fixed: Record<string, unknown> = {
    app: { name: 'cli', version: '2.0.24', channel: 'latest' },
    location: { directory: dir, project: { id: 'p1', directory: dir, canonical: dir } },
    options: {},
  }
  const ctx = new Proxy(fixed, { get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : p in t ? t[p] : domain(p)) })
  expect(mod.default.id).toBe('buracle')
  const cleanup = await mod.default.setup(ctx)
  if (typeof cleanup === 'function') await (cleanup as () => Promise<void>)()
  return { ...out, handles: (event: string) => out.events.has(event) || dispatchesOn(code, event) }
}

function dispatchesOn(code: string, event: string): boolean {
  const q = JSON.stringify(event).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${q}\\s*:|===\\s*${q}|${q}\\s*===`).test(code)
}

const TUI_HOST = `
import { plugin } from 'bun'
import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
const bundle = process.argv[2]
const known = {
  'solid-js': {
    createSignal: (v) => { let x = v; return [() => x, (n) => { x = typeof n === 'function' ? n(x) : n }] },
    createMemo: (fn) => () => fn(), createEffect: () => {}, createRoot: (fn) => fn(() => {}),
    onCleanup: () => {}, onMount: () => {}, untrack: (fn) => fn(), batch: (fn) => fn(),
  },
  '@opentui/solid': { useTerminalDimensions: () => () => ({ width: 160, height: 40 }), useKeyboard: () => {}, useRenderer: () => ({}) },
  '@opentui/solid/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' },
}
const builtin = new Set(builtinModules)
const code = readFileSync(bundle, 'utf8')
const wanted = new Map()
for (const m of code.matchAll(/^import\\s+(?:\\*\\s+as\\s+\\w+|\\{([^}]*)\\}|\\w+)\\s+from\\s+"([^"]+)";$/gm)) {
  const spec = m[2]
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec.startsWith('bun') || builtin.has(spec)) continue
  const names = wanted.get(spec) ?? new Set()
  for (const n of (m[1] ?? '').split(',')) { const name = n.trim().split(/\\s+as\\s+/)[0]; if (name) names.add(name) }
  wanted.set(spec, names)
}
plugin({
  name: 'parity-tui-host',
  setup(build) {
    for (const [spec, names] of wanted) {
      const exports = { ...(known[spec] ?? {}) }
      for (const n of names) if (!(n in exports)) exports[n] = () => undefined
      build.module(spec, () => ({ loader: 'object', exports }))
    }
  },
})
const slots = []
const slash = []
const record = (layer) => {
  for (const c of (layer && layer.commands) || []) {
    if (c && c.slash && typeof c.slash.name === 'string') { slash.push(c.slash.name); for (const a of c.slash.aliases || []) slash.push(a) }
  }
}
const color = (name) => ({ name })
const dir = process.cwd()
const anything = () => new Proxy(() => anything(), { get: (_t, p) => (p === 'then' || typeof p === 'symbol' ? undefined : anything()) })
const tolerant = (o) => new Proxy(o, {
  get: (t, p) => {
    if (typeof p === 'symbol' || p === 'then') return t[p]
    if (!(p in t)) return anything()
    const v = t[p]
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? tolerant(v) : v
  },
})
const base = {
  app: { version: '2.0.24' },
  location: { directory: dir },
  theme: {
    text: { base: color('base'), muted: color('muted'), feedback: { error: { base: color('red') }, warning: { base: color('yellow') }, success: { base: color('green') }, info: { base: color('blue') } } },
    hue: { accent: { 500: color('magenta') }, interactive: { 500: color('cyan') }, neutral: { 500: color('gray') } },
  },
  data: {
    session: { get: () => undefined, cost: () => 0, message: { list: () => [] } },
    location: { model: { list: () => [] }, command: { list: () => [], sync: async () => {} } },
    listen: () => () => {},
    on: () => () => {},
  },
  keymap: { layer: (x) => { record(typeof x === 'function' ? x() : x); return () => {} }, commands: () => [] },
  ui: {
    slot: (claim) => { for (const k of ['append', 'prepend', 'before', 'after', 'replace']) if (typeof claim[k] === 'string') slots.push(claim[k]); return () => {} },
    model: { current: () => undefined },
    toast: { show: () => {} },
    dialog: { alert: async () => {} },
    router: { current: () => ({ type: 'home' }) },
  },
  client: { rpc: () => ({}) },
}
const ctx = tolerant(base)
const mod = await import(bundle)
const cleanup = await mod.default.setup(ctx)
if (typeof cleanup === 'function') await cleanup()
process.stdout.write(JSON.stringify({ id: mod.default.id, slots, slash }) + '\\n')
process.exit(0)
`

async function openCodeTuiRegistrations(code: string, dir: string): Promise<{ slash: Set<string>, slots: string[] }> {
  const host = join(dir, 'parity-tui-host.ts')
  const entry = join(dir, 'opencode-tui.js')
  writeFileSync(host, TUI_HOST)
  writeFileSync(entry, code)
  writeUsageEntries([{ harness: 'opencode', computed_at: new Date().toISOString(), windows: [], month: { start: new Date().toISOString(), tokens: 0, byModel: {} }, month_key: monthKeyOf(Date.now()) }], Date.now())
  const proc = Bun.spawn([process.execPath, host, entry], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env } })
  const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  expect({ exit, err }).toEqual({ exit: 0, err: '' })
  const r = JSON.parse(out) as { id: string, slots: string[], slash: string[] }
  expect(r.id).toBe('buracle')
  return { slash: new Set(r.slash), slots: r.slots }
}

interface Surfaces {
  built: Built
  omp: Registered
  openCodeServer: Registered & { handles(event: string): boolean }
  openCodeTui: { slash: Set<string>, slots: string[] }
}

let surfacesOnce: Promise<Surfaces> | undefined

function surfaces(): Promise<Surfaces> {
  surfacesOnce ??= withSandbox(async ({ root }) => {
    const b = await built()
    const omp = await ompRegistrations(file(b.files.omp, 'extensions/buracle.js'), root)
    const openCodeServer = await openCodeServerRegistrations(file(b.files.opencode, 'plugins/buracle/index.js'), root)
    const openCodeTui = await openCodeTuiRegistrations(file(b.files.opencode, 'plugins/buracle/tui.js'), root)
    return { built: b, omp, openCodeServer, openCodeTui }
  })
  return surfacesOnce
}

function claudeModCommands(register: string): Set<string> {
  const names = new Set([...register.matchAll(/\{\s*name:\s*'([a-z0-9-]+)',\s*description:/g)].map(m => m[1] as string))
  if (/name:\s*`buracle-\$\{spec\.name\}`/.test(register)) for (const n of [...names]) if (!n.startsWith('buracle-')) names.add(`buracle-${n}`)
  return names
}

function claudeModEvents(register: string): Set<string> {
  return new Set([...register.matchAll(/\bon\('([a-z]+(?:\.[a-zA-Z]+)+)'/g)].map(m => m[1] as string))
}

describe('parity: every user-invocable skill is a workflow on every harness', () => {
  test('the catalog: ten workflows, and the protocol skills memory and buracle are not user-invocable (PLAN §2.2)', async () => {
    const { canonical } = await built()
    expect(protocolSkills(canonical)).toEqual(['buracle', 'memory'])
    const workflows = ['plan-build', 'goal-build', 'bugfix', 'requirements', 'research', 'inspect', 'dead-code', 'project-rules', 'new-skill', 'ab-test']
    expect(workflows.filter(id => !userInvocable(canonical).includes(id))).toEqual([])
  })

  test('claude: a plugin skill per workflow (/buracle:<id>, bare /<id> by its name); protocol skills stay off the slash menu', async () => {
    const { canonical, files } = await built()
    const skill = (id: string) => {
      const fm = frontmatter(files.claude.get(`skills/${id}/SKILL.md`) ?? '')
      return { id, name: fm['name'], hidden: fm['user-invocable'] === false }
    }
    expect(userInvocable(canonical).map(skill)).toEqual(userInvocable(canonical).map(id => ({ id, name: id, hidden: false })))
    expect(protocolSkills(canonical).map(skill)).toEqual(protocolSkills(canonical).map(id => ({ id, name: id, hidden: true })))
  })

  test('codex: $<id> for every workflow from the shared neutral render', async () => {
    const { canonical, agentsSkills } = await built()
    const skill = (id: string) => ({ id, name: frontmatter(agentsSkills.get(`${id}/SKILL.md`) ?? '')['name'], openaiYaml: agentsSkills.has(`${id}/agents/openai.yaml`) })
    expect(userInvocable(canonical).map(skill)).toEqual(userInvocable(canonical).map(id => ({ id, name: id, openaiYaml: true })))
  })

  test('opencode: a /<id> command for every workflow (command file or plugin command), none for the protocol skills', async () => {
    const s = await surfaces()
    const workflowEntries = new Set([...commandFiles(s.built.files.opencode), ...s.openCodeServer.commands])
    const entries = new Set([...workflowEntries, ...s.openCodeTui.slash])
    expect(userInvocable(s.built.canonical).filter(id => !entries.has(id))).toEqual([])
    expect(protocolSkills(s.built.canonical).filter(id => workflowEntries.has(id))).toEqual([])
  }, 60_000)

  test('omp: a /<id> command for every workflow (command file or extension command), none for the protocol skills', async () => {
    const s = await surfaces()
    const entries = new Set([...commandFiles(s.built.files.omp), ...s.omp.commands])
    expect(userInvocable(s.built.canonical).filter(id => !entries.has(id))).toEqual([])
    expect(protocolSkills(s.built.canonical).filter(id => commandFiles(s.built.files.omp).has(id))).toEqual([])
  }, 60_000)
})

const UTILITY_COMMANDS: ReadonlyArray<{ name: string, on: readonly Harness[], codex?: RegExp }> = [
  { name: 'remember', on: ['claude', 'opencode', 'omp'], codex: /buracle mem remember/ },
  { name: 'brain', on: ['claude', 'opencode', 'omp'], codex: /buracle mem ui/ },
  { name: 'buracle-status', on: ['claude', 'opencode', 'omp'], codex: /buracle (?:mem|plan|flow) status/ },
  { name: 'buracle', on: ['opencode', 'omp'] },
  { name: 'aside', on: ['claude', 'opencode', 'omp'], codex: /\/side\b/ },
  { name: 'buracle-ping', on: ['claude', 'opencode', 'omp'] },
]

function missingUtilityCommands(h: Harness, registered: ReadonlySet<string>): string[] {
  return UTILITY_COMMANDS.filter(c => c.on.includes(h) && !registered.has(c.name)).map(c => c.name)
}

describe('parity: the utility commands (PLAN §2.3)', () => {
  test('claude: the mod registers all five (with buracle- fallbacks)', async () => {
    const { files } = await built()
    const commands = claudeModCommands(file(files.claude, 'hooks/register.tsx'))
    expect(missingUtilityCommands('claude', commands)).toEqual([])
    expect(['buracle-remember', 'buracle-brain', 'buracle-aside'].filter(n => !commands.has(n))).toEqual([])
  })

  test('opencode: /remember, /brain and /buracle-status without a model turn (TUI or server commands)', async () => {
    const s = await surfaces()
    expect(missingUtilityCommands('opencode', new Set([...s.openCodeServer.commands, ...s.openCodeTui.slash]))).toEqual([])
  }, 60_000)

  test('omp: /remember, /brain, /buracle-status and the /buracle alias are extension commands', async () => {
    const s = await surfaces()
    expect(missingUtilityCommands('omp', s.omp.commands)).toEqual([])
    expect(s.omp.commands.has('buracle')).toBe(true)
  }, 60_000)

  test('codex cannot register commands: its AGENTS block names the equivalents ($memory, the CLI twins, native /side)', async () => {
    const { files } = await built()
    const agents = file(files.codex, 'AGENTS.md')
    const undocumented = UTILITY_COMMANDS.filter(c => c.codex !== undefined && !c.codex.test(agents)).map(c => c.name)
    expect({ undocumented, memorySkill: agents.includes('$memory'), reviewPage: agents.includes('buracle mem ui --open --page review') }).toEqual({ undocumented: [], memorySkill: true, reviewPage: true })
  })
})

function mcpServers(h: Harness, files: Files): string[] {
  switch (h) {
    case 'claude':
    case 'omp': {
      const servers = (JSON.parse(file(files, '.mcp.json')) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {}
      return Object.keys(servers).sort()
    }
    case 'codex': {
      const toml = Bun.TOML.parse(file(files, 'config.fragment.toml')) as { mcp_servers?: Record<string, unknown> }
      return Object.keys(toml.mcp_servers ?? {}).sort()
    }
    case 'opencode': {
      const r = jsoncParse(file(files, 'config/opencode.fragment.jsonc'))
      const value = (r.ok ? r.value : {}) as { mcp?: { servers?: Record<string, unknown> } }
      return Object.keys(value.mcp?.servers ?? {}).sort()
    }
  }
}

describe('parity: language servers (PARITY-6)', () => {
  test('all six of Buracle\'s language servers reach every harness: .lsp.json on Claude Code, the lsp MCP bridge on Codex and OpenCode, omp\'s built-in LSP plus csharp-ls in its lsp.json', async () => {
    const { canonical, files } = await built()
    const ids = JSON.stringify(canonical.tools.tools.flatMap(t => (t.lsp !== undefined ? [t.lsp.id] : [])).sort())
    const bridged = JSON.stringify(lspServers(canonical.tools).map(s => s.id).sort()) === ids
    const codex = (Bun.TOML.parse(file(files.codex, 'config.fragment.toml')) as { mcp_servers?: Record<string, { args?: string[] }> }).mcp_servers?.['lsp']
    const oc = jsoncParse(file(files.opencode, 'config/opencode.fragment.jsonc'))
    const ocCommand = ((oc.ok ? oc.value : {}) as { mcp?: { servers?: Record<string, { command?: string[] }> } }).mcp?.servers?.['lsp']?.command ?? []
    const reach: Record<Harness, boolean> = {
      claude: JSON.stringify(Object.keys(JSON.parse(file(files.claude, '.lsp.json')) as Record<string, unknown>).sort()) === ids,
      codex: bridged && JSON.stringify(codex?.args) === JSON.stringify(['lsp', 'mcp']),
      opencode: bridged && JSON.stringify(ocCommand.slice(1)) === JSON.stringify(['lsp', 'mcp']),
      omp: JSON.stringify([...OMP_BUILTIN_LSP, ...Object.keys(ompLspServers(canonical))].sort()) === ids,
    }
    expect(JSON.parse(ids)).toHaveLength(6)
    expect(reach).toEqual(FEATURES.languageServers)
    for (const h of ['claude', 'omp'] as const) expect(mcpServers(h, files[h])).not.toContain('lsp')
  })

  test('diagnostics after an edit by themselves on every harness: Claude Code natively, omp with lsp.diagnosticsOnEdit, Codex and OpenCode through H04 asking the running lsp bridge', async () => {
    const { canonical, files } = await built()
    const serves = sources('src/engine/toolchain').includes('serveEditRequests((file, waitMs) => bridge.afterEdit(file, waitMs)')
    const codexPost = (JSON.parse(file(files.codex, 'hooks.json')) as { hooks: Record<string, Array<{ matcher?: string }>> }).hooks['PostToolUse'] ?? []
    const has: Record<Harness, boolean> = {
      claude: files.claude.has('.lsp.json'),
      codex: serves && codexPost.some(g => g.matcher === 'apply_patch') && /editDiagnostics\(files, opts\)/.test(sources('src/adapters/codex')),
      opencode: serves && /lspEditNotes\(cls\.paths/.test(sources('src/adapters/opencode/runtime')) && sources('src/adapters/opencode/runtime').includes('?? editDiagnostics'),
      omp: ompConfigKeys({ canonical })['lsp.diagnosticsOnEdit'] === true,
    }
    expect(has).toEqual(FEATURES.lspDiagnosticsOnEdit)
  })
})

describe('parity: MCP servers', () => {
  test('each harness gets exactly the servers canonical/mcp.yaml assigns to it', async () => {
    const { canonical, files } = await built()
    const all = Object.keys(canonical.mcp.servers).sort()
    for (const h of HARNESSES) {
      const want = all.filter(id => canonical.mcp.servers[id]?.harnesses.includes(h))
      expect({ h, servers: mcpServers(h, files[h]) }).toEqual({ h, servers: want })
    }
    const sets = HARNESSES.map(h => mcpServers(h, files[h]))
    const common = all.filter(id => sets.every(s => s.includes(id)))
    expect(all.filter(id => !common.includes(id))).toEqual(all.filter(id => (canonical.mcp.servers[id]?.harnesses.length ?? 0) < HARNESSES.length))
  })
})

function isUnsupported(b: HookBinding | HookUnsupported | undefined): b is HookUnsupported {
  return b !== undefined && 'unsupported' in b
}

function bindingEvents(b: HookBinding): string[] {
  return [b.event, ...(b.also ?? []).map(a => a.event), ...hookFallbacks(b).map(f => (f.event.startsWith('classic.') ? f.event : `classic.${f.event}`))]
}

function servedBy(h: Harness, s: Surfaces): (event: string) => boolean {
  switch (h) {
    case 'claude': {
      const classic = new Set(Object.keys((JSON.parse(file(s.built.files.claude, 'hooks/hooks.json')) as { hooks?: Record<string, unknown> }).hooks ?? {}))
      const mod = claudeModEvents(file(s.built.files.claude, 'hooks/register.tsx'))
      return e => (e.startsWith('classic.') ? classic.has(e.slice('classic.'.length)) : mod.has(e))
    }
    case 'codex': {
      const events = new Set(Object.keys((JSON.parse(file(s.built.files.codex, 'hooks.json')) as { hooks?: Record<string, unknown> }).hooks ?? {}))
      return e => events.has(e)
    }
    case 'opencode': return e => e === 'setup' || s.openCodeServer.handles(e)
    case 'omp': return e => s.omp.events.has(e)
  }
}

describe('parity: every hook of canonical/hooks.yaml is served or unsupported with a reason, on every harness', () => {
  for (const h of HARNESSES) {
    test(h, async () => {
      const s = await surfaces()
      const served = servedBy(h, s)
      const problems: string[] = []
      for (const hook of s.built.canonical.hooks.hooks as HookSpec[]) {
        const b = hook.bindings[h]
        if (b === undefined) { problems.push(`${hook.id}: no binding and no unsupported reason`); continue }
        if (isUnsupported(b)) {
          if (typeof b.unsupported !== 'string' || b.unsupported.trim().length < 10) problems.push(`${hook.id}: unsupported without a reason`)
          continue
        }
        for (const e of bindingEvents(b)) if (!served(e)) problems.push(`${hook.id}: ${e} is not served by the ${h} build`)
      }
      expect(problems).toEqual([])
    }, 60_000)
  }

  test('the stand-ins really observe the plugins (a broken recorder would pass everything)', async () => {
    const s = await surfaces()
    expect(s.omp.events.has('tool_call')).toBe(true)
    expect(s.omp.commands.has('remember')).toBe(true)
    expect(s.openCodeServer.events.has('tool.execute.before')).toBe(true)
    expect(s.openCodeServer.handles('session.deleted')).toBe(true)
    expect(s.openCodeTui.slots).toContain('prompt.footer.status')
    const code = 'var EVENTS = ["a.listed", "a.cased", "a.keyed", "a.compared"];\nswitch (e.type) {\n  case "a.cased":\n}\nvar T = { "a.keyed": f };\nif (e.type === "a.compared") {}'
    expect(['a.listed', 'a.cased', 'a.keyed', 'a.compared'].map(ev => dispatchesOn(code, ev))).toEqual([false, true, true, true])
  }, 60_000)
})

const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE'

describe('parity: secrets in shell output are masked before the model reads them (guards.redact)', () => {
  test('claude: the mod masks Bash, Monitor, PowerShell, Read, Grep, Glob and MCP results', async () => {
    const register = file((await built()).files.claude, 'hooks/register.tsx')
    expect(register).toContain("on('tool.call', { tool: ['Bash', 'Monitor', 'PowerShell'] }")
    expect(register).toContain("on('tool.call', { tool: /^(?:Read|Grep|Glob|mcp__.+)$/ }")
    expect(register.match(/await masked\(\$, S, e\.tool_use_id, ran\)/g)?.length).toBe(2)
  })

  test('codex: a synchronous PostToolUse group of shell and MCP results runs the mask handler', async () => {
    const hooks = JSON.parse(file((await built()).files.codex, 'hooks.json')) as { hooks: Record<string, Array<{ matcher?: string, hooks: Array<Record<string, unknown>> }>> }
    const mask = (hooks.hooks['PostToolUse'] ?? []).find(g => / hook codex PostToolUseMask$/.test(String(g.hooks[0]?.['command'])))
    expect(mask?.matcher).toBe('^(Bash|mcp__.+)$')
    expect(mask?.hooks[0]?.['async']).toBeUndefined()
  })

  test('omp: the extension bundle rewrites a bash tool_result', () => withSandbox(async ({ root }) => {
    const entry = join(root, 'omp-mask.js')
    writeFileSync(entry, file((await built()).files.omp, 'extensions/buracle.js'))
    const mod = await import(entry) as { default: (pi: unknown) => void }
    const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>()
    const pi = new Proxy({}, {
      get: (_t, p) => {
        if (p === 'on') return (event: string, fn: (e: unknown, ctx: unknown) => unknown) => { handlers.set(event, fn) }
        return p === 'then' || typeof p === 'symbol' ? undefined : anything()
      },
    })
    mod.default(pi)
    const ctx = { cwd: root, mode: 'print', hasUI: false, ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined }, sessionManager: { getSessionId: () => 'omp-parity-1' }, agent: { kind: 'main', id: 'Main', name: 'main', depth: 0 } }
    const r = await handlers.get('tool_result')?.({ type: 'tool_result', toolCallId: 't1', toolName: 'bash', input: { command: 'cat .env' }, content: [{ type: 'text', text: `KEY=${AWS_KEY}` }], isError: false }, ctx) as { content?: unknown } | undefined
    expect(JSON.stringify(r?.content)).toContain('[REDACTED:aws]')
    expect(JSON.stringify(r)).not.toContain(AWS_KEY)
  }), 60_000)

  test('opencode: the server plugin bundle masks the result in tool.execute.after', () => withSandbox(async ({ root }) => {
    const e = { tool: 'shell', sessionID: 'ses_parity1', agent: 'build', messageID: 'm1', id: 'c1', input: { command: 'cat .env' }, status: 'completed', result: { output: { output: `KEY=${AWS_KEY}`, exit: 0 }, content: [{ type: 'text', text: `KEY=${AWS_KEY}` }] } }
    await openCodeHook(root, 'tool.execute.after', e)
    expect(JSON.stringify(e.result)).toContain('[REDACTED:aws]')
    expect(JSON.stringify(e.result)).not.toContain(AWS_KEY)
  }), 60_000)
})

const FEATURES: Readonly<Record<'consentDialog' | 'readOnlyStartNotice' | 'earlyEditNote' | 'rateWindows' | 'todoHandoff' | 'pathRules' | 'goalCommand' | 'projectRuleList' | 'claudeOnlySkillList' | 'laneGuard' | 'answerReceipt' | 'readOnlyStop' | 'backgroundWait' | 'quietStopFeedback' | 'shellWriteNudge' | 'shellReadNudge' | 'approvedPlanCapture' | 'reviewerShellReadOnly' | 'midTurnContextWarning' | 'startupNotices' | 'summaryKeepList' | 'languageServers' | 'lspDiagnosticsOnEdit' | 'turnReceipt' | 'longTurnNotice' | 'resumeHint' | 'livePanes' | 'stopVeto' | 'subagentStopHold' | 'commandsWithoutTurn' | 'liveExecMask' | 'failedMcpMask' | 'customStatusLine' | 'reviewSubject' | 'reviewRestore' | 'modelSwitchCommand' | 'nativePlanMode' | 'nativePlanApproval' | 'companionShell' | 'reviewNotesNotice' | 'browserControl', Readonly<Record<Harness, boolean>>>> = {
  approvedPlanCapture: { claude: true, codex: true, opencode: false, omp: true },
  reviewerShellReadOnly: { claude: true, codex: true, opencode: true, omp: true },
  consentDialog: { claude: true, codex: true, opencode: true, omp: true },
  readOnlyStartNotice: { claude: true, codex: true, opencode: true, omp: true },
  earlyEditNote: { claude: true, codex: true, opencode: true, omp: true },
  midTurnContextWarning: { claude: true, codex: true, opencode: true, omp: true },
  startupNotices: { claude: true, codex: true, opencode: true, omp: true },
  summaryKeepList: { claude: true, codex: true, opencode: true, omp: true },
  pathRules: { claude: true, codex: true, opencode: true, omp: true },
  rateWindows: { claude: true, codex: true, opencode: true, omp: true },
  todoHandoff: { claude: true, codex: true, opencode: true, omp: true },
  goalCommand: { claude: true, codex: true, opencode: false, omp: true },
  projectRuleList: { claude: false, codex: true, opencode: true, omp: true },
  claudeOnlySkillList: { claude: false, codex: true, opencode: false, omp: false },
  laneGuard: { claude: true, codex: true, opencode: true, omp: true },
  answerReceipt: { claude: true, codex: true, opencode: true, omp: true },
  readOnlyStop: { claude: true, codex: true, opencode: true, omp: true },
  backgroundWait: { claude: true, codex: false, opencode: true, omp: true },
  quietStopFeedback: { claude: true, codex: false, opencode: false, omp: true },
  shellWriteNudge: { claude: true, codex: true, opencode: true, omp: true },
  shellReadNudge: { claude: true, codex: false, opencode: true, omp: true },
  languageServers: { claude: true, codex: true, opencode: true, omp: true },
  lspDiagnosticsOnEdit: { claude: true, codex: true, opencode: true, omp: true },
  turnReceipt: { claude: true, codex: true, opencode: true, omp: true },
  longTurnNotice: { claude: true, codex: true, opencode: true, omp: true },
  resumeHint: { claude: true, codex: true, opencode: true, omp: true },
  livePanes: { claude: true, codex: false, opencode: true, omp: true },
  stopVeto: { claude: true, codex: true, opencode: false, omp: true },
  subagentStopHold: { claude: true, codex: true, opencode: false, omp: true },
  commandsWithoutTurn: { claude: true, codex: false, opencode: true, omp: true },
  liveExecMask: { claude: true, codex: false, opencode: true, omp: true },
  failedMcpMask: { claude: true, codex: false, opencode: true, omp: true },
  customStatusLine: { claude: true, codex: false, opencode: true, omp: true },
  reviewSubject: { claude: true, codex: true, opencode: true, omp: true },
  reviewRestore: { claude: true, codex: true, opencode: true, omp: true },
  modelSwitchCommand: { claude: true, codex: true, opencode: true, omp: true },
  nativePlanMode: { claude: true, codex: true, opencode: true, omp: true },
  nativePlanApproval: { claude: true, codex: true, opencode: false, omp: true },
  companionShell: { claude: true, codex: true, opencode: true, omp: false },
  reviewNotesNotice: { claude: true, codex: true, opencode: true, omp: true },
  browserControl: { claude: true, codex: true, opencode: true, omp: true },
}

// Host behavior the design document records for omp: it wakes the session itself when a background task ends, and a
// session_stop block continues the session quietly. Buracle's omp stop handler (src/adapters/omp/runtime/stop.ts) holds
// only the block-with-reason mechanism, so these two cells are asserted from the document, in the docs describe below.
const OMP_NATIVE = { backgroundWait: 'hasPendingAsyncWake', quietStopFeedback: 'session-stop-continuation' } as const

const HAS_DOCS = existsSync(join(REPO, 'docs', 'DESIGN.md'))

type Cells = Readonly<Record<Harness, boolean>>
type CodeCells = Readonly<Record<Exclude<Harness, 'omp'>, boolean>>

function withoutOmp(cells: Cells): CodeCells {
  return { claude: cells.claude, codex: cells.codex, opencode: cells.opencode }
}

const LIMITS: Readonly<Partial<Record<keyof typeof FEATURES, Readonly<Partial<Record<Harness, ReadonlyArray<{ doc: string, says: string }>>>>>>> = {
  consentDialog: {
    codex: [
      { doc: 'canonical/hooks.yaml', says: 'codex exec and --yolo, which run with approval_policy never, keep the denial' },
      { doc: 'docs/design/harness-adapters.md', says: '`codex exec`, `--yolo` and a session started with `-a never` keep the plain denial' },
      { doc: 'docs/design/harness-adapters.md', says: 'Codex\'s prompt approves one run: its approve-for-the-session choice remembers the exact line' },
      { doc: 'docs/USAGE.md', says: 'Codex\'s choice to approve for the whole session does not carry over to the next held command' },
    ],
    opencode: [
      { doc: 'canonical/hooks.yaml', says: 'while the OpenCode TUI shows that session' },
      { doc: 'docs/design/harness-adapters.md', says: 'Without a TUI that shows the session (the web and desktop clients, which load no TUI plugins, `opencode run`, the server API, another session in view) the denial also tells the agent to ask right away with the `question` tool' },
      { doc: 'docs/design/harness-adapters.md', says: 'where the client cannot show it (`opencode run`), the tool says so and the agent asks in its reply' },
    ],
  },
  summaryKeepList: {
    codex: [
      { doc: 'canonical/hooks.yaml', says: 'which Codex uses only when it compacts locally, not for providers it compacts remotely (OpenAI, Azure, Bedrock)' },
      { doc: 'docs/design/harness-adapters.md', says: 'the `compact_prompt` key, which only local compaction uses (OpenAI, Azure and Bedrock compact remotely and ignore it)' },
      { doc: 'docs/USAGE.md', says: 'Codex follows Buracle\'s summary prompt only where it compacts locally' },
    ],
  },
}

async function openCodeHook(root: string, key: string, event: unknown): Promise<void> {
  const entry = join(root, `opencode-${key}.js`)
  writeFileSync(entry, file((await built()).files.opencode, 'plugins/buracle/index.js'))
  const mod = await import(entry) as { default: { setup: (ctx: unknown) => Promise<unknown> } }
  const hooks = new Map<string, Array<(e: unknown) => unknown>>()
  const done = async () => ({ done: true as const, value: undefined })
  const domain = (name: string): unknown => new Proxy({}, {
    get: (_t, p) => {
      if (typeof p !== 'string' || p === 'then') return undefined
      if (p === 'hook') return async (hook: string, fn: (e: unknown) => unknown) => { hooks.set(`${name}.${hook}`, [...(hooks.get(`${name}.${hook}`) ?? []), fn]); return { dispose: async () => undefined } }
      if (p === 'transform') return async () => ({ dispose: async () => undefined })
      if (p === 'subscribe') return () => ({ [Symbol.asyncIterator]: () => ({ next: done, return: done }) })
      if (p === 'list') return async () => []
      return async () => undefined
    },
  })
  const fixed: Record<string, unknown> = { app: { name: 'cli', version: '2.0.30', channel: 'latest' }, location: { directory: root, project: { id: 'p1', directory: root, canonical: root } }, options: {} }
  const ctx = new Proxy(fixed, { get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : p in t ? t[p] : domain(p)) })
  const cleanup = await mod.default.setup(ctx)
  try {
    for (const fn of hooks.get(key) ?? []) await fn(event)
    await Bun.sleep(50)
  } finally {
    if (typeof cleanup === 'function') await (cleanup as () => Promise<void>)()
  }
}

function sources(dir: string): string {
  return [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: join(REPO, dir) })].sort().map(f => readFileSync(join(REPO, dir, f), 'utf8')).join('\n')
}

describe('parity: the harness feature matrix (README, DESIGN §4.5)', () => {
  test('plan state (w2): the lane guard, the answer receipt and plan-mode stops on all four; background waits where the host wakes the session (omp natively); quiet feedback on Claude Code and omp', async () => {
    const src: Record<Harness, string> = {
      claude: sources('src/adapters/claude'), codex: sources('src/adapters/codex'), opencode: sources('src/adapters/opencode/runtime'), omp: sources('src/adapters/omp/runtime'),
    }
    const each = (test: (code: string, h: Harness) => boolean): Record<Harness, boolean> => ({ claude: test(src.claude, 'claude'), codex: test(src.codex, 'codex'), opencode: test(src.opencode, 'opencode'), omp: test(src.omp, 'omp') })
    expect(each(c => /laneStateDenial\(command\)/.test(c))).toEqual(FEATURES.laneGuard)
    expect(each(c => /reviewNotesNotice\((?:H|HARNESS|'omp'), /.test(c))).toEqual(FEATURES.reviewNotesNotice)
    expect(each(c => /answerReceipt\(/.test(c) && /questionAnswered\(/.test(c))).toEqual(FEATURES.answerReceipt)
    expect(each(c => /readOnly = true/.test(c))).toEqual(FEATURES.readOnlyStop)
    // The omp cells of these two rows rest on host behavior (OMP_NATIVE) and are checked in the docs describe; the omp
    // stop handler only shows the block-with-reason mechanism it shares with Codex.
    expect(withoutOmp(each(c => /input\.backgroundWait = true/.test(c)))).toEqual(withoutOmp(FEATURES.backgroundWait))
    expect(withoutOmp(each(c => /hookEventName: 'Stop', additionalContext/.test(c)))).toEqual(withoutOmp(FEATURES.quietStopFeedback))
    expect(/pi\.on\('session_stop', /.test(src.omp) && /decision: 'block', reason: stopReason\(/.test(src.omp)).toBe(true)
    const { files } = await built()
    const post = (JSON.parse(file(files.claude, 'hooks/hooks.json')) as { hooks: Record<string, Array<{ matcher?: string, hooks: Array<{ async?: boolean }> }>> }).hooks['PostToolUse'] ?? []
    expect(post.find(g => g.hooks[0]?.async !== true)?.matcher?.split('|')).toContain('AskUserQuestion')
    expect(file(files.codex, 'hooks.json')).toContain('"matcher": "request_user_input"')
  })

  test('workflow switches and review records (w3): H19 binds reports to the bound plans, H06/H07 carry the running reviewers, and the model-switch step names each harness\'s own command', async () => {
    const src: Record<Harness, string> = {
      claude: sources('src/adapters/claude'), codex: sources('src/adapters/codex'), opencode: sources('src/adapters/opencode/runtime'), omp: sources('src/adapters/omp/runtime'),
    }
    const each = (t: (code: string) => boolean): Record<Harness, boolean> => ({ claude: t(src.claude), codex: t(src.codex), opencode: t(src.opencode), omp: t(src.omp) })
    expect(each(c => /\.\.\.boundSubject\(sid\)|reviewSubjects\(H, sid\)\)|reviewSubjects\(HARNESS, s\.sid\)|state\.subjects\?\.\(spoolSid\(ctx\)\)/.test(c))).toEqual(FEATURES.reviewSubject)
    expect(each(c => /restoreContext\((?:loadState\(|host\.deps\.state\.load\()/.test(c) && /handoffNote\(/.test(c))).toEqual(FEATURES.reviewRestore)
    const { files, agentsSkills } = await built()
    const neutral = file(agentsSkills, 'plan-build/references/plan.md')
    expect({
      claude: file(files.claude, 'skills/plan-build/references/plan.md').includes('run `/model`, pick the model for the implementation'),
      codex: neutral.includes('**Codex:** run `/model`'),
      opencode: neutral.includes('**OpenCode:** open the model list with `/models`'),
      omp: neutral.includes('**Oh My Pi:** run `/model` (or `/switch`)'),
    }).toEqual(FEATURES.modelSwitchCommand)
  })

  test('H12 saves an approved native plan on Claude Code, Codex and omp; OpenCode has no approval step, so it saves a draft (approved: false)', async () => {
    const { files } = await built()
    const writes = (dir: string, harness: string): string[] => [...sources(dir).matchAll(/(?:capturePlanFile|captureSessionPlan)\(\{([^}]*)\}\)/g)].map(m => m[1] ?? '').filter(args => args.includes(harness))
    const approved = (calls: string[]) => calls.length > 0 && calls.every(args => !args.includes('approved: false'))
    const omp = file(files.omp, 'extensions/buracle.js')
    const opencode = file(files.opencode, 'plugins/buracle/index.js')
    const has: Record<Harness, boolean> = {
      claude: approved(writes('src/adapters/claude', 'harness: H')) && /"matcher": "[^"]*ExitPlanMode/.test(file(files.claude, 'hooks/hooks.json')),
      codex: approved(writes('src/adapters/codex', "harness: 'codex'")) && /captureApprovedPlan\(/.test(readFileSync(join(REPO, 'src/adapters/codex/hook.ts'), 'utf8')),
      opencode: approved(writes('src/adapters/opencode/runtime', 'harness: HARNESS')),
      omp: approved(writes('src/adapters/omp/runtime', "harness: 'omp'")) && omp.includes('OMP_PLAN_APPROVED') && omp.includes('approvingResult'),
    }
    expect(has).toEqual(FEATURES.approvedPlanCapture)
    expect(writes('src/adapters/opencode/runtime', 'harness: HARNESS').some(args => args.includes('approved: false'))).toBe(true)
    expect(opencode).toContain('it is not marked approved')
  })

  test('native plan mode (w4): every H12 path fills a prepared plan-build plan, each harness has its way into plan mode, and leaving plan mode approves the plan everywhere but OpenCode', async () => {
    const { files, agentsSkills } = await built()
    const calls = (dir: string, harness: string): string[] => [...sources(dir).matchAll(/captureSessionPlan\(\{([^}]*)\}\)/g)].map(m => m[1] ?? '').filter(args => args.includes(harness) && /\bsid\b/.test(args))
    const dirs: Record<Harness, [string, string]> = { claude: ['src/adapters/claude', 'harness: H'], codex: ['src/adapters/codex', "harness: 'codex'"], opencode: ['src/adapters/opencode/runtime', 'harness: HARNESS'], omp: ['src/adapters/omp/runtime', "harness: 'omp'"] }
    const neutral = file(agentsSkills, 'plan-build/references/native-plan.md')
    const enters: Record<Harness, boolean> = {
      claude: file(files.claude, 'skills/plan-build/references/native-plan.md').includes('call EnterPlanMode'),
      codex: neutral.includes('**Codex:** ask the user to switch to Plan mode with `/plan`'),
      opencode: neutral.includes('**OpenCode:** ask the user to switch to the plan agent (Tab)'),
      omp: neutral.includes('**Oh My Pi:** ask the user to turn on plan mode with `/plan`'),
    }
    const each = (t: (h: Harness) => boolean): Record<Harness, boolean> => Object.fromEntries(HARNESSES.map(h => [h, t(h)])) as Record<Harness, boolean>
    expect(each(h => calls(...dirs[h]).length > 0 && enters[h])).toEqual(FEATURES.nativePlanMode)
    expect(each(h => calls(...dirs[h]).length > 0 && calls(...dirs[h]).every(args => !args.includes('approved: false')))).toEqual(FEATURES.nativePlanApproval)
  })

  test('review agents run read-only shell everywhere: core reviewerShellDenial on Claude Code, OpenCode and omp, a read-only sandbox on Codex', async () => {
    const { canonical, files } = await built()
    const reviewers = canonical.agents.map(a => a.id).filter(id => id.endsWith('-review'))
    const omp = file(files.omp, 'extensions/buracle.js')
    const opencode = file(files.opencode, 'plugins/buracle/index.js')
    const has: Record<Harness, boolean> = {
      claude: /reviewerShellDenial\(str\(p\['agent_type'\]\), command\)/.test(sources('src/adapters/claude')),
      codex: reviewers.length > 0 && reviewers.every(id => /^sandbox_mode = "read-only"$/m.test(file(files.codex, `agents/${id}.toml`))),
      opencode: /reviewerShellDenial\(e\.agent, command\)/.test(sources('src/adapters/opencode/runtime')) && opencode.includes('is a read-only reviewer'),
      omp: /reviewerShellDenial\(ctx\.agent\?\.name, command\)/.test(sources('src/adapters/omp/runtime')) && omp.includes('is a read-only reviewer'),
    }
    expect(has).toEqual(FEATURES.reviewerShellReadOnly)
  })

  test('path rules reach the agent on all four: Claude natively, omp as TTSR conditions, Codex and OpenCode through the R5 gate (OpenCode also on the first read)', async () => {
    const { canonical, files } = await built()
    const rules = canonical.rules.filter(r => r.scope === 'paths')
    const hookData = JSON.parse(readFileSync(join(REPO, 'harness', 'hook-data.json'), 'utf8')) as { rules: Array<{ id: string, scope: string, frontmatter: Record<string, unknown> }> }
    const plugin = file(files.opencode, 'plugins/buracle/index.js')
    const has: Record<Harness, boolean> = {
      claude: rules.every(r => Array.isArray(frontmatter(renderClaudeRule(r))['paths'])),
      codex: rules.every(r => hookData.rules.some(h => h.id === r.id && h.scope === 'paths' && Array.isArray(h.frontmatter['paths']))) && /pathRules/.test(sources('src/adapters/codex')) && /codexPathRules\(/.test(sources('src/adapters/codex')),
      opencode: rules.every(r => plugin.includes(`id: "${r.id}", globs: [`)) && plugin.includes('onRead: read'),
      omp: rules.every(r => Array.isArray(frontmatter(file(files.omp, `rules/buracle-${r.id}.md`))['condition'])),
    }
    expect(has).toEqual(FEATURES.pathRules)
  })

  test('the immediate consent question on all four: the Claude mod, Codex\'s own approval prompt (an execpolicy prompt rule), the OpenCode TUI and the omp TUI', async () => {
    const { files } = await built()
    const register = file(files.claude, 'hooks/register.tsx')
    const omp = file(files.omp, 'extensions/buracle.js')
    const dialog = (code: string) => code.includes('Allow for this session')
    const { renderRulesFile } = await import('../../src/adapters/codex/execpolicy')
    const codexToml = Bun.TOML.parse(file(files.codex, 'config.fragment.toml').replaceAll('{buracle}', '/x')) as Record<string, unknown>
    const codexHook = readFileSync(join(REPO, 'src/adapters/codex/hook.ts'), 'utf8')
    const codexHooks = JSON.parse(file(files.codex, 'hooks.json')) as { hooks: Record<string, unknown[]> }
    const has: Record<Harness, boolean> = {
      claude: /await consentDialog\(\$, S, \[command\]\)/.test(register) && register.includes('$.ui.ask(') && dialog(register),
      codex: renderRulesFile({ shim: '/u/.buracle/bin/buracle' }).includes('decision = "prompt"') && JSON.stringify(codexToml['approval_policy']) === JSON.stringify({ granular: { sandbox_approval: false, rules: true, skill_approval: false, request_permissions: false, mcp_elicitations: false } })
        && /consentPromptInput\(/.test(codexHook) && /onPermissionRequest\(/.test(codexHook) && (codexHooks.hooks['PermissionRequest'] ?? []).length > 0,
      opencode: dialog(file(files.opencode, 'plugins/buracle/tui.js')) && file(files.opencode, 'plugins/buracle/tui.js').includes('opencode-tui.json') && file(files.opencode, 'plugins/buracle/index.js').includes('the consent dialog')
        && file(files.opencode, 'plugins/buracle/index.js').includes('To ask right away, call the'),
      omp: dialog(omp) && omp.includes('ctx.ui.select(consentQuestion(need)'),
    }
    expect(has).toEqual(FEATURES.consentDialog)
    expectCaveatsInRepo('consentDialog')
  })

  test('a read-only plan mode at a workflow start, and an edit before the plan is approved, get a note on all four', async () => {
    const { files } = await built()
    const src = { claude: sources('src/adapters/claude'), codex: sources('src/adapters/codex'), opencode: sources('src/adapters/opencode/runtime'), omp: sources('src/adapters/omp/runtime') }
    const notice = 'was started while the session is in'
    const early = 'is still in its plan phase'
    const bundles: Record<Harness, string> = {
      claude: file(files.claude, 'hooks/core/plan/plan-mode.ts'), codex: readFileSync(join(REPO, 'src/core/plan/plan-mode.ts'), 'utf8'),
      opencode: file(files.opencode, 'plugins/buracle/index.js'), omp: file(files.omp, 'extensions/buracle.js'),
    }
    const has = (test: (h: Harness) => boolean): Record<Harness, boolean> => Object.fromEntries(HARNESSES.map(h => [h, test(h)])) as Record<Harness, boolean>
    expect(has(h => bundles[h].includes(notice) && /readOnlyStart(?:Notice)?\(/.test(src[h]))).toEqual(FEATURES.readOnlyStartNotice)
    expect(has(h => bundles[h].includes(early) && /earlyEdit(?:Note)?\(/.test(src[h]))).toEqual(FEATURES.earlyEditNote)
  }, 60_000)

  test('5-hour and weekly usage windows on all four; OpenCode reads them from provider responses (the server plugin bundle\'s http.response hook)', () => withSandbox(async ({ home, root }) => {
    const labels = (ws: ReadonlyArray<{ label: string }>) => ws.map(w => w.label).sort()
    const claude = readClaudePayload({ rate_limits: { five_hour: { used_percentage: 42 }, seven_day: { used_percentage: 18 } } }, home).windows
    installUsageFixture('codex', join(home, '.codex'))
    const codex = (await collectCodex({ nowMs: USAGE_NOW, pricing: {}, which: () => undefined })).windows
    const omp = windowsFromOmpUsage(JSON.parse(readFileSync(join(USAGE_FIXTURES, 'omp', 'usage.json'), 'utf8')) as unknown, USAGE_NOW)
    expect((await collectOpencode({ nowMs: USAGE_NOW, pricing: {} })).windows).toEqual([])
    await openCodeHook(root, 'session.http.response', { sessionID: 'ses_windows1', response: new Response(null, { headers: rateLimitHeaders(USAGE_NOW) }) })
    const opencode = (await collectOpencode({ nowMs: USAGE_NOW, pricing: {} })).windows
    const has = (ws: ReadonlyArray<{ label: string }>) => ['5h', '7d'].every(l => labels(ws).includes(l))
    expect({ claude: has(claude), codex: has(codex), opencode: has(opencode), omp: has(omp) }).toEqual(FEATURES.rateWindows)
  }))

  test('open todos carried into the handoff note on all four (OpenCode through its experimental todowrite tool)', () => withSandbox(async ({ root }) => {
    const hooksJson = file((await built()).files.claude, 'hooks/hooks.json')
    const claude = /TodoWrite\|TaskCreate\|TaskUpdate/.test(hooksJson) && /handoffNote\(\{[^\n]*\btodo\b/.test(readFileSync(join(REPO, 'src/adapters/claude/hook-end.ts'), 'utf8'))
    const rollout = join(root, 'rollout.jsonl')
    const plan = [{ step: 'Add the tests', status: 'in_progress' }, { step: 'Ship it', status: 'completed' }]
    writeFileSync(rollout, JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'update_plan', call_id: 'c1', arguments: JSON.stringify({ plan }) } }) + '\n')
    const codex = JSON.stringify(readOpenPlanSteps(rollout)) === JSON.stringify(['Add the tests'])
      && /input\.todo = todo/.test(readFileSync(join(REPO, 'src/adapters/codex/hook.ts'), 'utf8'))
    const todos = openTodosOf({ toolName: 'todo', input: {}, isError: false, content: [{ type: 'text', text: 'Remaining items (2):\n  - Write the parser [in_progress]\n  - Old item [completed]' }] })
    const omp = JSON.stringify(todos) === JSON.stringify(['Write the parser'])
      && /handoffNote\(\{[^\n]*\btodo\b/.test(readFileSync(join(REPO, 'src/adapters/omp/runtime/compaction.ts'), 'utf8'))
    const opencode = JSON.stringify(opencodeOpenTodos({ todos: [{ content: 'Write the parser', status: 'in_progress' }, { content: 'Old item', status: 'completed' }] })) === JSON.stringify(['Write the parser'])
      && /input\.todo = s\.todos/.test(readFileSync(join(REPO, 'src/adapters/opencode/runtime/plugin.ts'), 'utf8'))
    expect({ claude, codex, opencode, omp }).toEqual(FEATURES.todoHandoff)
  }))

  test('the context warning reaches the model mid-turn: Claude Code with PreToolUse, Codex with PostToolUse, OpenCode with every request, omp as an aside message', async () => {
    const { files } = await built()
    const claudeHooks = JSON.parse(file(files.claude, 'hooks/hooks.json')) as { hooks: Record<string, unknown[]> }
    const has: Record<Harness, boolean> = {
      claude: (claudeHooks.hooks['PreToolUse'] ?? []).length > 0 && /async function preToolUse\([^)]*\)[^{]*\{[\s\S]*?contextWarning\(ctx, sid, now\)/.test(readFileSync(join(REPO, 'src/adapters/claude/hook.ts'), 'utf8')),
      codex: /async function onPostToolUse[\s\S]*?contextWarning\(ctx, ev, sid, usage\)/.test(readFileSync(join(REPO, 'src/adapters/codex/hook.ts'), 'utf8')),
      opencode: /async onContext[\s\S]*?contextWatch\(s\.ctxWarned/.test(readFileSync(join(REPO, 'src/adapters/opencode/runtime/plugin.ts'), 'utf8')),
      omp: file(files.omp, 'extensions/buracle.js').includes('buracle.context-warning') && file(files.omp, 'extensions/buracle.js').includes('deliverAs: "aside"'),
    }
    expect(has).toEqual(FEATURES.midTurnContextWarning)
  })

  test('one-time notices reach every harness: the canonical list is in each runtime\'s data and each session start claims it', async () => {
    const { canonical, files } = await built()
    const ids = (canonical.notices ?? []).map(n => n.id)
    expect(ids.length).toBeGreaterThan(0)
    const hookData = JSON.parse(readFileSync(join(REPO, 'harness', 'hook-data.json'), 'utf8')) as { notices?: Array<{ id: string }> }
    const calls = (rel: string) => /startupNotices\(ctx\.canonical\.notices/.test(readFileSync(join(REPO, rel), 'utf8'))
    const inBundle = (text: string) => ids.every(id => text.includes(id)) && text.includes('Buracle notice, shown once on this machine.')
    const has: Record<Harness, boolean> = {
      claude: calls('src/adapters/claude/hook.ts') && ids.every(id => (hookData.notices ?? []).some(n => n.id === id)),
      codex: calls('src/adapters/codex/hook.ts') && ids.every(id => (hookData.notices ?? []).some(n => n.id === id)),
      opencode: inBundle(file(files.opencode, 'plugins/buracle/index.js')),
      omp: inBundle(file(files.omp, 'extensions/buracle.js')) && file(files.omp, 'extensions/buracle.js').includes('buracle.notice'),
    }
    expect(has).toEqual(FEATURES.startupNotices)
  })

  test('the compaction summary keeps Buracle\'s list (decisions, rejected approaches, verification, files, todos) on all four; Codex only where it compacts locally', async () => {
    const { files } = await built()
    const keep = 'Keep the approaches that were tried and rejected'
    const codexToml = Bun.TOML.parse(file(files.codex, 'config.fragment.toml').replaceAll('{buracle}', '/x')) as Record<string, unknown>
    const has: Record<Harness, boolean> = {
      claude: /on\('session\.compact'/.test(file(files.claude, 'hooks/register.tsx')) && file(files.claude, 'hooks/core/compact.ts').includes(keep),
      codex: typeof codexToml['compact_prompt'] === 'string' && (codexToml['compact_prompt'] as string).includes(keep),
      opencode: file(files.opencode, 'plugins/buracle/index.js').includes(keep),
      omp: file(files.omp, 'extensions/buracle.js').includes(keep),
    }
    expect(has).toEqual(FEATURES.summaryKeepList)
    expectCaveatsInRepo('summaryKeepList')
  })

  test('goal-build\'s portable brief opens with the native /goal command on Claude Code, Codex and omp; OpenCode has none', async () => {
    const { files, agentsSkills } = await built()
    const claude = file(files.claude, 'skills/goal-build/references/verify-and-handback.md')
    const neutral = file(agentsSkills, 'goal-build/references/verify-and-handback.md').split('\n')
    const labeled = (label: string) => neutral.find(l => l.startsWith(`**${label}:**`)) ?? ''
    const goal = (text: string) => /`\/goal [^`]+`/.test(text)
    expect(labeled('OpenCode')).toContain('no goal command')
    expect({ claude: goal(claude), codex: goal(labeled('Codex')), opencode: goal(labeled('OpenCode')), omp: goal(labeled('Oh My Pi')) }).toEqual(FEATURES.goalCommand)
  })
  test('H28 lists unindexed .claude/rules for Codex, OpenCode and omp (Claude Code loads them natively) and Claude-only skills for Codex alone (the others read .claude/skills)', () => withSandbox(async ({ root }) => {
    const { assetsContext } = await import('../../src/adapters/shared/project-assets')
    const { makeRepo, write } = await import('../workflow/fixture')
    const repo = await makeRepo(root)
    write(join(repo, 'AGENTS.md'), '# Demo\n')
    write(join(repo, '.claude', 'rules', 'web.md'), '---\npaths: ["src/**"]\n---\n')
    write(join(repo, '.claude', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review\n---\n')
    const text = Object.fromEntries(HARNESSES.map(h => [h, assetsContext(repo, h)])) as Record<Harness, string>
    expect(Object.fromEntries(HARNESSES.map(h => [h, text[h].includes('.claude/rules/web.md')]))).toEqual(FEATURES.projectRuleList)
    expect(Object.fromEntries(HARNESSES.map(h => [h, text[h].includes('- `review`')]))).toEqual(FEATURES.claudeOnlySkillList)
    const { files } = await built()
    expect(file(files.omp, 'extensions/buracle.js')).toContain('Buracle project rules (H28)')
    expect(file(files.opencode, 'plugins/buracle/index.js')).toContain('Buracle project rules (H28)')
  }), 60_000)

  test('H03 shell nudges: a shell file write points to the edit tools on all four; a shell file print to the read tool where one exists (Codex has none)', async () => {
    const { emptyLedger, ledgerPrompt, reminders } = await import('../../src/core/policy/usage')
    const { classifyTool } = await import('../../src/core/events')
    const shellTool: Record<Harness, string> = { claude: 'Bash', codex: 'Bash', opencode: 'bash', omp: 'bash' }
    const note = (h: Harness, command: string) => {
      const input = { command }
      const call = { harness: h, sessionId: 's', cwd: '/repo', tool: shellTool[h], input, ...classifyTool(h, shellTool[h], input, '/repo') }
      return reminders(ledgerPrompt(emptyLedger(), { invoked: [], load: [], candidates: [], categories: [], memory: { recall: false, write: false } }, 1), call, { strictness: 'enforce', available: [] }).context ?? ''
    }
    expect(Object.fromEntries(HARNESSES.map(h => [h, note(h, "sed -i 's/a/b/' src/a.ts").includes('this shell command writes')]))).toEqual(FEATURES.shellWriteNudge)
    expect(Object.fromEntries(HARNESSES.map(h => [h, note(h, 'cat src/a.ts').includes('instead of printing')]))).toEqual(FEATURES.shellReadNudge)
    const { files } = await built()
    for (const bundle of [file(files.opencode, 'plugins/buracle/index.js'), file(files.omp, 'extensions/buracle.js')]) {
      expect(bundle).toContain('instead of printing')
      expect(bundle).toContain('H04:missing:')
      expect(bundle).toContain('dotnet format: the whitespace is not formatted')
    }
  }, 60_000)

  test('the side question: /aside on Claude Code, OpenCode and omp; their own /btw stays theirs', async () => {
    const s = await surfaces()
    expect(claudeModCommands(file(s.built.files.claude, 'hooks/register.tsx')).has('aside')).toBe(true)
    expect(OMP_BUILTIN_COMMANDS.has('btw')).toBe(true)
    expect([...s.omp.commands].filter(c => c === 'aside' || c === 'btw')).toEqual(['aside'])
    expect([...s.openCodeServer.commands, ...s.openCodeTui.slash].filter(c => c === 'aside' || c === 'btw')).toEqual(['aside'])
  }, 60_000)

  test('UX parity (w3): turn receipts and loop alarms, the long-turn notification and the resume hint on all four; live memory and plan panes everywhere but Codex', async () => {
    const { files } = await built()
    const src: Record<Harness, string> = {
      claude: sources('src/adapters/claude'), codex: sources('src/adapters/codex'), opencode: sources('src/adapters/opencode/runtime'), omp: sources('src/adapters/omp/runtime'),
    }
    const each = (test: (code: string, h: Harness) => boolean): Record<Harness, boolean> => ({ claude: test(src.claude, 'claude'), codex: test(src.codex, 'codex'), opencode: test(src.opencode, 'opencode'), omp: test(src.omp, 'omp') })
    expect(each(c => /receiptLine\(/.test(c) && /noteCommand\(/.test(c) && /note(?:Changes|Edit)\(/.test(c))).toEqual(FEATURES.turnReceipt)
    expect(each(c => /longTurnText\(/.test(c))).toEqual(FEATURES.longTurnNotice)
    expect(each(c => /resumeSuggestion\(/.test(c))).toEqual(FEATURES.resumeHint)
    expect({
      claude: file(files.claude, 'hooks/register.tsx').includes("component: 'Pane'"),
      codex: [...files.codex.values()].some(t => /setWidget|dialog\.show|component: 'Pane'/.test(t)),
      opencode: file(files.opencode, 'plugins/buracle/tui.js').includes('Live view, updated every few seconds'),
      omp: file(files.omp, 'extensions/buracle.js').includes('buracle.pane'),
    }).toEqual(FEATURES.livePanes)
  }, 60_000)

  test('second opinion (plan.reviews.companion): every host can run it read-only; omp runs it without a shell, with the diff in its prompt', async () => {
    const { companionHost } = await import('../../src/workflow/companion-hosts')
    expect(Object.fromEntries(HARNESSES.map(h => [h, companionHost(h).shell]))).toEqual(FEATURES.companionShell)
  })

  test('browser control on all four: chrome-devtools on Claude Code, Codex and OpenCode; omp drives its built-in browser, so the browser MCP servers stay out of its .mcp.json', async () => {
    const { canonical, files } = await built()
    const browser = Object.keys(canonical.mcp.servers).filter(id => canonical.mcp.servers[id]?.routing.includes('browser')).sort()
    expect(browser).toContain('chrome-devtools')
    const configured = Object.fromEntries(HARNESSES.map(h => [h, mcpServers(h, files[h])])) as Record<Harness, string[]>
    const has: Record<Harness, boolean> = {
      claude: browser.some(id => configured.claude.includes(id)),
      codex: browser.some(id => configured.codex.includes(id)),
      opencode: browser.some(id => configured.opencode.includes(id)),
      // omp has a built-in browser tool (https://github.com/can1357/oh-my-pi/blob/main/docs/tools/browser.md), so
      // ompMcpServerIds (src/adapters/omp/generated.ts) drops every browser-routed server from its .mcp.json.
      omp: browser.every(id => !configured.omp.includes(id) && !ompMcpServerIds(canonical).includes(id))
        && /!s\.routing\.includes\('browser'\)/.test(readFileSync(join(REPO, 'src/adapters/omp/generated.ts'), 'utf8')),
    }
    expect(has).toEqual(FEATURES.browserControl)
  })

  test('host limits (PARITY-10): the cells no tested host can close, each false cell recorded once in HOST_LIMITS with its reason and fallback, each LIMITS caveat as a partial entry', async () => {
    const { files } = await built()
    const claudeHooks = file(files.claude, 'hooks/hooks.json')
    const codexHooks = file(files.codex, 'hooks.json')
    const omp = file(files.omp, 'extensions/buracle.js')
    expect({ claude: claudeHooks.includes('"Stop"'), codex: codexHooks.includes('"Stop"'), opencode: /session\.hook\('(?:stop|idle)'/.test(sources('src/adapters/opencode/runtime')), omp: omp.includes('"session_stop"') }).toEqual(FEATURES.stopVeto)
    expect({ claude: claudeHooks.includes('"SubagentStop"'), codex: codexHooks.includes('"SubagentStop"'), opencode: /subagent[._]?stop/i.test(sources('src/adapters/opencode/runtime')), omp: /toolName === 'yield'/.test(sources('src/adapters/omp/runtime')) }).toEqual(FEATURES.subagentStopHold)
    expect({ claude: file(files.claude, 'hooks/register.tsx').includes('$.command.register('), codex: [...files.codex.keys()].some(k => /^(?:prompts|commands)\//.test(k)), opencode: file(files.opencode, 'plugins/buracle/tui.js').includes('arguments: true'), omp: omp.includes('registerCommand(') }).toEqual(FEATURES.commandsWithoutTurn)
    expect({ claude: /async function masked\(/.test(file(files.claude, 'hooks/register.tsx')), codex: /write_stdin/.test(codexHooks), opencode: /maskResult\(e, cls\.kind\)/.test(sources('src/adapters/opencode/runtime')), omp: /maskResult\(event, ctx/.test(sources('src/adapters/omp/runtime')) }).toEqual(FEATURES.liveExecMask)
    expect({ claude: /async function masked\(/.test(file(files.claude, 'hooks/register.tsx')), codex: codexHooks.includes('"PostToolUseFailure"'), opencode: /else this\.maskError\(e, cls\.kind\)/.test(sources('src/adapters/opencode/runtime')), omp: /maskResult\(event, ctx/.test(sources('src/adapters/omp/runtime')) && !/isError[^\n]*maskResult/.test(sources('src/adapters/omp/runtime')) }).toEqual(FEATURES.failedMcpMask)
    expect({ claude: /statusline claude/.test(readFileSync(join(REPO, 'src/adapters/claude/install.ts'), 'utf8')), codex: /statusline codex/.test(file(files.codex, 'config.fragment.toml')), opencode: file(files.opencode, 'plugins/buracle/tui.js').includes('prompt.footer.status'), omp: file(files.omp, 'extensions/buracle.js').includes('setStatus(') }).toEqual(FEATURES.customStatusLine)
    const falseCells = Object.entries(FEATURES).flatMap(([feature, cells]) => HARNESSES.filter(h => !cells[h]).map(h => `${feature}:${h}`)).sort()
    expect(HOST_LIMITS.filter(l => l.kind !== 'partial').map(l => `${l.feature}:${l.harness}`).sort()).toEqual(falseCells)
    const caveats = Object.entries(LIMITS).flatMap(([feature, byHarness]) => Object.keys(byHarness ?? {}).map(h => `${feature}:${h}`))
    expect(HOST_LIMITS.filter(l => l.kind === 'partial').map(l => `${l.feature}:${l.harness}`).sort()).toEqual([...caveats, 'rateWindows:opencode'].sort())
    for (const l of HOST_LIMITS) {
      expect({ id: l.id, cell: FEATURES[l.feature as keyof typeof FEATURES]?.[l.harness] }).toEqual({ id: l.id, cell: l.kind === 'partial' })
      expect({ id: l.id, told: l.reason !== '' && l.fallback !== '' && (l.kind === 'native' || l.probe !== undefined || (l.recheck ?? '') !== '') }).toEqual({ id: l.id, told: true })
    }
    expect(new Set(HOST_LIMITS.map(l => l.id)).size).toBe(HOST_LIMITS.length)
  }, 60_000)
})

function caveats(feature: keyof typeof FEATURES, where: 'repo' | 'docs'): Array<{ doc: string, says: string }> {
  return Object.values(LIMITS[feature] ?? {}).flat().filter(l => l.doc.startsWith('docs/') === (where === 'docs'))
}

/** The caveats of a partial cell that live in the repository (canonical/, never under docs/): checked in the cell test itself. */
function expectCaveatsInRepo(feature: keyof typeof FEATURES): void {
  const limits = caveats(feature, 'repo')
  expect(limits.length).toBeGreaterThan(0)
  for (const limit of limits) expect({ doc: limit.doc, has: readFileSync(join(REPO, limit.doc), 'utf8').includes(limit.says) }).toEqual({ doc: limit.doc, has: true })
}

describe('parity: the design documents carry the matrix and the host limits (skipped while docs/ is absent)', () => {
  const adapters = () => readFileSync(join(REPO, 'docs', 'design', 'harness-adapters.md'), 'utf8')
  const ompCell = (matrix: string, row: string): string => (matrix.split('\n').find(l => l.startsWith(`| ${row} `)) ?? '').split('|').at(-2) ?? ''

  test.skipIf(!HAS_DOCS)('the omp cells of the background wait and the stop guard name omp\'s native mechanisms', () => {
    const matrix = adapters()
    expect(ompCell(matrix, 'Wait for background work without a block (H08)').includes(OMP_NATIVE.backgroundWait)).toBe(FEATURES.backgroundWait.omp)
    expect(ompCell(matrix, 'Block a stop (stop guard)').includes(OMP_NATIVE.quietStopFeedback)).toBe(FEATURES.quietStopFeedback.omp)
  })

  test.skipIf(!HAS_DOCS)('the matrix has a row for every feature the code tests cover by name', () => {
    const matrix = adapters()
    const rows = ['Bind a review report to the bound plans (H19)', 'Keep a background reviewer through compaction (H06, H07)', 'Switch models after plan approval', 'Plan a feature in the harness\'s plan mode (`plan.nativePlanMode`, H12)', 'Second opinion on another harness (`plan.reviews.companion`)']
    for (const row of rows) expect({ row, present: matrix.includes(`| ${row}`) }).toEqual({ row, present: true })
  })

  test.skipIf(!HAS_DOCS)('the caveats of the partial cells are written down in the design and usage documents', () => {
    for (const feature of ['consentDialog', 'summaryKeepList'] as const) {
      const limits = caveats(feature, 'docs')
      expect(limits.length).toBeGreaterThan(0)
      for (const limit of limits) expect({ doc: limit.doc, has: readFileSync(join(REPO, limit.doc), 'utf8').includes(limit.says) }).toEqual({ doc: limit.doc, has: true })
    }
  })

  test.skipIf(!HAS_DOCS)('every HOST_LIMITS record is documented by its id', () => {
    const doc = adapters()
    for (const l of HOST_LIMITS) expect({ id: l.id, documented: doc.includes(`\`${l.id}\``) }).toEqual({ id: l.id, documented: true })
  })
})

// --- PRD R13: the same instructions on every harness -----------------------------------------------------------------

const HB_START = /^[ \t]*<!--[ \t]*harness:(claude|codex|opencode|omp)[ \t]*-->[ \t]*$/
const HB_END = /^[ \t]*<!--[ \t]*\/harness[ \t]*-->[ \t]*$/
const HB_INLINE = /<!--[ \t]*harness:(claude|codex|opencode|omp)[ \t]*-->([\s\S]*?)<!--[ \t]*\/harness[ \t]*-->/g

interface HarnessBlockRun { file: string, line: number, harnesses: Harness[], firstLine: string }

/** The harness-block runs of a canonical text as the renderer groups them: consecutive full-line blocks are one run, an inline block a run of its own. */
function harnessBlockRuns(file: string, text: string): HarnessBlockRun[] {
  const lines = text.split('\n')
  const runs: HarnessBlockRun[] = []
  let run: HarnessBlockRun | undefined
  let open = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const start = HB_START.exec(line)
    if (start !== null) {
      run ??= { file, line: i + 1, harnesses: [], firstLine: '' }
      run.harnesses.push(start[1] as Harness)
      open = true
      continue
    }
    if (open) {
      if (HB_END.test(line)) open = false
      else if (run !== undefined && run.firstLine === '' && line.trim() !== '') run.firstLine = line.trim()
      continue
    }
    if (run !== undefined) { runs.push(run); run = undefined }
    for (const m of line.matchAll(HB_INLINE)) runs.push({ file, line: i + 1, harnesses: [m[1] as Harness], firstLine: (m[2] ?? '').trim() })
  }
  if (run !== undefined) runs.push(run)
  return runs
}

function withoutHarnessBlocks(text: string): string {
  const out: string[] = []
  let open = false
  for (const line of text.split('\n')) {
    if (HB_START.test(line)) { open = true; continue }
    if (open) { if (HB_END.test(line)) open = false; continue }
    out.push(line.replace(HB_INLINE, ''))
  }
  return out.join('\n')
}

interface PlaceholderIds { skills: string[], protocols: string[], agents: string[] }

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const longestFirst = (xs: readonly string[]): string[] => [...xs].sort((a, b) => b.length - a.length)

function joinLabels(hs: readonly Harness[]): string {
  const names = hs.map(h => HARNESS_LABEL[h])
  return names.length <= 1 ? names[0] ?? '' : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The neutral prose forms of a placeholder, taken from the renderer itself: mid-sentence, after a determiner, at a sentence start and inside parentheses. */
function neutralProseForms(placeholder: string, protocols: readonly string[]): string[] {
  const opts = { protocols }
  const forms = [
    renderMarkdown(`x ${placeholder} y`, 'neutral', opts).slice('x '.length, -' y'.length),
    renderMarkdown(`the ${placeholder} y`, 'neutral', opts).slice('the '.length, -' y'.length),
    renderMarkdown(`${placeholder} y`, 'neutral', opts).slice(0, -' y'.length),
    renderMarkdown(`(${placeholder})`, 'neutral', opts).slice(1, -1),
  ]
  return longestFirst([...new Set(forms)])
}

/** The neutral render of a code span holding a placeholder plus more text: one variant per group of harnesses, joined with their labels. */
function neutralCodeForm(name: 'ask_user' | 'todo' | 'spawn_agent' | 'skill', arg: string | undefined, invocable: boolean): RegExp | undefined {
  const groups: Array<{ harnesses: Harness[], value: string }> = []
  for (const h of ['codex', 'opencode', 'omp'] as const) {
    const value = placeholderLiteral({ name, ...(arg === undefined ? {} : { arg }) }, h, invocable) ?? 'a short checklist in your reply'
    const hit = groups.find(g => g.value === value)
    if (hit !== undefined) hit.harnesses.push(h)
    else groups.push({ harnesses: [h], value })
  }
  if (groups.length < 2) return undefined
  const parts = groups.map((g, k) => `\`${escapeRe(g.value)}${k === 0 ? '([^`]*)' : '\\1'}\` in ${escapeRe(joinLabels(g.harnesses))}`)
  return new RegExp(parts.join(', '), 'g')
}

/**
 * Maps every harness literal a render can hold back to its placeholder token, so the Claude render and the neutral render
 * of the same source can be compared. The same mapping runs on both renders: a literal a source wrote by hand appears in
 * both and maps the same way on both sides.
 */
function placeholderTokens(text: string, ids: PlaceholderIds): string {
  const steps: Array<[RegExp | string, string]> = []
  const prose = (placeholder: string, token: string) => { for (const f of neutralProseForms(placeholder, ids.protocols)) steps.push([new RegExp(escapeRe(f).replace(/^(?:[Yy]our|[Tt]he) /, '(?:[Yy]our|[Tt]he) '), 'g'), token]) }
  const code = (name: 'ask_user' | 'todo' | 'spawn_agent' | 'skill', arg: string | undefined, invocable: boolean, token: string) => { const re = neutralCodeForm(name, arg, invocable); if (re !== undefined) steps.push([re, `\`${token}$1\``]) }
  const literal = (lit: string, token: string) => { steps.push([new RegExp(`\`${escapeRe(lit)}(?![A-Za-z0-9._-])([^\`]*)\``, 'g'), `\`${token}$1\``]) }
  // 1. The neutral prose and code forms (render.ts, neutralProse and renderInlineCode).
  for (const [name, token] of [['ask_user', '{{ask_user}}'], ['todo', '{{todo}}'], ['spawn_agent', '{{spawn_agent}}']] as const) { prose(token, token); code(name, undefined, true, token) }
  for (const id of longestFirst(ids.protocols)) { prose(`{{skill:${id}}}`, `{{skill:${id}}}`); code('skill', id, false, `{{skill:${id}}}`) }
  for (const id of longestFirst(ids.skills.filter(s => !ids.protocols.includes(s)))) { prose(`{{skill:${id}}}`, `{{skill:${id}}}`); code('skill', id, true, `{{skill:${id}}}`) }
  // 2. The Claude prose forms (claude/render.ts, claudeLiteral).
  steps.push([CLAUDE_TODO, '{{todo}}'], ['the `Agent` tool', '{{spawn_agent}}'])
  // 3. The code literals of both renders: Claude's tool names and skill forms, and the bare agent id the neutral render uses.
  literal('AskUserQuestion', '{{ask_user}}'); literal('TodoWrite', '{{todo}}'); literal('Agent', '{{spawn_agent}}')
  for (const id of longestFirst(ids.protocols)) literal(`/buracle:${id}`, `{{skill:${id}}}`)
  for (const id of longestFirst(ids.skills)) literal(`/${id}`, `{{skill:${id}}}`)
  for (const id of longestFirst(ids.agents)) { literal(`buracle:${id}`, `{{agent:${id}}}`); literal(id, `{{agent:${id}}}`) }
  // 4. The agent id outside a code span: Claude's `buracle:<id>` inside a fence, and the bare id (capitalized or not) of the neutral prose.
  for (const id of longestFirst(ids.agents)) steps.push([new RegExp(`(?<![A-Za-z0-9_])buracle:${escapeRe(id)}(?![A-Za-z0-9._-])`, 'g'), `{{agent:${id}}}`])
  for (const id of longestFirst(ids.agents)) steps.push([new RegExp(`(?<![A-Za-z0-9_\`:/.-])[${id[0]?.toUpperCase() ?? ''}${id[0] ?? ''}]${escapeRe(id.slice(1))}(?![A-Za-z0-9._-])`, 'g'), `{{agent:${id}}}`])
  let out = text
  for (const [from, to] of steps) out = typeof from === 'string' ? out.split(from).join(to) : out.replace(from, to)
  // 5. A code span that holds only a token is the token.
  return out.replace(/`(\{\{[a-z_]+(?::[A-Za-z0-9._-]+)?\}\})`/g, '$1')
}

const stripFrontmatter = (text: string): string => text.replace(/^---\n[\s\S]*?\n---\n?/, '')
const normBody = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

function firstDifference(a: string, b: string): { line: number, a: string, b: string } | undefined {
  const la = a.split('\n')
  const lb = b.split('\n')
  for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) return { line: i + 1, a: la[i] ?? '<end>', b: lb[i] ?? '<end>' }
  return undefined
}

function skillMarkdown(skill: CanonicalBundle['skills'][number]): Array<{ path: string, source: string }> {
  const refs = skill.files.filter(f => f.path !== 'SKILL.md' && f.path.endsWith('.md') && !f.path.startsWith('evals/')).map(f => ({ path: f.path, source: f.content }))
  return [{ path: 'SKILL.md', source: skill.body }, ...refs]
}

/**
 * Every harness-block run of canonical/skills/** that does not cover all four harnesses, keyed by skill id and the
 * block's first line. The reason is `feature:<FEATURES key>` (the row that explains the difference), `limit:<HOST_LIMITS
 * id>` (a recorded host limit) or `equivalent:<the mechanism the other harnesses use instead>`.
 */
const RECORDED_HARNESS_BLOCKS: ReadonlyArray<{ skill: string, firstLine: string, reason: string }> = [
  // Claude Code defers MCP tools behind ToolSearch; the other three list every MCP tool from the first turn (Codex keeps the
  // critical servers out of tool_search and code mode with omit_tools_from, OpenCode turns Code Mode off for them with
  // codemode: false, omp loads its .mcp.json servers whole), so they need no loading step.
  { skill: 'research', firstLine: 'MCP tools may be deferred. Load them with ToolSearch (query the server id, for example `context7` or', reason: 'equivalent: Codex (omit_tools_from), OpenCode (codemode: false) and omp (.mcp.json) expose every MCP tool from the first turn, so nothing has to be loaded first' },
  { skill: 'inspect', firstLine: 'MCP tools may be deferred. Load codegraph, semble and buracle-memory tools with ToolSearch before', reason: 'equivalent: Codex (omit_tools_from), OpenCode (codemode: false) and omp (.mcp.json) expose every MCP tool from the first turn, so nothing has to be loaded first' },
  { skill: 'project-rules', firstLine: 'MCP tools may be deferred. Load the semble, codegraph, context7 and buracle-memory tools with', reason: 'equivalent: Codex (omit_tools_from), OpenCode (codemode: false) and omp (.mcp.json) expose every MCP tool from the first turn, so nothing has to be loaded first' },
  { skill: 'memory', firstLine: 'If the memory tools are not visible, load them with ToolSearch before concluding they are', reason: 'equivalent: the memory tools are top-level from the first turn on Codex, OpenCode and omp, and Codex\'s own memories feature stays off (the Codex AGENTS block says so), so no other harness has a second store to warn about' },
  // Find-references through a language server: Claude Code has the LSP tool; Codex and OpenCode reach the same through the lsp MCP bridge, omp through its built-in LSP (the tooling rule routes them there).
  { skill: 'dead-code', firstLine: 'If a language-server tool is available, a find-references result on the symbol also counts as G.', reason: 'equivalent: Codex and OpenCode get find-references from the lsp MCP bridge and omp from its built-in LSP, as the tooling rule says; the G check names codegraph for all four' },
  // omp drives its built-in browser, the other three the chrome-devtools MCP server (the browserControl row).
  { skill: 'bugfix', firstLine: 'omp has no chrome-devtools server: wherever this skill says chrome-devtools, use omp\'s built-in browser tool.', reason: 'feature:browserControl' },
  { skill: 'goal-build', firstLine: 'omp has no chrome-devtools server: wherever this skill says chrome-devtools, use omp\'s built-in browser tool.', reason: 'feature:browserControl' },
  { skill: 'plan-build', firstLine: 'omp has no chrome-devtools server: wherever this skill says chrome-devtools, use omp\'s built-in browser tool.', reason: 'feature:browserControl' },
]

describe('parity: the same instructions on every harness (PRD R13)', () => {
  test('rules: every always rule and path rule carries the canonical body on all four harnesses', async () => {
    const { canonical, files } = await built()
    const codexAgents = file(files.codex, 'AGENTS.md')
    const opencodeAgents = file(files.opencode, 'AGENTS.block.md')
    const shared = new Map(pathRuleFiles(canonical).map(f => [f.id, f.content]))
    // OpenCode reads a path rule through the R5 gate from ~/.buracle/rules/paths, where the core install writes pathRuleFiles.
    const r5 = sources('src/adapters/opencode/runtime').includes("pathRuleSource(this.baked.pathRules, join(this.env.buracleHome, 'rules', 'paths')")
    const problems: string[] = []
    for (const r of canonical.rules) {
      const want = normBody(r.body)
      const inBlock = (block: string) => (block.includes(r.body.replace(/\r\n/g, '\n').trim()) ? want : undefined)
      const got: Record<Harness, string | undefined> = {
        claude: normBody(stripFrontmatter(renderClaudeRule(r))),
        codex: r.scope === 'always' ? inBlock(codexAgents) : normBody(stripFrontmatter(file(files.codex, `rules/paths/${r.id}.md`))),
        opencode: r.scope === 'always' ? inBlock(opencodeAgents) : r5 ? normBody(stripFrontmatter(shared.get(r.id) ?? '')) : undefined,
        omp: normBody(stripFrontmatter(file(files.omp, `rules/buracle-${r.id}.md`))),
      }
      for (const h of HARNESSES) if (got[h] !== want) problems.push(`${r.scope}/${r.id} differs on ${h}`)
    }
    expect(canonical.rules.filter(r => r.scope === 'always').length).toBeGreaterThan(0)
    expect(canonical.rules.filter(r => r.scope === 'paths').length).toBeGreaterThan(0)
    expect(problems).toEqual([])
  })

  test('agents: every review agent carries the canonical body on all four harnesses (frontmatter and the TOML wrapper stripped)', async () => {
    const { canonical, files } = await built()
    const tomlInstructions = (toml: string): string => /developer_instructions = '''\n([\s\S]*?)\n'''/.exec(toml)?.[1] ?? ''
    const problems: string[] = []
    for (const a of canonical.agents) {
      const want = normBody(a.body)
      const got: Record<Harness, string> = {
        claude: normBody(stripFrontmatter(file(files.claude, `agents/${a.id}.md`))),
        codex: normBody(tomlInstructions(file(files.codex, `agents/${a.id}.toml`))),
        opencode: normBody(stripFrontmatter(file(files.opencode, `agents/${a.id}.md`))),
        omp: normBody(stripFrontmatter(file(files.omp, `agents/${a.id}.md`))),
      }
      for (const h of HARNESSES) if (got[h] !== want) problems.push(`${a.id} differs on ${h}`)
    }
    expect(canonical.agents.length).toBeGreaterThan(0)
    expect(problems).toEqual([])
  })

  test('skills: the Claude render and the neutral render are the same instructions once the harness literals are mapped back to their placeholders and the harness blocks are removed', async () => {
    const { canonical, files, agentsSkills } = await built()
    const ids: PlaceholderIds = { skills: canonical.skills.map(s => s.id), protocols: protocolSkills(canonical), agents: canonical.agents.map(a => a.id) }
    const opts = { skills: ids.skills, agents: ids.agents, protocols: ids.protocols }
    let compared = 0
    for (const skill of canonical.skills) {
      for (const { path, source } of skillMarkdown(skill)) {
        const where = `skills/${skill.id}/${path}`
        const strip = path === 'SKILL.md' ? stripFrontmatter : (s: string) => s
        // The built files are the renders of the canonical source.
        expect({ where, built: firstDifference(normBody(strip(file(files.claude, `skills/${skill.id}/${path}`))), normBody(renderClaudeMarkdown(source, where, ids.protocols))) }).toEqual({ where, built: undefined })
        expect({ where, built: firstDifference(normBody(strip(file(agentsSkills, `${skill.id}/${path}`))), normBody(renderMarkdown(source, 'neutral', { ...opts, file: where }))) }).toEqual({ where, built: undefined })
        // Without the harness blocks, both renders say the same thing.
        const plain = withoutHarnessBlocks(source)
        const claude = normBody(placeholderTokens(renderClaudeMarkdown(plain, where, ids.protocols), ids))
        const neutral = normBody(placeholderTokens(renderMarkdown(plain, 'neutral', { ...opts, file: where }), ids))
        expect({ where, diff: firstDifference(claude, neutral) }).toEqual({ where, diff: undefined })
        compared++
      }
    }
    expect(compared).toBeGreaterThan(canonical.skills.length)
  })

  test('the mapping back to placeholders really maps: every literal form of every placeholder, on both renders', () => {
    const ids: PlaceholderIds = { skills: ['plan-build', 'memory'], protocols: ['memory'], agents: ['changes-review'] }
    const source = 'Ask with {{ask_user}}. {{ask_user}} first. Track with {{todo}} and a {{spawn_agent}}; run {{skill:plan-build}} ({{skill:plan-build}}), then {{skill:memory}} and {{agent:changes-review}} in `{{skill:plan-build}} src` and `{{ask_user}}`.'
    const claude = placeholderTokens(renderClaudeMarkdown(source, 'probe', ids.protocols), ids)
    const neutral = placeholderTokens(renderMarkdown(source, 'neutral', { skills: ids.skills, agents: ids.agents, protocols: ids.protocols }), ids)
    expect(neutral).toBe(claude)
    expect(claude).toBe('Ask with {{ask_user}}. {{ask_user}} first. Track with {{todo}} and a {{spawn_agent}}; run {{skill:plan-build}} ({{skill:plan-build}}), then {{skill:memory}} and {{agent:changes-review}} in `{{skill:plan-build}} src` and {{ask_user}}.')
  })

  test('harness blocks: every block run that does not cover all four harnesses is recorded with its reason (a feature row, a host limit or the equivalent mechanism)', async () => {
    const { canonical } = await built()
    const runs = canonical.skills.flatMap(s => skillMarkdown(s).flatMap(({ path, source }) => harnessBlockRuns(`skills/${s.id}/${path}`, source).map(r => ({ ...r, skill: s.id }))))
    const partial = runs.filter(r => new Set(r.harnesses).size < HARNESSES.length)
    const key = (skill: string, firstLine: string) => `${skill}: ${firstLine}`
    const recorded = new Set(RECORDED_HARNESS_BLOCKS.map(r => key(r.skill, r.firstLine)))
    const unrecorded = partial.filter(r => !recorded.has(key(r.skill, r.firstLine))).map(r => `${r.file}:${r.line} (${r.harnesses.join(', ')}): ${r.firstLine}`)
    expect(unrecorded).toEqual([])
    const present = new Set(partial.map(r => key(r.skill, r.firstLine)))
    expect(RECORDED_HARNESS_BLOCKS.filter(r => !present.has(key(r.skill, r.firstLine))).map(r => key(r.skill, r.firstLine))).toEqual([])
    for (const r of RECORDED_HARNESS_BLOCKS) {
      const m = /^(feature|limit|equivalent):(.+)$/.exec(r.reason)
      const reasonOk = m !== null && (m[1] === 'feature' ? Object.hasOwn(FEATURES, m[2] ?? '') : m[1] === 'limit' ? HOST_LIMITS.some(l => l.id === m[2]) : (m[2] ?? '').trim().length >= 20)
      expect({ row: key(r.skill, r.firstLine), reasonOk }).toEqual({ row: key(r.skill, r.firstLine), reasonOk: true })
    }
    expect(runs.length).toBeGreaterThan(partial.length)
    expect(new Set(RECORDED_HARNESS_BLOCKS.map(r => key(r.skill, r.firstLine))).size).toBe(RECORDED_HARNESS_BLOCKS.length)
  })
})

describe('parity: documents follow the user\'s language (PRD 2026-11-06 R18)', () => {
  // The language order of the plain-language rule, with no sentence that makes a document English.
  const ORDER = [
    'An explicit request in this conversation',
    'A language rule of the project for this output',
    "The harness's own language setting, where the harness has one.",
    'An explicit language preference in memory.',
    "The language of the user's messages. A message with no language signal",
  ]
  const holds = (text: string) => ORDER.every(s => text.includes(s)) && !/\bis English\b|English section titles/.test(text)

  test('the rendered explain rule carries the same language order on all four harnesses', async () => {
    const { canonical, files } = await built()
    const explain = canonical.rules.find(r => r.id === 'explain')
    if (explain === undefined) throw new Error('canonical has no explain rule')
    const has: Record<Harness, boolean> = {
      claude: holds(renderClaudeRule(explain)),
      codex: holds(file(files.codex, 'AGENTS.md')),
      opencode: holds(file(files.opencode, 'AGENTS.block.md')),
      omp: holds(file(files.omp, 'rules/buracle-explain.md')),
    }
    expect(has).toEqual({ claude: true, codex: true, opencode: true, omp: true })
  })
})
