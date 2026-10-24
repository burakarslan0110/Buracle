import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentDoc, CanonicalBundle, CanonicalFile, HooksMatrix, McpCatalog, PluginsCatalog, RuleDoc, SkillDoc, StatuslineCatalog, ToolsCatalog } from '../core/catalog'
import { validateMcpCatalog, validatePluginsCatalog, validateToolsCatalog } from '../core/catalog'
import type { BuracleConfig } from '../core/config'
import { defaultConfig, mergeConfig } from '../core/config'
import { validateNotices, type Notice, type NoticeCatalog } from '../core/notices'
import { validateHooksMatrix } from '../core/policy/hooks-matrix'
import type { RoutingPolicy } from '../core/policy/routing'
import { validateRoutingPolicy } from '../core/policy/routing'
import { fileMode } from './exec-bit'
import type { SkillTriggerTable } from '../core/policy/skill-router'
import { parseSkillTriggers, validateSkillTriggers } from '../core/policy/skill-router'
import type { PricingTable } from '../core/usage'
import * as paths from './paths'
import { parseYaml } from './yaml'

export class CanonicalError extends Error {
  readonly problems: string[]
  constructor(root: string, problems: string[]) {
    super(`canonical tree ${root} has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`)
    this.name = 'CanonicalError'
    this.problems = problems
  }
}

export function parseFrontmatter(markdown: string): { frontmatter: Record<string, unknown>, body: string } {
  const text = markdown.startsWith('﻿') ? markdown.slice(1) : markdown
  const open = /^---[ \t]*\r?\n/.exec(text)
  if (!open) return { frontmatter: {}, body: text }
  const rest = text.slice(open[0].length)
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest)
  if (!close) throw new Error('frontmatter is not closed with ---')
  const yamlText = rest.slice(0, close.index)
  const body = rest.slice(close.index + close[0].length)
  const fm = yamlText.trim() === '' ? {} : (parseYaml(yamlText) as unknown)
  if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) throw new Error('frontmatter must be a YAML mapping')
  return { frontmatter: fm as Record<string, unknown>, body }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

function listDir(p: string): string[] {
  try { return readdirSync(p).sort() } catch { return [] }
}

function ignored(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules' || name === '__pycache__'
}

function walkFiles(dir: string, rel = ''): CanonicalFile[] {
  const out: CanonicalFile[] = []
  for (const name of listDir(dir)) {
    if (ignored(name)) continue
    const abs = join(dir, name)
    const relPath = rel === '' ? name : `${rel}/${name}`
    const st = statSync(abs)
    if (st.isDirectory()) out.push(...walkFiles(abs, relPath))
    else if (st.isFile()) out.push({ path: relPath, content: readFileSync(abs, 'utf8'), mode: fileMode(abs, st.mode) })
  }
  return out
}

const DOC_ID = /^[a-z0-9][a-z0-9._-]*$/

export function loadCanonicalSync(root: string = paths.canonicalDir()): CanonicalBundle {
  const problems: string[] = []
  const missing: string[] = []
  const warnings: string[] = []

  const readData = (file: string, required: boolean): unknown => {
    const abs = join(root, file)
    let text: string
    try {
      text = readFileSync(abs, 'utf8')
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        if (required) problems.push(`${file}: missing`)
        else missing.push(file)
      } else problems.push(`${file}: ${e instanceof Error ? e.message : String(e)}`)
      return undefined
    }
    try {
      return parseYaml(text) as unknown
    } catch (e) {
      problems.push(`${file}: invalid YAML: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
      return undefined
    }
  }

  let config: BuracleConfig = defaultConfig()
  const rawConfig = readData('buracle.yaml', true)
  if (rawConfig !== undefined) {
    try { config = mergeConfig(defaultConfig(), rawConfig) } catch (e) { problems.push(`buracle.yaml: ${e instanceof Error ? e.message : String(e)}`) }
  }

  const rawMcp = readData('mcp.yaml', true)
  let mcp: McpCatalog = { servers: {} }
  if (rawMcp !== undefined) {
    const errs = validateMcpCatalog(rawMcp)
    if (errs.length > 0) problems.push(...errs.map(e => `mcp.yaml: ${e}`))
    else mcp = rawMcp as McpCatalog
  }

  const rawPlugins = readData('plugins.yaml', true)
  let plugins: PluginsCatalog = { claude: { marketplaces: [], plugins: [] }, omp: { plugins: [] }, opencode: { plugins: [] } }
  if (rawPlugins !== undefined) {
    const errs = validatePluginsCatalog(rawPlugins)
    if (errs.length > 0) problems.push(...errs.map(e => `plugins.yaml: ${e}`))
    else plugins = rawPlugins as PluginsCatalog
  }

  const rawTools = readData('tools.yaml', true)
  let tools: ToolsCatalog = { tools: [] }
  if (rawTools !== undefined) {
    const errs = validateToolsCatalog(rawTools)
    if (errs.length > 0) problems.push(...errs.map(e => `tools.yaml: ${e}`))
    else tools = rawTools as ToolsCatalog
  }

  let hooks: HooksMatrix = { hooks: [] }
  const rawHooks = readData('hooks.yaml', false)
  if (rawHooks !== undefined) {
    if (rawHooks !== null && typeof rawHooks === 'object' && Array.isArray((rawHooks as { hooks?: unknown }).hooks)) hooks = rawHooks as HooksMatrix
    else problems.push('hooks.yaml: expected { hooks: [...] }')
  }
  let routing: RoutingPolicy = { strictness: config.routing.strictness, categories: [] }
  const rawRouting = readData('routing.yaml', false)
  if (rawRouting !== undefined) {
    const r = rawRouting as { strictness?: unknown, categories?: unknown }
    if (rawRouting !== null && typeof rawRouting === 'object' && Array.isArray(r.categories)) routing = rawRouting as RoutingPolicy
    else problems.push('routing.yaml: expected { strictness, categories: [...] }')
  }
  let triggers: SkillTriggerTable | undefined
  const rawTriggers = readData('skill-triggers.yaml', false)
  if (rawTriggers !== undefined) {
    if (rawTriggers !== null && typeof rawTriggers === 'object' && !Array.isArray(rawTriggers)) triggers = parseSkillTriggers(rawTriggers).table
    else problems.push('skill-triggers.yaml: expected a mapping with version, skills and categories')
  }
  let statusline: StatuslineCatalog = {}
  const rawStatus = readData('statusline.yaml', false)
  if (rawStatus !== undefined) {
    if (rawStatus !== null && typeof rawStatus === 'object' && !Array.isArray(rawStatus)) statusline = rawStatus as StatuslineCatalog
    else problems.push('statusline.yaml: expected a mapping')
  }
  let pricing: PricingTable = {}
  const rawPricing = readData('pricing.yaml', false)
  if (rawPricing !== undefined) {
    if (rawPricing !== null && typeof rawPricing === 'object' && !Array.isArray(rawPricing)) pricing = rawPricing as PricingTable
    else problems.push('pricing.yaml: expected a mapping')
  }
  let notices: Notice[] = []
  const rawNotices = readData('notices.yaml', false)
  if (rawNotices !== undefined) {
    const errs = validateNotices(rawNotices)
    if (errs.length > 0) problems.push(...errs.map(e => `notices.yaml: ${e}`))
    else notices = (rawNotices as NoticeCatalog).notices
  }

  if (rawHooks !== undefined && hooks === rawHooks) for (const e of validateHooksMatrix(rawHooks)) warnings.push(`hooks.yaml: ${e}`)
  if (rawRouting !== undefined && routing === rawRouting) for (const e of validateRoutingPolicy(rawRouting, Object.keys(mcp.servers))) warnings.push(`routing.yaml: ${e}`)

  if (rawRouting !== undefined && routing.categories.length > 0) {
    const ids = new Set(routing.categories.map(c => c.id))
    for (const [id, s] of Object.entries(mcp.servers)) {
      for (const cat of s.routing) if (!ids.has(cat)) warnings.push(`mcp.yaml: servers.${id}.routing references unknown category ${JSON.stringify(cat)}`)
    }
  }

  const docOf = (file: string): { frontmatter: Record<string, unknown>, body: string } | undefined => {
    try {
      return parseFrontmatter(readFileSync(join(root, file), 'utf8'))
    } catch (e) {
      problems.push(`${file}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
      return undefined
    }
  }

  const rules: RuleDoc[] = []
  for (const scope of ['always', 'paths'] as const) {
    for (const name of listDir(join(root, 'rules', scope))) {
      if (ignored(name) || !name.endsWith('.md')) continue
      const id = name.slice(0, -3)
      const file = `rules/${scope}/${name}`
      if (!DOC_ID.test(id)) { problems.push(`${file}: rule id must match ${DOC_ID.source}`); continue }
      const doc = docOf(file)
      if (doc) rules.push({ id, scope, file, frontmatter: doc.frontmatter, body: doc.body })
    }
  }

  const skills: SkillDoc[] = []
  const skillsRoot = join(root, 'skills')
  for (const id of listDir(skillsRoot)) {
    if (ignored(id) || !isDir(join(skillsRoot, id))) continue
    const dir = `skills/${id}`
    if (!DOC_ID.test(id)) { problems.push(`${dir}: skill id must match ${DOC_ID.source}`); continue }
    const files = walkFiles(join(skillsRoot, id))
    if (files.length === 0) continue
    const main = files.find(f => f.path === 'SKILL.md')
    if (!main) { problems.push(`${dir}: SKILL.md is missing`); continue }
    try {
      const doc = parseFrontmatter(main.content)
      skills.push({ id, dir, frontmatter: doc.frontmatter, body: doc.body, files })
    } catch (e) {
      problems.push(`${dir}/SKILL.md: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
    }
  }

  const agents: AgentDoc[] = []
  for (const name of listDir(join(root, 'agents'))) {
    if (ignored(name) || !name.endsWith('.md')) continue
    const id = name.slice(0, -3)
    const file = `agents/${name}`
    if (!DOC_ID.test(id)) { problems.push(`${file}: agent id must match ${DOC_ID.source}`); continue }
    const doc = docOf(file)
    if (doc) agents.push({ id, file, frontmatter: doc.frontmatter, body: doc.body })
  }

  if (triggers !== undefined) {
    const known = {
      skills: skills.map(s => ({ id: s.id, invocation: typeof s.frontmatter['invocation'] === 'string' ? s.frontmatter['invocation'] : undefined, userInvocable: s.frontmatter['user-invocable'] !== false })),
      categories: routing.categories.map(c => c.id),
    }
    for (const e of validateSkillTriggers(rawTriggers, known)) warnings.push(`skill-triggers.yaml: ${e}`)
    const table = triggers
    for (const s of skills) { const t = table.skills[s.id]; if (t !== undefined) s.triggers = t }
    if (routing.categories.some(c => table.categories[c.id] !== undefined && c.triggers === undefined)) {
      routing = { ...routing, categories: routing.categories.map(c => (table.categories[c.id] !== undefined && c.triggers === undefined ? { ...c, triggers: table.categories[c.id] } : c)) }
    }
  }

  if (problems.length > 0) throw new CanonicalError(root, problems)
  const bundle: CanonicalBundle = { root, config, mcp, plugins, tools, hooks, routing, statusline, pricing, rules, skills, agents, notices, missing, warnings }
  if (triggers !== undefined) bundle.triggers = triggers
  return bundle
}

export async function loadCanonical(root?: string): Promise<CanonicalBundle> {
  return loadCanonicalSync(root)
}
