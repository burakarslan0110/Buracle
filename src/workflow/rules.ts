import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { parseFrontmatter as parseYamlFrontmatter } from '../engine/canonical'
import { canonicalDir, repoRoot } from '../engine/paths'
import {
  checkBuracleMentions, checkHarnessBlocks, checkLinks, checkPlaceholders, formatFinding, scanMarkdown, sizeOf, summarize,
  type LintFinding,
} from './lint'
import type { CmdResult, WorkflowCtx } from './result'

export const ALWAYS_FILE_LINES = 200
export const ALWAYS_TOTAL_LINES = 500
export const ALWAYS_TOTAL_WORDS = 7500
const DOC_ID = /^[a-z0-9][a-z0-9._-]*$/

function list(dir: string): string[] {
  try { return readdirSync(dir).filter(n => n !== '.DS_Store').sort() } catch { return [] }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

export function globProblems(glob: string): string[] {
  const out: string[] = []
  if (glob.trim() === '') return ['empty glob']
  if (glob.startsWith('/') || /^[A-Za-z]:\\/.test(glob)) out.push('globs are relative to the project root; drop the leading slash')
  if (glob.includes('\\')) out.push('use forward slashes')
  let brace = 0
  let bracket = 0
  for (const c of glob) {
    if (c === '{') brace++
    else if (c === '}') brace--
    else if (c === '[') bracket++
    else if (c === ']') bracket--
    if (brace < 0 || bracket < 0) break
  }
  if (brace !== 0) out.push('unbalanced { }')
  if (bracket !== 0) out.push('unbalanced [ ]')
  return out
}

export interface RoutingData { servers: Set<string>, tools: Set<string>, routed: Set<string> }

function readYaml(path: string): unknown {
  try { return parseYaml(readFileSync(path, 'utf8')) as unknown } catch { return undefined }
}

export function loadRoutingData(rulesRoot: string): RoutingData | undefined {
  const sibling = resolve(rulesRoot, '..')
  const dir = existsSync(join(sibling, 'mcp.yaml')) && existsSync(join(sibling, 'routing.yaml')) ? sibling : canonicalDir()
  const mcp = readYaml(join(dir, 'mcp.yaml')) as { servers?: Record<string, unknown> } | undefined
  const tools = readYaml(join(dir, 'tools.yaml')) as { tools?: Array<{ name?: unknown }> } | undefined
  const routing = readYaml(join(dir, 'routing.yaml')) as { categories?: Array<{ prefer?: unknown[], fallback?: unknown[] }> } | undefined
  if (mcp?.servers === undefined || routing?.categories === undefined) return undefined
  const routed = new Set<string>()
  for (const c of routing.categories) {
    for (const e of [...(c.prefer ?? []), ...(c.fallback ?? [])]) {
      const m = typeof e === 'string' ? /^mcp:([^/\s]+)/.exec(e) : null
      if (m?.[1] !== undefined) routed.add(m[1])
    }
  }
  return {
    servers: new Set(Object.keys(mcp.servers)),
    tools: new Set((tools?.tools ?? []).map(t => t.name).filter((n): n is string => typeof n === 'string')),
    routed,
  }
}

function tableCells(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return t.replace(/\\\|/g, '\u0000').split('|').map(c => c.replace(/\u0000/g, '|').trim())
}

export function checkRoutingTable(file: string, text: string, data: RoutingData): LintFinding[] {
  const lines = text.split('\n')
  const out: LintFinding[] = []
  let found = false
  const named = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const head = tableCells(lines[i] ?? '').map(c => c.toLowerCase())
    if (!(head[0] === 'need' && head[1] === 'use first')) continue
    found = true
    for (let j = i + 2; j < lines.length && (lines[j] ?? '').trim().startsWith('|'); j++) {
      for (const cell of tableCells(lines[j] ?? '').slice(1)) {
        for (const m of cell.matchAll(/`([^`]+)`/g)) {
          const tok = (m[1] ?? '').trim()
          if (!/^[a-z][a-z0-9-]*$/.test(tok)) continue
          if (named.has(tok)) continue
          named.add(tok)
          if (!data.servers.has(tok) && !data.tools.has(tok)) {
            out.push({ level: 'error', code: 'routing-unknown', file, line: j + 1, message: `\`${tok}\` in the routing table is neither an MCP server of canonical/mcp.yaml nor a tool of canonical/tools.yaml` })
          }
        }
      }
    }
  }
  if (!found) return []
  for (const id of [...data.routed].sort()) {
    if (!named.has(id)) out.push({ level: 'error', code: 'routing-missing', file, message: `canonical/routing.yaml routes to the MCP server \`${id}\`, but the routing table never names it` })
  }
  return out
}

export function lintRulesDir(root: string, displayRoot: string): { findings: LintFinding[], counts: { always: number, paths: number, alwaysLines: number, alwaysWords: number } } {
  const out: LintFinding[] = []
  const show = (abs: string) => {
    const rel = relative(displayRoot, abs)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : abs
  }
  const where = 'rules'
  const noRelative = 'rules are installed away from their siblings (Claude rules dir, AGENTS.md block), so relative links do not resolve there'
  for (const n of list(root)) {
    if (n === 'always' || n === 'paths') continue
    out.push({ level: 'warning', code: 'unexpected-file', file: show(join(root, n)), message: 'only always/ and paths/ belong in canonical/rules' })
  }
  let alwaysLines = 0
  let alwaysWords = 0
  let alwaysCount = 0
  let pathsCount = 0
  let routingData: RoutingData | null | undefined
  for (const scope of ['always', 'paths'] as const) {
    const dir = join(root, scope)
    if (!isDir(dir)) continue
    for (const n of list(dir)) {
      const abs = join(dir, n)
      const file = show(abs)
      if (isDir(abs)) { out.push({ level: 'warning', code: 'unexpected-file', file, message: `rules/${scope}/ holds Markdown files only (subfolders are not loaded)` }); continue }
      if (!n.endsWith('.md')) { out.push({ level: 'warning', code: 'unexpected-file', file, message: `rules/${scope}/ holds Markdown files only` }); continue }
      const id = n.slice(0, -3)
      if (!DOC_ID.test(id)) out.push({ level: 'error', code: 'rule-id', file, message: `rule file name must match ${DOC_ID.source}` })
      let text: string
      try { text = readFileSync(abs, 'utf8') } catch (e) { out.push({ level: 'error', code: 'rule-unreadable', file, message: String(e) }); continue }
      if (text.includes('\r\n')) out.push({ level: 'warning', code: 'crlf', file, message: 'use LF line endings' })
      const hasFm = /^﻿?---[ \t]*\r?\n/.test(text)
      let body = text
      if (scope === 'always') {
        alwaysCount++
        if (hasFm) out.push({ level: 'error', code: 'always-frontmatter', file, line: 1, message: 'always-on rules take no frontmatter (a paths: key would make the rule path-scoped in Claude Code)' })
        const size = sizeOf(text)
        alwaysLines += size.lines
        alwaysWords += size.words
        if (size.lines > ALWAYS_FILE_LINES) out.push({ level: 'error', code: 'rule-file-lines', file, message: `${size.lines} lines; an always-on rule file may have at most ${ALWAYS_FILE_LINES}` })
      } else {
        pathsCount++
        if (!hasFm) {
          out.push({ level: 'error', code: 'paths-frontmatter', file, line: 1, message: 'path rules need frontmatter with paths: ["<glob>", …]' })
        } else {
          try {
            const parsed = parseYamlFrontmatter(text)
            body = parsed.body
            const fm = parsed.frontmatter
            for (const k of Object.keys(fm)) if (k !== 'paths') out.push({ level: 'error', code: 'frontmatter-unknown-key', file, line: 1, message: `unknown frontmatter key '${k}' (path rules take only paths)` })
            const paths = fm['paths']
            if (!Array.isArray(paths) || paths.length === 0 || !paths.every(p => typeof p === 'string')) {
              out.push({ level: 'error', code: 'paths-frontmatter', file, line: 1, message: "'paths' must be a non-empty list of glob strings" })
            } else {
              const seen = new Set<string>()
              for (const g of paths as string[]) {
                if (seen.has(g)) out.push({ level: 'warning', code: 'glob-duplicate', file, line: 1, message: `glob '${g}' is listed twice` })
                seen.add(g)
                for (const p of globProblems(g)) out.push({ level: 'error', code: 'glob-invalid', file, line: 1, message: `glob '${g}': ${p}` })
              }
            }
          } catch (e) {
            out.push({ level: 'error', code: 'frontmatter-parse', file, line: 1, message: `frontmatter does not parse as YAML: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` })
          }
        }
        const size = sizeOf(text)
        if (size.lines > ALWAYS_FILE_LINES) out.push({ level: 'warning', code: 'rule-file-lines', file, message: `${size.lines} lines; keep a path rule under ${ALWAYS_FILE_LINES} lines` })
      }
      if (body.trim() === '') out.push({ level: 'error', code: 'rule-empty', file, message: 'the rule has no content' })
      const scan = scanMarkdown(text)
      out.push(...checkPlaceholders(file, scan, null, where))
      out.push(...checkHarnessBlocks(file, scan, false, where))
      out.push(...checkBuracleMentions(file, scan))
      out.push(...checkLinks(file, abs, scan, { noRelative }))
      if (scope === 'always' && /^\|\s*Need\s*\|\s*Use first\s*\|/im.test(text)) {
        routingData ??= loadRoutingData(root) ?? null
        if (routingData !== null) out.push(...checkRoutingTable(file, text, routingData))
      }
    }
  }
  const alwaysDir = show(join(root, 'always'))
  if (alwaysLines > ALWAYS_TOTAL_LINES) out.push({ level: 'error', code: 'always-budget', file: alwaysDir, message: `always-on rules total ${alwaysLines} lines; the budget is ${ALWAYS_TOTAL_LINES}` })
  if (alwaysWords > ALWAYS_TOTAL_WORDS) out.push({ level: 'error', code: 'always-budget', file: alwaysDir, message: `always-on rules total ${alwaysWords} words; the budget is ${ALWAYS_TOTAL_WORDS}` })
  return { findings: out, counts: { always: alwaysCount, paths: pathsCount, alwaysLines, alwaysWords } }
}

export function rulesLint(dirArg: string | undefined, strict: boolean, ctx: WorkflowCtx): CmdResult {
  const root = dirArg !== undefined ? resolve(ctx.cwd, dirArg) : join(canonicalDir(), 'rules')
  const display = dirArg !== undefined ? ctx.cwd : repoRoot()
  if (!isDir(root)) return { code: 1, data: { ok: false, error: 'not_found', message: `rules directory not found: ${root}` }, lines: [], errors: [`rules directory not found: ${root}`] }
  const { findings, counts } = lintRulesDir(root, display)
  const report = summarize(findings)
  const code = report.errors > 0 ? 1 : strict && report.warnings > 0 ? 2 : 0
  const lines = report.findings.map(formatFinding)
  lines.push(`${counts.always} always-on rule(s) (${counts.alwaysLines}/${ALWAYS_TOTAL_LINES} lines, ${counts.alwaysWords}/${ALWAYS_TOTAL_WORDS} words), ${counts.paths} path rule(s): ${report.errors} error(s), ${report.warnings} warning(s)`)
  return { code, data: { ok: code === 0, always: counts.always, paths: counts.paths, budget: { lines: counts.alwaysLines, maxLines: ALWAYS_TOTAL_LINES, words: counts.alwaysWords, maxWords: ALWAYS_TOTAL_WORDS }, errors: report.errors, warnings: report.warnings, findings: report.findings }, lines, errors: [] }
}
