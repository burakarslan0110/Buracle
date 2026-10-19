import type { CanonicalBundle, RuleDoc } from '../../core/catalog'
import { ruleGlobs } from '../../core/policy/path-rules'
import { renderMarkdown } from './render'

export const PATH_RULES_OWNER = 'core'

export function pathGlobs(rule: RuleDoc): string[] {
  return ruleGlobs(rule.frontmatter)
}

export function pathRuleFile(rule: RuleDoc, opts: { skills?: readonly string[], agents?: readonly string[] } = {}, warnings: string[] = []): string {
  const globs = pathGlobs(rule)
  const fm = globs.length > 0 ? `---\npaths:\n${globs.map(g => `  - ${JSON.stringify(g)}`).join('\n')}\n---\n` : ''
  const body = renderMarkdown(rule.body, 'neutral', { ...opts, file: rule.file }, warnings)
  return fm + body.replace(/^\n+/, '')
}

export interface PathRuleOutput { id: string, file: string, content: string }

export function pathRuleFiles(canonical: Pick<CanonicalBundle, 'rules' | 'skills' | 'agents'>, warnings: string[] = []): PathRuleOutput[] {
  const refs = { skills: canonical.skills.map(s => s.id), agents: canonical.agents.map(a => a.id) }
  return canonical.rules
    .filter(r => r.scope === 'paths')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(r => ({ id: r.id, file: `${r.id}.md`, content: pathRuleFile(r, refs, warnings) }))
}
