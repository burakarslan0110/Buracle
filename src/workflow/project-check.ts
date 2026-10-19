import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentsImportLine, DOT_CLAUDE_MD, indexLine, ruleParity, SCOPED_RULES_HEADING, type ClaudeOnlySkill, type GlobMismatch, type RuleFacts, type ScopedRuleEntry,
} from '../core/project-assets'
import { parseFrontmatter as parseYamlFrontmatter } from '../engine/canonical'
import { git, type RepoFacts } from './gitx'
import {
  agentSkills, assetLayout, claudeOnlySkills, claudeRouting, claudeSkills, linkPlan, readRuleIndex, realOr, ruleFacts, ruleFiles,
  type ClaudeFileRouting,
} from './project-assets'
import { globProblems } from './rules'

export type AgentProblemKind = 'rules' | 'links' | 'skills' | 'claude-md' | 'layout' | 'agents-md'

export interface AgentProblem { level: 'drift' | 'note'; kind: AgentProblemKind; message: string }

export interface AgentFilesAudit {
  agentsMd: boolean
  rules: {
    count: number
    indexFound: boolean
    unindexed: RuleFacts[]
    private: string[]
    privateIndexed: string[]
    mismatched: GlobMismatch[]
    dangling: ScopedRuleEntry[]
    invalid: RuleFacts[]
  }
  links: {
    missing: string[]
    stale: string[]
    conflicts: Array<{ id: string; path: string; reason: string }>
    claudeOnly: ClaudeOnlySkill[]
    claudeOwned: string[]
    alias: boolean
    blocked: string[]
  }
  claudeMd: ClaudeFileRouting[]
  problems: AgentProblem[]
}

async function privateRules(root: string, facts: RepoFacts | undefined): Promise<Set<string>> {
  if (facts === undefined) return new Set()
  const r = await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', '.claude/rules'], { readOnly: true })
  if (!r.ok) return new Set()
  return new Set(r.stdout.split('\0').map(s => s.trim()).filter(s => s !== ''))
}

function strictProblems(root: string, rule: RuleFacts): string | undefined {
  let text: string
  try { text = readFileSync(join(root, ...rule.path.split('/')), 'utf8') } catch { return 'could not be read' }
  try { parseYamlFrontmatter(text) } catch (e) { return `frontmatter that does not parse as YAML (${e instanceof Error ? e.message.split('\n')[0] : String(e)}), so Claude Code loads it as if it had no \`paths:\`` }
  const bad = rule.globs.flatMap(g => globProblems(g).map(p => `\`${g}\`: ${p}`))
  return bad.length > 0 ? `glob problems: ${bad.join('; ')}` : undefined
}

function globList(globs: readonly string[]): string {
  return globs.length > 0 ? globs.map(g => `\`${g}\``).join(', ') : 'no globs'
}

export async function auditAgentFiles(rootIn: string, facts: RepoFacts | undefined): Promise<AgentFilesAudit> {
  const root = realOr(rootIn)
  const priv = ruleFiles(root).length > 0 ? await privateRules(root, facts) : new Set<string>()
  const rules = ruleFacts(root, priv).map(r => {
    if (r.problem !== undefined) return r
    const strict = strictProblems(root, r)
    return strict !== undefined ? { ...r, problem: strict } : r
  })
  const index = readRuleIndex(root)
  const parity = ruleParity(rules, index)
  const layout = assetLayout(root)
  const agents = agentSkills(layout)
  const claude = claudeSkills(layout)
  const plan = linkPlan(layout, agents, claude)
  const routing = claudeRouting(root)
  const problems: AgentProblem[] = []
  const drift = (kind: AgentProblemKind, message: string): void => { problems.push({ level: 'drift', kind, message }) }
  const note = (kind: AgentProblemKind, message: string): void => { problems.push({ level: 'note', kind, message }) }

  if (!index.exists) drift('agents-md', `${root} has no AGENTS.md; create it with the project-rules workflow (\`/project-rules\`, Codex: \`$project-rules\`)`)
  else if (rules.some(r => r.private !== true) && !index.found) drift('rules', `AGENTS.md has no \`## ${SCOPED_RULES_HEADING}\` list, so Codex, OpenCode and omp never find the path rules in .claude/rules`)
  for (const r of parity.unindexed) if (index.found || !index.exists) drift('rules', `${r.path} is not in AGENTS.md's \`## ${SCOPED_RULES_HEADING}\` list; add ${indexLine(r)}`)
  for (const m of parity.mismatched) drift('rules', `${m.path}: the \`## ${SCOPED_RULES_HEADING}\` line names ${globList(m.index)}, but its \`paths:\` are ${globList(m.rule)}`)
  for (const d of parity.dangling) drift('rules', `AGENTS.md:${d.line} lists ${d.path}, which does not exist`)
  for (const r of parity.invalid) drift('rules', `${r.path} has ${r.problem ?? 'a problem'}`)
  for (const p of parity.privateIndexed) note('rules', `${p} is gitignored but AGENTS.md lists it; teammates do not have that file`)
  if (parity.privateUnindexed.length > 0) note('rules', `${parity.privateUnindexed.length} gitignored rule(s) stay out of the tracked index; Buracle lists them for Codex, OpenCode and omp at session start (H28): ${parity.privateUnindexed.map(r => r.path).join(', ')}`)

  for (const b of layout.blocked) drift('layout', b)
  for (const c of plan.create) drift('links', `.claude/skills/${c.id} is missing, so Claude Code does not see .agents/skills/${c.id}`)
  for (const r of plan.remove) drift('links', `.claude/skills/${r.id} points to a skill that no longer exists`)
  for (const c of plan.conflicts) note('links', `.claude/skills/${c.id}: ${c.reason}`)
  for (const s of plan.skipped) note('links', `.agents/skills/${s.id} skipped: ${s.reason}`)
  const claudeOnly = claudeOnlySkills(layout, agents, claude)
  if (claudeOnly.length > 0) note('skills', `Claude-only skills Codex cannot see (they live only in .claude/skills): ${claudeOnly.map(s => s.id).join(', ')}; \`buracle project sync --adopt\` links them for Codex`)

  const anyImport = routing.some(c => c.importsAgents)
  const dot = routing.find(c => c.name === DOT_CLAUDE_MD)
  const top = routing.filter(c => c.name !== DOT_CLAUDE_MD)
  if (index.exists && routing.length > 0 && !anyImport) {
    const target = top.length > 0 ? 'CLAUDE.md' : DOT_CLAUDE_MD
    drift('claude-md', `Claude Code reads ${routing.map(c => c.name).join(' and ')} instead of AGENTS.md; add the line '${agentsImportLine(target)}' to ${target} (the project-rules skill does this)`)
  }
  if (index.exists && dot !== undefined && !dot.importsAgents && top.length > 0) drift('claude-md', `omp reads ${DOT_CLAUDE_MD} instead of the root AGENTS.md; add the line '${agentsImportLine(DOT_CLAUDE_MD)}' to ${DOT_CLAUDE_MD}`)
  for (const c of routing) if (c.outside !== undefined) note('layout', `${c.name} is a symlink to ${c.outside}, outside the repository`)

  return {
    agentsMd: index.exists,
    rules: {
      count: rules.length,
      indexFound: index.found,
      unindexed: parity.unindexed,
      private: parity.privateUnindexed.map(r => r.path).concat(parity.privateIndexed).sort(),
      privateIndexed: parity.privateIndexed,
      mismatched: parity.mismatched,
      dangling: parity.dangling,
      invalid: parity.invalid,
    },
    links: {
      missing: plan.create.map(c => c.id),
      stale: plan.remove.map(r => r.id),
      conflicts: plan.conflicts,
      claudeOnly,
      claudeOwned: plan.claudeOwned,
      alias: layout.alias,
      blocked: layout.blocked,
    },
    claudeMd: routing,
    problems,
  }
}
