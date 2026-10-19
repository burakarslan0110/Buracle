import { parseFrontmatter } from '../engine/canonical'
import { opsDeps } from '../engine/update/deps'
import type { FetchResult } from '../engine/update/fetch'
import type { CmdResult, WorkflowCtx } from './result'
import { skillsList } from './skills'

export const REGISTRY_SEARCH_URL = 'https://skills.sh/api/search'
export const REGISTRY_AUDIT_URL = 'https://www.skills.sh/tele/audit'
export const GITHUB_API_URL = 'https://api.github.com'
export const RAW_GITHUB_URL = 'https://raw.githubusercontent.com'
export const DEFAULT_LIMIT = 8
export const MAX_LIMIT = 25
const TIMEOUT_MS = 10_000
const DESCRIPTION_SHOWN = 160
const SKILL_PATHS = ['skills/<id>', '<id>', '.claude/skills/<id>', '.agents/skills/<id>', '.codex/skills/<id>']
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'skill', 'skills'])

export interface FindCandidate {
  rank: number
  id: string
  source: string
  skill: string
  installs: number | null
  description: string | null
  path: string | null
  license: string | null
  pushed_at: string | null
  stars: number | null
  archived: boolean | null
  risk: { socket: string | null, snyk: string | null } | null
  allowed_tools: string | null
  install: string
}

export interface LocalMatch { id: string, source: string, description: string | null, score: number }

interface RegistryHit { id: string, source: string, skill: string, installs: number | null }
interface RepoMeta { license: string | null, pushed_at: string | null, stars: number | null, archived: boolean | null }
interface SkillMd { description: string | null, allowed_tools: string | null, license: string | null, path: string }

function str(v: unknown): string | null { return typeof v === 'string' && v.trim() !== '' ? v.trim() : null }
function num(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null }
function record(v: unknown): Record<string, unknown> | null { return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null }

export function queryTokens(query: string): string[] {
  const out = new Set<string>()
  for (const m of query.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0]
    if (w.length >= 3 && !STOP_WORDS.has(w)) out.add(w)
  }
  return [...out]
}

export function matchLocal(query: string, skills: ReadonlyArray<Record<string, unknown>>): LocalMatch[] {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return []
  const out: LocalMatch[] = []
  for (const s of skills) {
    const id = String(s['id'] ?? '').toLowerCase()
    const description = str(s['description'])
    const text = `${description ?? ''} ${String(s['shortDescription'] ?? '')}`.toLowerCase()
    let score = 0
    for (const t of tokens) {
      if (id.includes(t)) score += 2
      else if (text.includes(t)) score += 1
    }
    if (score > 0) out.push({ id, source: String(s['source'] ?? '?'), description, score })
  }
  return out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, 5)
}

function parseRegistry(json: unknown): RegistryHit[] | undefined {
  const root = record(json)
  if (root === null || !Array.isArray(root['skills'])) return undefined
  const out: RegistryHit[] = []
  for (const raw of root['skills']) {
    const r = record(raw)
    if (r === null) continue
    const source = str(r['source'])
    const skill = str(r['skillId']) ?? str(r['name'])
    if (source === null || skill === null || source.split('/').length !== 2) continue
    out.push({ id: str(r['id']) ?? `${source}/${skill}`, source, skill, installs: num(r['installs']) })
  }
  return out
}

function isGitHubRepo(source: string): boolean { return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source) }

function githubHeaders(env: Record<string, string | undefined>): Record<string, string> {
  const token = env['GITHUB_TOKEN'] ?? env['GH_TOKEN']
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' }
  if (token !== undefined && token.trim() !== '') headers['authorization'] = `Bearer ${token.trim()}`
  return headers
}

function isRateLimited(r: FetchResult): boolean { return !r.ok && (r.status === 403 || r.status === 429) }

async function repoMeta(source: string, env: Record<string, string | undefined>): Promise<{ meta: RepoMeta | null, rateLimited: boolean }> {
  const r = await opsDeps.fetch(`${GITHUB_API_URL}/repos/${source}`, { headers: githubHeaders(env), timeoutMs: TIMEOUT_MS })
  if (!r.ok) return { meta: null, rateLimited: isRateLimited(r) }
  const j = record(r.json)
  if (j === null) return { meta: null, rateLimited: false }
  const lic = record(j['license'])
  const spdx = lic === null ? null : str(lic['spdx_id'])
  return {
    meta: {
      license: spdx === null || spdx === 'NOASSERTION' ? (lic === null ? null : str(lic['name'])) : spdx,
      pushed_at: str(j['pushed_at']),
      stars: num(j['stargazers_count']),
      archived: typeof j['archived'] === 'boolean' ? j['archived'] : null,
    },
    rateLimited: false,
  }
}

async function registryRisk(source: string, skills: string[]): Promise<Map<string, { socket: string | null, snyk: string | null }>> {
  const out = new Map<string, { socket: string | null, snyk: string | null }>()
  const r = await opsDeps.fetch(`${REGISTRY_AUDIT_URL}?source=${encodeURIComponent(source)}&skills=${encodeURIComponent(skills.join(','))}`, { timeoutMs: TIMEOUT_MS })
  const j = r.ok ? record(r.json) : null
  if (j === null) return out
  for (const id of skills) {
    const entry = record(j[id])
    if (entry === null) continue
    const socket = record(entry['socket'])
    const snyk = record(entry['snyk'])
    out.set(id, { socket: socket === null ? null : str(socket['risk']), snyk: snyk === null ? null : str(snyk['risk']) })
  }
  return out
}

interface RepoTree { paths: string[] | null, rateLimited: boolean }
type TreeMemo = Map<string, Promise<RepoTree>>

async function repoTree(source: string, env: Record<string, string | undefined>): Promise<RepoTree> {
  const r = await opsDeps.fetch(`${GITHUB_API_URL}/repos/${source}/git/trees/HEAD?recursive=1`, { headers: githubHeaders(env), timeoutMs: 3 * TIMEOUT_MS })
  const j = r.ok ? record(r.json) : null
  if (j === null || !Array.isArray(j['tree'])) return { paths: null, rateLimited: isRateLimited(r) }
  const paths: string[] = []
  for (const e of j['tree']) {
    const entry = record(e)
    const p = entry === null ? null : str(entry['path'])
    if (p !== null && entry?.['type'] === 'blob') paths.push(p)
  }
  return { paths, rateLimited: false }
}

export function skillFolderIn(paths: readonly string[], skill: string): string | null {
  const suffix = `/${skill}/SKILL.md`
  let best: string | null = null
  for (const p of paths) {
    if (p !== `${skill}/SKILL.md` && !p.endsWith(suffix)) continue
    const folder = p.slice(0, -'/SKILL.md'.length)
    if (best === null || folder.length < best.length) best = folder
  }
  return best
}

async function rawSkillMd(source: string, path: string): Promise<SkillMd | null> {
  const r: FetchResult = await opsDeps.fetch(`${RAW_GITHUB_URL}/${source}/HEAD/${path}/SKILL.md`, { headers: { accept: 'text/plain' }, timeoutMs: TIMEOUT_MS })
  if (!r.ok || typeof r.text !== 'string' || r.text.trim() === '') return null
  let fm: Record<string, unknown> = {}
  try { fm = parseFrontmatter(r.text).frontmatter } catch {  }
  const at = fm['allowed-tools']
  const description = str(fm['description'])
  return {
    description: description === null ? null : description.replace(/\s+/g, ' '),
    allowed_tools: typeof at === 'string' && at.trim() !== '' ? at.trim() : Array.isArray(at) && at.length > 0 ? at.map(String).join(', ') : null,
    license: str(fm['license']),
    path,
  }
}

async function skillMd(source: string, skill: string, env: Record<string, string | undefined>, trees: TreeMemo): Promise<{ md: SkillMd | null, rateLimited: boolean }> {
  for (const pattern of SKILL_PATHS) {
    const md = await rawSkillMd(source, pattern.replace('<id>', skill))
    if (md !== null) return { md, rateLimited: false }
  }
  let tree = trees.get(source)
  if (tree === undefined) { tree = repoTree(source, env); trees.set(source, tree) }
  const t = await tree
  const folder = t.paths === null ? null : skillFolderIn(t.paths, skill)
  return { md: folder === null ? null : await rawSkillMd(source, folder), rateLimited: t.rateLimited }
}

function day(iso: string | null): string { return iso === null ? '?' : iso.slice(0, 10) }

function candidateLines(c: FindCandidate): string[] {
  const facts = [
    c.installs === null ? null : `${c.installs} installs`,
    c.stars === null ? null : `${c.stars} stars`,
    c.license ?? 'no license found',
    c.pushed_at === null ? null : `pushed ${day(c.pushed_at)}`,
    c.archived === true ? 'ARCHIVED' : null,
    c.risk === null ? null : `socket ${c.risk.socket ?? '?'}, snyk ${c.risk.snyk ?? '?'}`,
  ].filter((f): f is string => f !== null)
  const out = [`${String(c.rank).padStart(2)}. ${c.id}   ${facts.join(' · ')}`]
  if (c.description !== null) out.push(`    ${c.description.length > DESCRIPTION_SHOWN ? `${c.description.slice(0, DESCRIPTION_SHOWN - 3)}...` : c.description}`)
  else out.push(`    (no ${c.skill}/SKILL.md in the repository at HEAD: the registry entry may be stale; the --dry-run lists what is there)`)
  if (c.allowed_tools !== null) out.push(`    allowed-tools: ${c.allowed_tools}`)
  out.push(`    ${c.install} --dry-run`)
  return out
}

export interface FindOptions { limit?: number }

export async function skillsFind(query: string, opts: FindOptions, ctx: WorkflowCtx): Promise<CmdResult> {
  const q = query.trim()
  const limit = opts.limit ?? DEFAULT_LIMIT
  const errors: string[] = []
  const lines: string[] = []

  const listed = await skillsList(ctx)
  const local = matchLocal(q, Array.isArray(listed.data['skills']) ? listed.data['skills'] as Array<Record<string, unknown>> : [])
  if (local.length === 0) lines.push(`No installed or shipped skill matches "${q}".`)
  else {
    lines.push(`Already here and matching "${q}" (check these before installing anything):`)
    const width = Math.max(...local.map(m => m.id.length))
    for (const m of local) lines.push(`  ${m.id.padEnd(width)}  ${m.source.padEnd(9)} ${(m.description ?? '').slice(0, 100)}`)
  }

  const search = await opsDeps.fetch(`${REGISTRY_SEARCH_URL}?q=${encodeURIComponent(q)}&limit=${limit}`, { timeoutMs: TIMEOUT_MS })
  const hits = search.ok ? parseRegistry(search.json) : undefined
  if (hits === undefined) {
    const why = search.ok ? 'unexpected response' : search.error ?? `HTTP ${search.status}`
    const message = `skills.sh did not answer (${why}); search the fallback sources by hand (anthropics/skills, GitHub SKILL.md files, the web)`
    return { code: 1, data: { ok: false, error: 'registry', message, query: q, local, candidates: [] }, lines, errors: [message] }
  }
  const top = hits.slice(0, limit)
  const sources = [...new Set(top.map(h => h.source))]

  const trees: TreeMemo = new Map()
  const [metas, risks, mds] = await Promise.all([
    Promise.all(sources.map(s => (isGitHubRepo(s) ? repoMeta(s, ctx.env) : Promise.resolve({ meta: null, rateLimited: false })))),
    Promise.all(sources.map(s => registryRisk(s, top.filter(h => h.source === s).map(h => h.skill)))),
    Promise.all(top.map(h => (isGitHubRepo(h.source) ? skillMd(h.source, h.skill, ctx.env, trees) : Promise.resolve({ md: null, rateLimited: false })))),
  ])
  const metaBySource = new Map(sources.map((s, i) => [s, metas[i] as { meta: RepoMeta | null, rateLimited: boolean }]))
  const riskBySource = new Map(sources.map((s, i) => [s, risks[i] as Map<string, { socket: string | null, snyk: string | null }>]))
  if ([...metaBySource.values()].some(m => m.rateLimited) || mds.some(m => m.rateLimited)) errors.push('GitHub API rate limit reached: license, stars, freshness or the description are missing for some candidates (set GITHUB_TOKEN to raise the limit, or read them on the repository page)')

  const candidates: FindCandidate[] = top.map((h, i) => {
    const meta = metaBySource.get(h.source)?.meta ?? null
    const md = mds[i]?.md ?? null
    return {
      rank: i + 1,
      id: h.id,
      source: h.source,
      skill: h.skill,
      installs: h.installs,
      description: md?.description ?? null,
      path: md?.path ?? null,
      license: meta?.license ?? md?.license ?? null,
      pushed_at: meta?.pushed_at ?? null,
      stars: meta?.stars ?? null,
      archived: meta?.archived ?? null,
      risk: riskBySource.get(h.source)?.get(h.skill) ?? null,
      allowed_tools: md?.allowed_tools ?? null,
      install: `buracle skills add ${h.source} --skill ${h.skill}`,
    }
  })

  if (candidates.length === 0) lines.push(`skills.sh has no skill for "${q}"; try other words, or the fallback sources (anthropics/skills, GitHub SKILL.md files, the web).`)
  else {
    lines.push(`skills.sh: ${hits.length >= limit ? `${limit}+` : String(hits.length)} results for "${q}", the top ${candidates.length} with license, freshness and risk:`)
    for (const c of candidates) lines.push(...candidateLines(c))
    lines.push('Next: pick one (vendor-owned, licensed, pushed recently, low risk), run its --dry-run line, read the checkout it prints, then run the same command without --dry-run.')
  }
  return { code: 0, data: { ok: true, query: q, local, candidates, warnings: errors }, lines, errors }
}
