import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Harness } from '../../core/events'
import { HARNESSES } from '../../core/events'
import { parseFrontmatter } from '../../engine/canonical'
import { loadConfigSync } from '../../engine/config'
import { mdBlockGet } from '../../engine/merge'
import * as paths from '../../engine/paths'
import { tilde } from '../../engine/update/output'
import type { LintFinding } from '../../workflow/lint'
import { claudeSkillLink, installedSkillDir } from '../../workflow/skill-install'
import { lintProjectSkill, skillsLint, skillsList } from '../../workflow/skills'
import { projectRoot } from '../project'
import type { UiScope } from './api'

export type Reach = 'ok' | 'missing' | 'off'

const CODEX_BLOCK = 'buracle'
const OPENCODE_BLOCK = 'rules'

function enabledHarnesses(): Record<Harness, boolean> {
  try {
    const c = loadConfigSync().config
    return Object.fromEntries(HARNESSES.map(h => [h, c.harnesses[h].enabled])) as Record<Harness, boolean>
  } catch {
    return { claude: true, codex: true, opencode: true, omp: true }
  }
}

function reach(enabled: Record<Harness, boolean>, has: (h: Harness) => boolean): Record<Harness, Reach> {
  return Object.fromEntries(HARNESSES.map(h => [h, enabled[h] ? (has(h) ? 'ok' : 'missing') : 'off'])) as Record<Harness, Reach>
}

function lintCounts(findings: readonly LintFinding[]): { errors: number, warnings: number, first?: string } {
  const errors = findings.filter(f => f.level === 'error')
  const warnings = findings.filter(f => f.level !== 'error')
  const top = errors[0] ?? warnings[0]
  return { errors: errors.length, warnings: warnings.length, ...(top !== undefined ? { first: top.message } : {}) }
}

function shown(root: string, abs: string): string {
  const rel = relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : abs
}

function describe(file: string): string | undefined {
  try {
    const d = parseFrontmatter(readFileSync(file, 'utf8')).frontmatter['description']
    return typeof d === 'string' ? d.replace(/\s+/g, ' ').trim() : undefined
  } catch { return undefined }
}

function mdFiles(dir: string): string[] {
  try { return readdirSync(dir).filter(n => n.endsWith('.md') && !n.startsWith('.')).sort() } catch { return [] }
}

function textOf(file: string): string {
  try { return readFileSync(file, 'utf8') } catch { return '' }
}

async function skillsPart(scope: UiScope, enabled: Record<Harness, boolean>, nowMs: number): Promise<Array<Record<string, unknown>>> {
  const repo = paths.repoRoot()
  const root = scope.kind === 'project' ? projectRoot(scope.slug) : undefined
  const ctx = { cwd: root ?? paths.home(), now: nowMs, env: process.env }
  const listed = (await skillsList(ctx)).data['skills'] as Array<Record<string, unknown>> | undefined
  const lint = (skillsLint([], false, { ...ctx, cwd: repo }).data['findings'] as LintFinding[] | undefined) ?? []
  const shared = join(paths.agentsDir(), 'skills')
  const out: Array<Record<string, unknown>> = []
  for (const s of listed ?? []) {
    const id = String(s['id'])
    const kind = String(s['kind'])
    const dir = typeof s['path'] === 'string' ? s['path'] : ''
    const entry: Record<string, unknown> = { id, source: String(s['source']), kind, path: tilde(dir) }
    for (const k of ['description', 'invocation', 'error'] as const) if (typeof s[k] === 'string') entry[k] = s[k]
    if (s['edited'] === true) entry['edited'] = true
    if (s['duplicate'] === true) entry['duplicate'] = true
    if (kind === 'canonical' || kind === 'user') {
      if (s['source'] === 'installed') {
        entry['where'] = reach(enabled, h => h === 'claude' ? existsSync(join(claudeSkillLink(id), 'SKILL.md')) : existsSync(join(installedSkillDir(id), 'SKILL.md')))
      } else {
        const base = shown(repo, dir)
        entry['lint'] = lintCounts(lint.filter(f => f.file === base || f.file.startsWith(`${base}/`)))
        entry['where'] = reach(enabled, h => h === 'claude' ? existsSync(join(repo, 'harness', 'claude', 'skills', id, 'SKILL.md')) : existsSync(join(shared, id, 'SKILL.md')))
      }
    } else if (kind === 'project' && root !== undefined) {
      entry['lint'] = lintCounts(lintProjectSkill(dir, root))
      entry['where'] = reach(enabled, h => h === 'claude' ? existsSync(join(root, '.claude', 'skills', id, 'SKILL.md')) : existsSync(join(dir, 'SKILL.md')))
    } else {
      const reads = new Set(Array.isArray(s['harnesses']) ? (s['harnesses'] as string[]) : [])
      entry['where'] = reach(enabled, h => reads.has(h))
    }
    out.push(entry)
  }
  return out
}

function agentsPart(enabled: Record<Harness, boolean>): Array<Record<string, unknown>> {
  const repo = paths.repoRoot()
  return mdFiles(join(paths.canonicalDir(), 'agents')).map(f => {
    const id = f.slice(0, -3)
    const description = describe(join(paths.canonicalDir(), 'agents', f))
    const where = reach(enabled, h => existsSync(
      h === 'claude' ? join(repo, 'harness', 'claude', 'agents', f)
        : h === 'codex' ? join(paths.codexHome(), 'agents', `${id}.toml`)
          : h === 'opencode' ? join(paths.opencodeConfigDir(), 'agents', f)
            : join(repo, 'harness', 'omp', 'agents', f)))
    return { id, ...(description !== undefined ? { description } : {}), where }
  })
}

function title(text: string): string | undefined {
  const m = /^#\s+(.+)$/m.exec(text)
  return m?.[1]?.trim()
}

function rulesPart(enabled: Record<Harness, boolean>): Array<Record<string, unknown>> {
  const repo = paths.repoRoot()
  const codexBlock = mdBlockGet(textOf(join(paths.codexHome(), 'AGENTS.md')), CODEX_BLOCK) ?? ''
  const opencodeBlock = mdBlockGet(textOf(join(paths.opencodeConfigDir(), 'AGENTS.md')), OPENCODE_BLOCK) ?? ''
  const out: Array<Record<string, unknown>> = []
  for (const scope of ['always', 'paths'] as const) {
    for (const f of mdFiles(join(paths.canonicalDir(), 'rules', scope))) {
      const id = f.slice(0, -3)
      const text = textOf(join(paths.canonicalDir(), 'rules', scope, f))
      let globs: string[] = []
      try {
        const p = parseFrontmatter(text).frontmatter['paths']
        if (Array.isArray(p)) globs = p.filter((x): x is string => typeof x === 'string')
      } catch {  }
      const head = title(parseFrontmatter(text).body) ?? id
      const shared = existsSync(join(paths.pathRulesDir(), f))
      const where = reach(enabled, h => {
        if (h === 'claude') return existsSync(join(paths.claudeDir(), 'rules', 'buracle', scope, f))
        if (h === 'omp') return existsSync(join(repo, 'harness', 'omp', 'rules', `buracle-${f}`))
        const block = h === 'codex' ? codexBlock : opencodeBlock
        return scope === 'always' ? block.includes(`# ${head}`) : shared && block.includes(`/${f}`)
      })
      out.push({ id, scope, title: head, ...(globs.length > 0 ? { paths: globs } : {}), where })
    }
  }
  return out
}

export async function extensionsPayload(scope: UiScope, nowMs: number): Promise<Record<string, unknown>> {
  const enabled = enabledHarnesses()
  return {
    scope: scope.key,
    harnesses: enabled,
    skills: await skillsPart(scope, enabled, nowMs),
    agents: agentsPart(enabled),
    rules: rulesPart(enabled),
  }
}
