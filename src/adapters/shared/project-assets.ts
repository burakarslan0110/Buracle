import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { Harness } from '../../core/events'
import {
  assetsContextText, claudeImportNote, claudeOnlySkillNote, claudeParityText, DOT_CLAUDE_MD, indexEditNote, ruleEditNote, ruleParity,
} from '../../core/project-assets'
import { sha256 } from '../../engine/fsx'
import { log } from '../../engine/log'
import * as paths from '../../engine/paths'
import { spawnArgv } from '../../engine/platform'
import { buracleArgv } from '../../usage/bar-info'
import { nonProjectReason } from '../../workflow/non-project'
import {
  assetLayout, assetsContextFacts, claudeOnlySkills, claudeRouting, linkWorkPending, readRuleIndex, realOr, ruleFacts, rulesParity, within,
} from '../../workflow/project-assets'

export type AssetsSpawner = (argv: string[], cwd: string) => void

export interface AssetsHookOptions {
  nowMs: number
  spawn?: AssetsSpawner
  argv?: string[] | undefined
}

export function assetsOptions(nowMs: number, spawn?: AssetsSpawner): AssetsHookOptions {
  return spawn !== undefined ? { nowMs, spawn } : { nowMs }
}

export const ASSETS_SPAWN_THROTTLE_MS = 30_000
export const ASSETS_CONTEXT_TTL_MS = 60_000
const CONTEXT_CACHE_MAX = 64

const spawnDetached: AssetsSpawner = (argv, cwd) => {
  const child = Bun.spawn(spawnArgv(argv), { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true, cwd, env: { ...process.env } })
  child.unref()
}

export function assetsRoot(root: string | undefined): string | undefined {
  if (root === undefined || root === '' || !existsSync(root)) return undefined
  const real = realOr(root)
  return nonProjectReason(real) === undefined ? real : undefined
}

function markerFile(root: string): string {
  return join(paths.stateDir(), 'project-assets', `${sha256(root).slice(0, 16)}.spawn`)
}

function throttled(root: string, nowMs: number): boolean {
  const file = markerFile(root)
  try {
    const age = nowMs - statSync(file).mtimeMs
    if (age >= 0 && age < ASSETS_SPAWN_THROTTLE_MS) return true
  } catch {  }
  try {
    mkdirSync(join(paths.stateDir(), 'project-assets'), { recursive: true })
    writeFileSync(file, String(nowMs))
    const t = new Date(nowMs)
    utimesSync(file, t, t)
  } catch { return false }
  return false
}

export function startLinkRun(rootIn: string | undefined, o: AssetsHookOptions): boolean {
  try {
    const root = assetsRoot(rootIn)
    if (root === undefined) return false
    const spawn = o.spawn ?? (process.env['BURACLE_NO_AUTOSTART'] === '1' ? undefined : spawnDetached)
    if (spawn === undefined || !linkWorkPending(root)) return false
    const argv = o.argv ?? buracleArgv()
    if (argv === undefined || throttled(root, o.nowMs)) return false
    spawn([...argv, 'project', 'sync', '--auto', '--quiet'], root)
    return true
  } catch (e) {
    log('warn', 'project assets: could not start the link run', { root: rootIn, error: e })
    return false
  }
}

export function assetsContext(rootIn: string | undefined, harness: Harness): string {
  try {
    const root = assetsRoot(rootIn)
    if (root === undefined) return ''
    if (harness === 'claude') return existsSync(join(root, 'AGENTS.md')) ? claudeParityText(rulesParity(root, ignoredRules(root))) : ''
    const facts = assetsContextFacts(root)
    return assetsContextText({ harness, rules: facts.rules, claudeOnly: facts.claudeOnly })
  } catch (e) {
    log('warn', 'project assets: the session-start context failed', { root: rootIn, error: e })
    return ''
  }
}

export function assetsSessionStart(root: string | undefined, harness: Harness, o: AssetsHookOptions): string {
  startLinkRun(root, o)
  return assetsContext(root, harness)
}

interface Cached { at: number; text: string }
const CONTEXT_KEY = Symbol.for('buracle.project-assets.context')

function contextCache(): Map<string, Cached> {
  const g = globalThis as unknown as Record<symbol, unknown>
  let m = g[CONTEXT_KEY]
  if (!(m instanceof Map)) { m = new Map<string, Cached>(); g[CONTEXT_KEY] = m }
  return m as Map<string, Cached>
}

export function assetsContextCached(root: string | undefined, harness: Harness, nowMs: number): string {
  if (root === undefined || harness === 'claude') return ''
  const key = `${harness}\0${root}`
  const map = contextCache()
  const hit = map.get(key)
  if (hit !== undefined && nowMs - hit.at >= 0 && nowMs - hit.at < ASSETS_CONTEXT_TTL_MS) return hit.text
  const text = assetsContext(root, harness)
  if (map.size >= CONTEXT_CACHE_MAX) map.clear()
  map.set(key, { at: nowMs, text })
  return text
}

export function clearAssetsContextCache(): void {
  contextCache().clear()
}

function ignoredRules(root: string): Set<string> {
  try {
    const r = Bun.spawnSync(['git', 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', '.claude/rules'], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
    if (r.exitCode !== 0) return new Set()
    return new Set(r.stdout.toString().split('\0').map(s => s.trim()).filter(s => s !== ''))
  } catch { return new Set() }
}

function realPathOf(file: string): string {
  const rest: string[] = []
  let dir = resolve(file)
  while (!existsSync(dir)) {
    const parent = dirname(dir)
    if (parent === dir) return resolve(file)
    rest.unshift(basename(dir))
    dir = parent
  }
  return join(realOr(dir), ...rest)
}

const CLAUDE_SKILL_MD = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/

function relIn(root: string, file: string): string | undefined {
  const abs = realPathOf(file)
  if (!within(root, abs)) return undefined
  return relative(root, abs).split(sep).join('/')
}

export function assetsAfterEdit(rootIn: string | undefined, files: readonly string[], o: AssetsHookOptions): string | undefined {
  try {
    const root = assetsRoot(rootIn)
    if (root === undefined) return undefined
    const rels = files.flatMap(f => { const r = relIn(root, f); return r !== undefined ? [r] : [] })
    if (rels.length === 0) return undefined
    if (rels.some(r => r.startsWith('.agents/skills/') || r.startsWith('.claude/skills/'))) startLinkRun(root, o)
    const notes: string[] = []
    const claudeSkillIds = [...new Set(rels.flatMap(r => { const id = CLAUDE_SKILL_MD.exec(r)?.[1]; return id !== undefined ? [id] : [] }))]
    if (claudeSkillIds.length > 0) {
      const only = new Set(claudeOnlySkills(assetLayout(root)).map(s => s.id))
      for (const id of claudeSkillIds) if (only.has(id)) notes.push(claudeOnlySkillNote(id))
    }
    const claudeFiles = rels.filter(r => r === 'CLAUDE.md' || r === 'CLAUDE.local.md' || r === DOT_CLAUDE_MD)
    if (claudeFiles.length > 0 && existsSync(join(root, 'AGENTS.md'))) {
      const routing = claudeRouting(root)
      const dot = routing.find(c => c.name === DOT_CLAUDE_MD)
      if (claudeFiles.includes(DOT_CLAUDE_MD) && dot !== undefined && !dot.importsAgents) notes.push(claudeImportNote(DOT_CLAUDE_MD))
      else if (routing.length > 0 && !routing.some(c => c.importsAgents)) notes.push(claudeImportNote(claudeFiles[0] as string))
    }
    const ruleRels = rels.filter(r => r.startsWith('.claude/rules/') && r.toLowerCase().endsWith('.md') && !r.toLowerCase().endsWith('/readme.md'))
    const agentsEdited = rels.includes('AGENTS.md')
    if (ruleRels.length > 0 || agentsEdited) {
      const index = readRuleIndex(root)
      if (index.exists) {
        const rules = ruleFacts(root, ignoredRules(root))
        if (agentsEdited) {
          const n = indexEditNote(ruleParity(rules, index))
          if (n !== undefined) notes.push(n)
        } else {
          const gone: string[] = []
          for (const rel of ruleRels) {
            const rule = rules.find(r => r.path === rel)
            if (rule === undefined && !existsSync(join(root, ...rel.split('/')))) gone.push(rel)
            const n = rule !== undefined ? ruleEditNote(rule, index) : undefined
            if (n !== undefined) notes.push(n)
          }
          if (gone.length > 0) {
            const n = indexEditNote(ruleParity([], { found: index.found, entries: index.entries.filter(e => gone.includes(e.path)) }))
            if (n !== undefined) notes.push(n)
          }
        }
      }
    }
    return notes.length > 0 ? notes.join('\n\n') : undefined
  } catch (e) {
    log('warn', 'project assets: the after-edit check failed', { root: rootIn, error: e })
    return undefined
  }
}
