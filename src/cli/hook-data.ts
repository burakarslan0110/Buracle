import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentDoc, CanonicalBundle, McpCatalog, PluginsCatalog, RuleDoc, SkillDoc, ToolsCatalog } from '../core/catalog'
import type { Notice } from '../core/notices'
import type { RoutingPolicy } from '../core/policy/routing'
import { loadCanonicalSync } from '../engine/canonical'
import { log } from '../engine/log'

export const HOOK_DATA_REL = 'harness/hook-data.json'
const HOOK_DATA_VERSION = 1

export type HookSkill = Pick<SkillDoc, 'id' | 'dir' | 'frontmatter' | 'triggers'>
export type HookAgent = Pick<AgentDoc, 'id' | 'file' | 'frontmatter'>
export type HookRule = Pick<RuleDoc, 'id' | 'scope' | 'file' | 'frontmatter'>

export interface HookData {
  v: 1
  generator: string
  mcp: McpCatalog
  plugins: PluginsCatalog
  tools: ToolsCatalog
  routing: RoutingPolicy
  skills: HookSkill[]
  agents: HookAgent[]
  rules: HookRule[]
  notices?: Notice[]
  missing: string[]
  warnings: string[]
}

const LAZY_FIELDS = ['config', 'hooks', 'statusline', 'pricing', 'triggers'] as const

export function hookData(bundle: CanonicalBundle): HookData {
  return {
    v: HOOK_DATA_VERSION,
    generator: 'buracle build (src/cli/hook-data.ts): what the Claude and Codex command hooks read of canonical/',
    mcp: bundle.mcp,
    plugins: bundle.plugins,
    tools: bundle.tools,
    routing: bundle.routing,
    skills: bundle.skills.map(s => ({ id: s.id, dir: s.dir, frontmatter: s.frontmatter, ...(s.triggers !== undefined ? { triggers: s.triggers } : {}) })),
    agents: bundle.agents.map(a => ({ id: a.id, file: a.file, frontmatter: a.frontmatter })),
    rules: bundle.rules.map(r => ({ id: r.id, scope: r.scope, file: r.file, frontmatter: r.frontmatter })),
    notices: (bundle.notices ?? []).map(n => ({ ...n })),
    missing: [...bundle.missing],
    warnings: [...bundle.warnings],
  }
}

export function renderHookData(bundle: CanonicalBundle): string {
  return JSON.stringify(hookData(bundle), null, 2) + '\n'
}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function isStrList(x: unknown): x is string[] {
  return Array.isArray(x) && x.every(v => typeof v === 'string')
}

function validHookData(x: unknown): x is HookData {
  if (!isObj(x) || x['v'] !== HOOK_DATA_VERSION) return false
  const { mcp, plugins, tools, routing, skills, agents, rules } = x
  if (!isObj(mcp) || !isObj(mcp['servers']) || !Object.values(mcp['servers']).every(isObj)) return false
  if (!isObj(plugins) || !isObj(plugins['claude']) || !Array.isArray(plugins['claude']['plugins'])) return false
  if (!isObj(tools) || !Array.isArray(tools['tools'])) return false
  if (!isObj(routing) || !Array.isArray(routing['categories'])) return false
  if (!Array.isArray(skills) || !skills.every(s => isObj(s) && typeof s['id'] === 'string' && typeof s['dir'] === 'string' && isObj(s['frontmatter']))) return false
  if (!Array.isArray(agents) || !agents.every(a => isObj(a) && typeof a['id'] === 'string' && typeof a['file'] === 'string' && isObj(a['frontmatter']))) return false
  if (!Array.isArray(rules) || !rules.every(r => isObj(r) && typeof r['id'] === 'string' && (r['scope'] === 'always' || r['scope'] === 'paths') && typeof r['file'] === 'string' && isObj(r['frontmatter']))) return false
  if (x['notices'] !== undefined && !(Array.isArray(x['notices']) && x['notices'].every(n => isObj(n) && typeof n['id'] === 'string' && typeof n['since'] === 'string' && typeof n['message'] === 'string'))) return false
  return isStrList(x['missing']) && isStrList(x['warnings'])
}

export function readHookData(repoRoot: string): HookData | undefined {
  let text: string
  try { text = readFileSync(join(repoRoot, HOOK_DATA_REL), 'utf8') } catch { return undefined }
  try {
    const x = JSON.parse(text) as unknown
    if (validHookData(x)) return x
  } catch {  }
  log('warn', `hook: ${HOOK_DATA_REL} is not a valid snapshot; loading canonical/ instead (run \`buracle build\`)`)
  return undefined
}

function lazyProp(obj: object, key: string, get: () => unknown): void {
  Object.defineProperty(obj, key, { get, enumerable: true, configurable: true })
}

export function hookBundle(repoRoot: string, load: (root: string) => CanonicalBundle = loadCanonicalSync): CanonicalBundle {
  const root = join(repoRoot, 'canonical')
  const data = readHookData(repoRoot)
  if (data === undefined) return load(root)
  let full: CanonicalBundle | undefined
  const fullBundle = (field: string): CanonicalBundle => {
    if (full === undefined) {
      log('debug', `hook: ${field} is not in ${HOOK_DATA_REL}; loading canonical/`)
      full = load(root)
    }
    return full
  }
  const docOf = <T extends { id: string }>(list: (b: CanonicalBundle) => T[], kind: string, id: string, field: string): T => {
    const doc = list(fullBundle(`${kind} ${id} ${field}`)).find(d => d.id === id)
    if (doc === undefined) throw new Error(`${kind} ${id} is in ${HOOK_DATA_REL} but not in canonical/; run \`buracle build\``)
    return doc
  }
  const skills = data.skills.map(s => {
    const skill = { ...s }
    lazyProp(skill, 'body', () => docOf(b => b.skills, 'skill', s.id, 'body').body)
    lazyProp(skill, 'files', () => docOf(b => b.skills, 'skill', s.id, 'files').files)
    return skill as SkillDoc
  })
  const agents = data.agents.map(a => {
    const agent = { ...a }
    lazyProp(agent, 'body', () => docOf(b => b.agents, 'agent', a.id, 'body').body)
    return agent as AgentDoc
  })
  const rules = data.rules.map(r => {
    const rule = { ...r }
    lazyProp(rule, 'body', () => docOf(b => b.rules, 'rule', r.id, 'body').body)
    return rule as RuleDoc
  })
  const bundle = { root, mcp: data.mcp, plugins: data.plugins, tools: data.tools, routing: data.routing, skills, agents, rules, notices: data.notices ?? [], missing: data.missing, warnings: data.warnings }
  for (const field of LAZY_FIELDS) lazyProp(bundle, field, () => fullBundle(field)[field])
  return bundle as unknown as CanonicalBundle
}
