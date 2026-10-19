import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { readOpenPlanSteps } from '../../src/adapters/codex/rollout'
import { OMP_BUILTIN_LSP, ompLspServers } from '../../src/adapters/omp/generated'
import { ompConfigKeys } from '../../src/adapters/omp/install'
import { HOST_LIMITS } from '../../src/adapters/shared/host-limits'
import { OMP_BUILTIN_COMMANDS } from '../../src/adapters/omp/runtime/commands'
import { openTodosOf } from '../../src/adapters/omp/runtime/tool-output'
import { renderRule as renderClaudeRule } from '../../src/adapters/claude/install'
import { allAdapters } from '../../src/adapters/registry'
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

  test('codex: $<id> for every workflow from the shared ~/.agents/skills render', async () => {
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

const FEATURES: Readonly<Record<'consentDialog' | 'readOnlyStartNotice' | 'earlyEditNote' | 'rateWindows' | 'todoHandoff' | 'pathRules' | 'goalCommand' | 'projectRuleList' | 'claudeOnlySkillList' | 'laneGuard' | 'answerReceipt' | 'readOnlyStop' | 'backgroundWait' | 'quietStopFeedback' | 'shellWriteNudge' | 'shellReadNudge' | 'approvedPlanCapture' | 'reviewerShellReadOnly' | 'midTurnContextWarning' | 'startupNotices' | 'summaryKeepList' | 'languageServers' | 'lspDiagnosticsOnEdit' | 'turnReceipt' | 'longTurnNotice' | 'resumeHint' | 'hideMcpTools' | 'livePanes' | 'stopVeto' | 'subagentStopHold' | 'commandsWithoutTurn' | 'liveExecMask' | 'failedMcpMask' | 'customStatusLine' | 'reviewSubject' | 'reviewRestore' | 'modelSwitchCommand' | 'nativePlanMode' | 'nativePlanApproval' | 'companionShell' | 'reviewNotesNotice', Readonly<Record<Harness, boolean>>>> = {
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
  todoHandoff: { claude: true, codex: true, opencode: false, omp: true },
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
  hideMcpTools: { claude: true, codex: true, opencode: true, omp: true },
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
}

const OMP_NATIVE = { backgroundWait: 'hasPendingAsyncWake', quietStopFeedback: 'session-stop-continuation' } as const

const HAS_DOCS = existsSync(join(REPO, 'docs', 'DESIGN.md'))

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
    expect(each(c => /laneStateDenialAll\(/.test(c))).toEqual(FEATURES.laneGuard)
    expect(each(c => /answerReceipt\(/.test(c) && /questionAnswered\(/.test(c))).toEqual(FEATURES.answerReceipt)
    expect(each(c => /readOnly = true/.test(c))).toEqual(FEATURES.readOnlyStop)
    const matrix = HAS_DOCS ? readFileSync(join(REPO, 'docs', 'design', 'harness-adapters.md'), 'utf8') : ''
    const ompCell = (row: string, native: string): boolean => !HAS_DOCS || ((matrix.split('\n').find(l => l.startsWith(`| ${row} `)) ?? '').split('|').at(-2) ?? '').includes(native)
    expect(each((c, h) => h === 'omp' ? ompCell('Wait for background work without a block (H08)', OMP_NATIVE.backgroundWait) : /input\.backgroundWait = true/.test(c))).toEqual(FEATURES.backgroundWait)
    expect(each((c, h) => h === 'omp' ? ompCell('Block a stop (stop guard)', OMP_NATIVE.quietStopFeedback) : /hookEventName: 'Stop', additionalContext/.test(c))).toEqual(FEATURES.quietStopFeedback)
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
    if (HAS_DOCS) {
      const matrix = readFileSync(join(REPO, 'docs', 'design', 'harness-adapters.md'), 'utf8')
      for (const row of ['Bind a review report to the bound plans (H19)', 'Keep a background reviewer through compaction (H06, H07)', 'Switch models after plan approval']) expect(matrix).toContain(`| ${row}`)
    }
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
    if (HAS_DOCS) expect(readFileSync(join(REPO, 'docs', 'design', 'harness-adapters.md'), 'utf8')).toContain('| Plan a feature in the harness\'s plan mode (`plan.nativePlanMode`, H12) |')
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
    const limits = Object.values(LIMITS.consentDialog ?? {}).flat().filter(l => HAS_DOCS || !l.doc.startsWith('docs/'))
    expect(limits.length).toBeGreaterThan(0)
    for (const limit of limits) expect(readFileSync(join(REPO, limit.doc), 'utf8')).toContain(limit.says)
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

  test('open todos carried into the handoff note: Claude Code, Codex and omp; not OpenCode', () => withSandbox(async ({ root }) => {
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
    const opencode = /\btodo/i.test(sources('src/adapters/opencode/runtime'))
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
    const limits = Object.values(LIMITS.summaryKeepList ?? {}).flat().filter(l => HAS_DOCS || !l.doc.startsWith('docs/'))
    expect(limits.length).toBeGreaterThan(0)
    for (const limit of limits) expect(readFileSync(join(REPO, limit.doc), 'utf8')).toContain(limit.says)
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

  test('UX parity (w3): turn receipts and loop alarms, the long-turn notification and the resume hint on all four; hidden MCP tools everywhere (omp through setActiveTools); live memory and plan panes everywhere but Codex', async () => {
    const { files } = await built()
    const src: Record<Harness, string> = {
      claude: sources('src/adapters/claude'), codex: sources('src/adapters/codex'), opencode: sources('src/adapters/opencode/runtime'), omp: sources('src/adapters/omp/runtime'),
    }
    const each = (test: (code: string, h: Harness) => boolean): Record<Harness, boolean> => ({ claude: test(src.claude, 'claude'), codex: test(src.codex, 'codex'), opencode: test(src.opencode, 'opencode'), omp: test(src.omp, 'omp') })
    expect(each(c => /receiptLine\(/.test(c) && /noteCommand\(/.test(c) && /note(?:Changes|Edit)\(/.test(c))).toEqual(FEATURES.turnReceipt)
    expect(each(c => /longTurnText\(/.test(c))).toEqual(FEATURES.longTurnNotice)
    expect(each(c => /resumeSuggestion\(/.test(c))).toEqual(FEATURES.resumeHint)
    const hidden = (h: Harness) => h === 'claude' ? /disabled_tools/.test(readFileSync(join(REPO, 'src/adapters/claude/install.ts'), 'utf8'))
      : h === 'codex' ? file(files.codex, 'config.fragment.toml').includes('disabled_tools')
        : h === 'opencode' ? /disabled_tools/.test(readFileSync(join(REPO, 'src/adapters/opencode/render.ts'), 'utf8'))
          : file(files.omp, 'extensions/buracle.js').includes('setActiveTools(') && /hideTools\(pi\)/.test(src.omp)
    expect(each((_c, h) => hidden(h))).toEqual(FEATURES.hideMcpTools)
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
    if (HAS_DOCS) expect(readFileSync(join(REPO, 'docs', 'design', 'harness-adapters.md'), 'utf8')).toContain('| Second opinion on another harness (`plan.reviews.companion`) |')
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
    if (HAS_DOCS) {
      const doc = readFileSync(join(REPO, 'docs', 'design', 'harness-adapters.md'), 'utf8')
      for (const l of HOST_LIMITS) expect({ id: l.id, documented: doc.includes(`\`${l.id}\``) }).toEqual({ id: l.id, documented: true })
    }
  }, 60_000)
})
