import type { FmData, FmValue } from '../frontmatter'
import { parseYamlBlock, renderYamlBlock } from '../frontmatter'
import { authoringFindings, type PlanOutline } from './authoring'

export type PlanStatus = 'PENDING' | 'APPROVED' | 'IN_PROGRESS' | 'COMPLETE' | 'VERIFIED' | 'SAVED'
export type PlanType = 'Feature' | 'Bugfix' | 'Build' | 'Plan'
export interface PlanHeader { created: string; status: PlanStatus; approved: boolean; worktree: boolean; type: PlanType; iterations?: number; rounds?: number }
export interface PlanTask { n: number; title: string; done: boolean; objective?: string; files: Array<{ verb: 'Create'|'Modify'|'Delete'|'Rename'|'Test', path: string }>; dod?: string }
export interface Plan { header: PlanHeader; title: string; tasks: PlanTask[]; sections: string[] }
export interface Finding { level: 'error' | 'warning' | 'info'; code: string; message: string; line?: number }

export const PLAN_STATUSES: readonly PlanStatus[] = ['PENDING', 'APPROVED', 'IN_PROGRESS', 'COMPLETE', 'VERIFIED', 'SAVED']
export const PLAN_TYPES: readonly PlanType[] = ['Feature', 'Bugfix', 'Build', 'Plan']
export const FILE_VERBS = ['Create', 'Modify', 'Delete', 'Rename', 'Test'] as const
type FileVerb = typeof FILE_VERBS[number]

interface Heading { level: number; text: string; line: number }
interface Card { n: number; title: string; head: number; end: number }
interface Doc {
  lines: string[]
  hasFrontmatter: boolean
  fm: FmData
  fmEnd: number
  body: number
  code: boolean[]
  headings: Heading[]
  title?: Heading
  sections: Heading[]
  tasks?: { head: number, end: number }
  cards: Card[]
  badTaskHeadings: Array<{ line: number, text: string }>
  duplicateTasks: number[]
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const TASK_HEADING = /^Task\s+(\d+)\s*[:.\-–—]\s*(.*)$/i
const CHECKBOX = /^\s*[-*+]\s+\[([ xX])\]\s+Task\s+(\d+)\s+done\b/i
const LABEL = /^\s*\*\*([^*]+?)\*\*\s*(.*)$/
const LIST_ITEM = /^\s*[-*+]\s+(.*)$/
const PLACEHOLDER = /\b(TBD|TODO|FIXME)\b/

function scan(markdown: string): Doc {
  const lines = markdown.replace(/^﻿/, '').split(/\r\n|\r|\n/)
  let fmEnd = -1
  if (/^---[ \t]*$/.test(lines[0] ?? '')) {
    for (let i = 1; i < lines.length; i++) if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[i] ?? '')) { fmEnd = i; break }
  }
  const hasFrontmatter = fmEnd > 0
  const fm = hasFrontmatter ? parseYamlBlock(lines.slice(1, fmEnd)) : {}
  const body = hasFrontmatter ? fmEnd + 1 : 0
  const code: boolean[] = new Array<boolean>(lines.length).fill(false)
  const headings: Heading[] = []
  let fence: string | undefined
  for (let i = body; i < lines.length; i++) {
    const line = lines[i] as string
    const f = FENCE.exec(line)
    if (fence !== undefined) {
      code[i] = true
      if (f && (f[1] as string)[0] === fence[0] && (f[1] as string).length >= fence.length && line.trim() === f[1]) fence = undefined
      continue
    }
    if (f) { fence = f[1] as string; code[i] = true; continue }
    const h = HEADING.exec(line)
    if (h) headings.push({ level: (h[1] as string).length, text: (h[2] as string).trim(), line: i })
  }
  const doc: Doc = { lines, hasFrontmatter, fm, fmEnd, body, code, headings, sections: [], cards: [], badTaskHeadings: [], duplicateTasks: [] }
  doc.title = headings.find(h => h.level === 1)
  doc.sections = headings.filter(h => h.level === 2)
  const taskSections = doc.sections.filter(h => h.text.toLowerCase() === 'tasks')
  const ts = taskSections[0]
  doc.duplicateTasks = taskSections.slice(1).map(h => h.line)
  if (ts) {
    const next = headings.find(h => h.line > ts.line && h.level <= 2)
    doc.tasks = { head: ts.line, end: next ? next.line : lines.length }
    const inner = headings.filter(h => h.line > ts.line && h.line < (doc.tasks as { end: number }).end && h.level === 3)
    for (const [k, h] of inner.entries()) {
      const nextH = inner[k + 1]
      const end = nextH ? nextH.line : (doc.tasks as { end: number }).end
      const m = TASK_HEADING.exec(h.text)
      if (m) doc.cards.push({ n: Number(m[1]), title: (m[2] as string).trim(), head: h.line, end })
      else if (/^task\b/i.test(h.text)) doc.badTaskHeadings.push({ line: h.line, text: h.text })
    }
  }
  return doc
}

interface CardBody {
  task: PlanTask
  hasObjective: boolean
  hasFiles: boolean
  hasDod: boolean
  verify: boolean
  badFiles: Array<{ line: number, text: string }>
  checkbox?: { n: number, line: number }
  prose: number[]
}

function stripCode(s: string): string {
  return s.replace(/`[^`]*`/g, '``')
}

function readCard(doc: Doc, card: Card): CardBody {
  let block: 'objective' | 'files' | 'dod' | 'other' | undefined
  const objective: string[] = []
  const dod: string[] = []
  const files: PlanTask['files'] = []
  const badFiles: Array<{ line: number, text: string }> = []
  let hasObjective = false
  let hasFiles = false
  let hasDod = false
  let verify = false
  let checkbox: { n: number, line: number, done: boolean } | undefined
  const prose: number[] = []
  for (let i = card.head + 1; i < card.end; i++) {
    const line = doc.lines[i] as string
    if (doc.code[i]) { if (block === 'dod') { dod.push(line); prose.push(i) } continue }
    const cb = CHECKBOX.exec(line)
    if (cb) {
      if (!checkbox || Number(cb[2]) === card.n) checkbox = { n: Number(cb[2]), line: i, done: (cb[1] as string).toLowerCase() === 'x' }
      block = undefined
      continue
    }
    const lab = LABEL.exec(line)
    if (lab) {
      let name = (lab[1] as string).trim()
      let rest = lab[2] as string
      let isLabel = false
      if (name.endsWith(':')) { name = name.slice(0, -1).trim(); isLabel = true }
      else if (rest.startsWith(':')) { rest = rest.slice(1); isLabel = true }
      if (isLabel) {
        const key = name.toLowerCase()
        rest = rest.trim()
        if (key === 'objective') { block = 'objective'; hasObjective = true; if (rest !== '') objective.push(rest); prose.push(i) }
        else if (key === 'files') { block = 'files'; hasFiles = true }
        else if (key === 'definition of done' || key === 'dod') { block = 'dod'; hasDod = true; if (rest !== '') dod.push(rest); prose.push(i) }
        else if (key === 'verify') { verify = true; block = 'other'; prose.push(i) }
        else block = 'other'
        continue
      }
    }
    if (block === 'objective') { if (line.trim() !== '') { objective.push(line.trim()); prose.push(i) } }
    else if (block === 'dod') {
      if (line.trim() !== '') { dod.push(line.trimEnd()); prose.push(i) }
      if (/^\s*(?:[-*+]\s+)?\**verify\**\s*:/i.test(line)) verify = true
    } else if (block === 'files') {
      const li = LIST_ITEM.exec(line)
      if (!li) continue
      const item = (li[1] as string).trim()
      const m = /^\**([A-Za-z]+)\**\s*:\s*(.*)$/.exec(item)
      const verb = m ? (m[1] as string).charAt(0).toUpperCase() + (m[1] as string).slice(1).toLowerCase() : ''
      if (m && (FILE_VERBS as readonly string[]).includes(verb) && (m[2] as string).trim() !== '') {
        files.push({ verb: verb as FileVerb, path: (m[2] as string).trim().replace(/^`(.*)`$/, '$1').replace(/^["'](.*)["']$/, '$1') })
      } else {
        badFiles.push({ line: i, text: item })
      }
    }
  }
  const task: PlanTask = { n: card.n, title: card.title, done: checkbox !== undefined && checkbox.n === card.n && checkbox.done, files }
  const obj = objective.join(' ').trim()
  if (obj !== '') task.objective = obj
  const d = dod.join('\n').trim()
  if (d !== '') task.dod = d
  return {
    task,
    hasObjective,
    hasFiles,
    hasDod,
    verify,
    badFiles,
    ...(checkbox ? { checkbox: { n: checkbox.n, line: checkbox.line } } : {}),
    prose,
  }
}

function asStatus(v: FmValue | undefined): PlanStatus | undefined {
  if (typeof v !== 'string') return undefined
  const u = v.trim().toUpperCase().replace(/[\s-]+/g, '_')
  return (PLAN_STATUSES as readonly string[]).includes(u) ? u as PlanStatus : undefined
}

function asType(v: FmValue | undefined): PlanType | undefined {
  if (typeof v !== 'string') return undefined
  const l = v.trim().toLowerCase()
  return PLAN_TYPES.find(t => t.toLowerCase() === l)
}

function asBool(v: FmValue | undefined): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const l = v.trim().toLowerCase()
    if (l === 'yes' || l === 'true') return true
    if (l === 'no' || l === 'false') return false
  }
  return undefined
}

function asCount(v: FmValue | undefined): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim())
  return undefined
}

function headerOf(fm: FmData): PlanHeader {
  const created = fm['created']
  const header: PlanHeader = {
    created: typeof created === 'string' ? created : typeof created === 'number' ? String(created) : '',
    status: asStatus(fm['status']) ?? 'PENDING',
    approved: asBool(fm['approved']) ?? false,
    worktree: asBool(fm['worktree']) ?? false,
    type: asType(fm['type']) ?? 'Feature',
  }
  const it = asCount(fm['iterations'])
  if (it !== undefined) header.iterations = it
  const rd = asCount(fm['rounds'])
  if (rd !== undefined) header.rounds = rd
  return header
}

export function parsePlan(markdown: string): Plan {
  const doc = scan(typeof markdown === 'string' ? markdown : '')
  return {
    header: headerOf(doc.fm),
    title: doc.title?.text ?? '',
    tasks: doc.cards.map(c => readCard(doc, c).task),
    sections: doc.sections.map(s => s.text),
  }
}

function outlineOf(doc: Doc): PlanOutline {
  return {
    lines: doc.lines,
    code: doc.code,
    body: doc.body,
    sections: doc.sections.map(s => ({ text: s.text, line: s.line, end: doc.headings.find(h => h.line > s.line && h.level <= 2)?.line ?? doc.lines.length })),
    cards: doc.cards.map(c => {
      const b = readCard(doc, c)
      return { n: c.n, head: c.head, end: c.end, done: b.task.done, files: b.task.files, prose: b.prose }
    }),
  }
}

export function planOutline(markdown: string): PlanOutline {
  return outlineOf(scan(typeof markdown === 'string' ? markdown : ''))
}

const CREATED = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

function err(code: string, message: string, line?: number): Finding { return line === undefined ? { level: 'error', code, message } : { level: 'error', code, message, line: line + 1 } }
function warn(code: string, message: string, line?: number): Finding { return line === undefined ? { level: 'warning', code, message } : { level: 'warning', code, message, line: line + 1 } }

function fmLine(doc: Doc, key: string): number | undefined {
  for (let i = 1; i < doc.fmEnd; i++) if (new RegExp(`^${key}\\s*:`).test(doc.lines[i] ?? '')) return i
  return undefined
}

function checkHeader(doc: Doc, out: Finding[]): PlanType | undefined {
  if (!doc.hasFrontmatter) {
    out.push(err('missing-frontmatter', 'the plan must start with a --- frontmatter block (created, status, approved, worktree, type)', 0))
    return undefined
  }
  const fm = doc.fm
  const missing = (k: string): boolean => fm[k] === undefined || fm[k] === null || fm[k] === ''
  for (const k of ['created', 'status', 'approved', 'worktree', 'type']) {
    if (missing(k)) out.push(err('missing-field', `frontmatter field \`${k}\` is missing`, 0))
  }
  const created = fm['created']
  if (!missing('created') && !(typeof created === 'string' && CREATED.test(created.trim()))) {
    out.push(err('bad-field', '`created` must be a date such as 2026-10-08', fmLine(doc, 'created')))
  }
  const status = fm['status']
  if (!missing('status') && !(typeof status === 'string' && (PLAN_STATUSES as readonly string[]).includes(status))) {
    out.push(err('bad-status', `\`status\` must be one of ${PLAN_STATUSES.join(', ')} (got ${JSON.stringify(status)})`, fmLine(doc, 'status')))
  }
  for (const k of ['approved', 'worktree']) {
    if (!missing(k) && typeof fm[k] !== 'boolean') out.push(err('bad-field', `\`${k}\` must be true or false (got ${JSON.stringify(fm[k])})`, fmLine(doc, k)))
  }
  const type = fm['type']
  const validType = typeof type === 'string' && (PLAN_TYPES as readonly string[]).includes(type) ? type as PlanType : undefined
  if (!missing('type') && validType === undefined) {
    out.push(err('bad-type', `\`type\` must be one of ${PLAN_TYPES.join(', ')} (got ${JSON.stringify(type)})`, fmLine(doc, 'type')))
  }
  const counter = validType === 'Build' ? 'rounds' : 'iterations'
  if (validType !== undefined && missing(counter)) out.push(warn('missing-field', `frontmatter field \`${counter}\` is missing (start it at 0)`, 0))
  for (const k of ['iterations', 'rounds']) {
    if (!missing(k) && !(typeof fm[k] === 'number' && Number.isInteger(fm[k]) && (fm[k] as number) >= 0)) {
      out.push(err('bad-field', `\`${k}\` must be a whole number of 0 or more (got ${JSON.stringify(fm[k])})`, fmLine(doc, k)))
    }
  }
  if (validType !== 'Plan' && typeof status === 'string' && ['APPROVED', 'IN_PROGRESS', 'COMPLETE', 'VERIFIED'].includes(status) && fm['approved'] === false) {
    out.push(warn('inconsistent-state', `status ${status} implies an approved plan, but \`approved\` is false`, fmLine(doc, 'approved')))
  }
  return validType ?? asType(type)
}

function tableCells(doc: Doc, i: number): string[] | undefined {
  const line = (doc.lines[i] ?? '').trim()
  if (doc.code[i] || !line.startsWith('|')) return undefined
  return line.replace(/^\||\|$/g, '').split('|').map(c => c.trim())
}

function isDelimiterRow(cells: string[] | undefined): boolean {
  return cells !== undefined && cells.every(c => /^:?-+:?$/.test(c))
}

function criteriaRows(doc: Doc): Array<{ line: number, cells: string[] }> {
  const sec = doc.sections.find(s => /^(?:acceptance )?criteria$/i.test(s.text))
  if (!sec) return []
  const next = doc.headings.find(h => h.line > sec.line && h.level <= 2)
  const end = next ? next.line : doc.lines.length
  const rows: Array<{ line: number, cells: string[] }> = []
  for (let i = sec.line + 1; i < end; i++) {
    const cells = tableCells(doc, i)
    if (cells === undefined || isDelimiterRow(cells)) continue
    if (i + 1 < end && isDelimiterRow(tableCells(doc, i + 1))) continue
    rows.push({ line: i, cells })
  }
  return rows
}

export interface PlanCriterion { id: string; status: 'open' | 'pass' | 'fail'; oracle: boolean; line: number }
export interface CriteriaTable { criteria: PlanCriterion[]; unread: Array<{ line: number, text: string }> }

const CRITERION_ID = /^(C\d{1,3})\s*(\(oracle\))?$/i

function plainCell(cell: string): string {
  return cell.replace(/[*_`]/g, '').trim()
}

function criterionStatus(cell: string): PlanCriterion['status'] {
  const c = plainCell(cell).toLowerCase()
  if (/^(?:pass|passed|ok|\u2713)/u.test(c)) return 'pass'
  if (/^(?:fail|failed|\u2717)/u.test(c)) return 'fail'
  return 'open'
}

function readCriteriaTable(doc: Doc): CriteriaTable {
  const out: CriteriaTable = { criteria: [], unread: [] }
  for (const r of criteriaRows(doc)) {
    const m = CRITERION_ID.exec(plainCell(r.cells[0] ?? ''))
    if (m === null || r.cells.length < 2) {
      out.unread.push({ line: r.line + 1, text: (doc.lines[r.line] ?? '').trim() })
      continue
    }
    out.criteria.push({ id: (m[1] as string).toUpperCase(), status: criterionStatus(r.cells[r.cells.length - 1] ?? ''), oracle: m[2] !== undefined, line: r.line + 1 })
  }
  return out
}

export function criteriaTable(markdown: string): CriteriaTable {
  return readCriteriaTable(scan(typeof markdown === 'string' ? markdown : ''))
}

export function planCriteria(markdown: string): PlanCriterion[] {
  return criteriaTable(markdown).criteria
}

const BUILD_CRITERIA = { min: 3, max: 10 }
const BUILD_TASKS = { min: 3, max: 12 }

function checkBuildContract(doc: Doc, out: Finding[]): void {
  const rows = criteriaRows(doc)
  const section = doc.sections.find(s => /criteria/i.test(s.text))?.line ?? doc.body
  if (rows.length < BUILD_CRITERIA.min) out.push(warn('criteria-count', `a build needs at least ${BUILD_CRITERIA.min} acceptance criteria in \`## Acceptance Criteria\` (found ${rows.length})`, section))
  else if (rows.length > BUILD_CRITERIA.max) out.push(warn('criteria-count', `${rows.length} acceptance criteria: split the goal into separate runs; never merge or drop a real criterion to fit a count`, section))
  const oracles = rows.filter(r => r.cells.some(c => /\(oracle\)/i.test(c))).length
  if (rows.length > 0 && oracles !== 1) out.push(warn('oracle-count', `exactly one criterion must be marked (oracle) (found ${oracles})`, rows[0]?.line))
  for (const u of readCriteriaTable(doc).unread) out.push(warn('criteria-row', `this row is not a criterion row; write it as \`| C<n> | … | pass |\` so \`buracle plan verify\` can read its verdict`, u.line - 1))
  if (!doc.lines.some((l, i) => !doc.code[i] && /^\s*\*\*False pass:?\*\*/i.test(l))) out.push(warn('missing-false-pass', 'add a `**False pass:**` line under the criteria table'))
  if (doc.cards.length < BUILD_TASKS.min) out.push(warn('task-count', `a build plans at least ${BUILD_TASKS.min} tasks (found ${doc.cards.length})`, doc.tasks?.head))
  else if (doc.cards.length > BUILD_TASKS.max) out.push(warn('task-count', `${doc.cards.length} tasks: split the goal into separate runs`, doc.tasks?.head))
}

export function validatePlan(markdown: string, opts?: { strict?: boolean }): Finding[] {
  const strict = opts?.strict === true
  if (typeof markdown !== 'string' || markdown.trim() === '') return [err('empty', 'the plan file is empty')]
  const out: Finding[] = []
  const cr = markdown.indexOf('\r')
  if (cr >= 0) out.push(err('crlf', 'use LF line endings only (the file contains CR characters)', markdown.slice(0, cr).split('\n').length - 1))
  const doc = scan(markdown)
  const type = checkHeader(doc, out)
  if (!doc.title || doc.title.text === '') out.push(err('missing-title', 'add a `# Title` heading after the frontmatter', doc.body))
  for (const line of doc.duplicateTasks) out.push(err('duplicate-section', 'only one `## Tasks` section is allowed', line))

  const needsTasks = type !== 'Plan'
  const strictCard = type === 'Feature' || type === 'Bugfix' || type === undefined
  const inCard = new Set<number>()
  if (!doc.tasks) {
    if (needsTasks) out.push(err('missing-tasks', 'add a `## Tasks` section with `### Task 1: …` cards', doc.body))
  } else if (doc.cards.length === 0 && needsTasks) {
    out.push(err('missing-tasks', '`## Tasks` has no `### Task N: <title>` cards', doc.tasks.head))
  }
  for (const b of doc.badTaskHeadings) out.push(err('task-heading', `task headings look like \`### Task 3: Title\` (got "### ${b.text}")`, b.line))
  const misnumbered = doc.cards.findIndex((c, i) => c.n !== i + 1)
  if (misnumbered >= 0) {
    const c = doc.cards[misnumbered] as Card
    out.push(err('task-numbering', `tasks must be numbered 1, 2, 3, … in order (found Task ${c.n} where Task ${misnumbered + 1} was expected)`, c.head))
  }
  for (const card of doc.cards) {
    for (let i = card.head; i < card.end; i++) inCard.add(i)
    const body = readCard(doc, card)
    const label = `Task ${card.n}`
    if (card.title === '') out.push(err('task-heading', `${label} has no title after the colon`, card.head))
    if (!body.hasObjective || body.task.objective === undefined) out.push(err('missing-objective', `${label} needs an \`**Objective:**\` line`, card.head))
    if (strictCard) {
      if (!body.hasFiles || body.task.files.length === 0) out.push(err('missing-files', `${label} needs a \`**Files:**\` list (\`- Create|Modify|Delete|Rename|Test: path\`)`, card.head))
      if (!body.hasDod || body.task.dod === undefined) out.push(err('missing-dod', `${label} needs a \`**Definition of Done:**\` list`, card.head))
      else if (strict && !body.verify) out.push(warn('missing-verify', `${label}: end the Definition of Done with \`- Verify: <command>\``, card.head))
    }
    for (const b of body.badFiles) {
      out.push(err('bad-file-verb', `${label}: file lines read \`- Create|Modify|Delete|Rename|Test: path\` (got "${b.text.slice(0, 60)}")`, b.line))
    }
    if (!body.checkbox) out.push(err('missing-checkbox', `${label} needs the checkbox line \`- [ ] Task ${card.n} done\``, card.head))
    else if (body.checkbox.n !== card.n) out.push(err('checkbox-mismatch', `${label}'s checkbox names Task ${body.checkbox.n}`, body.checkbox.line))
  }

  if (type === 'Feature' || type === 'Bugfix') out.push(...authoringFindings(outlineOf(doc)))

  const skeleton = skeletonPlaceholders()
  let skel = 0
  let firstSkel = -1
  let unfilled = 0
  let firstUnfilled = -1
  let commentLines = 0
  let firstComment = -1
  for (let i = doc.body; i < doc.lines.length; i++) {
    if (doc.code[i]) continue
    const line = doc.lines[i] as string
    const ph = PLACEHOLDER.exec(stripCode(line))
    if (ph) {
      if (inCard.has(i)) out.push(err('placeholder', `\`${ph[1]}\` is not allowed in task cards; decide, or ask the user`, i))
      else if (strict) out.push(warn('placeholder', `\`${ph[1]}\` left in the plan; decide, or ask the user`, i))
    }
    if (!line.includes('<!--')) continue
    commentLines++
    if (firstComment < 0) firstComment = i
    let other = false
    for (const m of line.matchAll(COMMENT)) {
      if (m[2] !== undefined && skeleton.has(normComment(m[1] as string))) { skel++; if (firstSkel < 0) firstSkel = i } else other = true
    }
    if (other) { unfilled++; if (firstUnfilled < 0) firstUnfilled = i }
  }
  const skeletonMatters = type !== 'Plan'
  if (skeletonMatters && skel > 0) {
    out.push(err('unfilled', `${skel} placeholder${skel === 1 ? '' : 's'} from \`buracle plan init\` ${skel === 1 ? 'is' : 'are'} still unfilled; replace each <!-- … --> with real content (write "None." where nothing applies)`, firstSkel))
  }
  const remaining = skeletonMatters ? unfilled : commentLines
  if (strict && remaining > 0) out.push(warn('unfilled', `${remaining} skeleton comment${remaining === 1 ? ' is' : 's are'} still unfilled; replace each <!-- … --> with real content`, skeletonMatters ? firstUnfilled : firstComment))

  if (strict && type === 'Build') {
    checkBuildContract(doc, out)
  }
  if (strict && (type === 'Feature' || type === 'Bugfix') && doc.cards.length > 12) {
    out.push(warn('task-count', `${doc.cards.length} tasks: consider splitting the work into sequential plans`, doc.tasks?.head))
  }
  if (strict && type === 'Bugfix') {
    for (const s of ['Behavior Contract', 'Root Cause']) {
      if (!doc.sections.some(h => h.text.toLowerCase() === s.toLowerCase())) out.push(warn('missing-section', `a bugfix plan needs a \`## ${s}\` section`))
    }
  }
  return out
}

const COMMENT = /<!--([\s\S]*?)(-->|$)/g

function normComment(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

let placeholderSet: ReadonlySet<string> | undefined

function skeletonPlaceholders(): ReadonlySet<string> {
  if (placeholderSet !== undefined) return placeholderSet
  const out = new Set<string>()
  for (const type of PLAN_TYPES) {
    for (const m of planSkeleton({ type, title: 'Skeleton', created: '2026-01-01' }).matchAll(COMMENT)) {
      if (m[2] !== undefined) out.add(normComment(m[1] as string))
    }
  }
  placeholderSet = out
  return out
}

function taskCard(n: number, title: string, objective: string, files: string[], dod: string[]): string {
  return [
    `### Task ${n}: ${title}`,
    '',
    `**Objective:** ${objective}`,
    '',
    '**Files:**',
    ...files.map(f => `- ${f}`),
    '',
    '**Definition of Done:**',
    ...dod.map(d => `- ${d}`),
    '',
    `- [ ] Task ${n} done`,
    '',
  ].join('\n')
}

export function planSkeleton(opts: { type: PlanType, title: string, created: string }): string {
  const type: PlanType = PLAN_TYPES.includes(opts.type) ? opts.type : 'Feature'
  const title = (typeof opts.title === 'string' ? opts.title : '').replace(/\s+/g, ' ').trim() || 'Untitled plan'
  const fm: Record<string, unknown> = {
    created: opts.created,
    status: type === 'Plan' ? 'SAVED' : 'PENDING',
    approved: type === 'Plan',
    worktree: false,
    type,
  }
  if (type === 'Build') fm['rounds'] = 0
  else fm['iterations'] = 0
  const head = `---\n${renderYamlBlock(fm, ['created', 'status', 'approved', 'worktree', 'type', 'iterations', 'rounds'])}\n---\n# ${title}\n`
  const verify = 'Verify: <!-- the command that proves this task -->'
  let body: string
  switch (type) {
    case 'Feature':
      body = [
        '## Goal',
        '<!-- One to three sentences: what will exist, for whom, and how anyone can tell it works. -->',
        'Done when:',
        '- <!-- an observable outcome -->',
        '',
        '## Context',
        '<!-- Entry points (path:line), the pattern to follow, and the exact test, type-check, lint and run commands. -->',
        '',
        '## Scope',
        '- In: <!-- what this plan changes -->',
        '- Out: <!-- what it deliberately leaves alone -->',
        '',
        '## Approach',
        '<!-- The one approach, then up to five key decisions with their reasons. -->',
        '',
        '## Tasks',
        '',
        taskCard(1, '<!-- short title -->', '<!-- the observable behavior this task adds -->', ['Create: <!-- path -->'], ['<!-- a checkable fact -->', verify]),
        '## E2E Scenarios',
        '<!-- SC-1, SC-2, … one per user-visible flow, or one line saying the change is purely internal. -->',
        '',
        '## Risks',
        '<!-- or "None." -->',
        '',
        '## Assumptions',
        '<!-- or "None." -->',
      ].join('\n')
      break
    case 'Bugfix':
      body = [
        '## Behavior Contract',
        '- **Given:** <!-- the state or setup -->',
        '- **When:** <!-- the action that triggers the bug -->',
        '- **Actual:** <!-- the wrong behavior, with the exact symptom -->',
        '- **Expected:** <!-- the correct behavior -->',
        '- **Unchanged:** <!-- behaviors that must stay, each with the test that guards it -->',
        '',
        '## Root Cause',
        '<!-- path:line — what the code does, what it should do, and why. Confidence: high | medium. Reproduction command and output excerpt. -->',
        '',
        '## Context',
        '<!-- Files with path:line, and the test and run commands. -->',
        '',
        '## Tasks',
        '',
        taskCard(1, 'Reproduce the bug in a failing test', '<!-- a test through the public entry point that fails with the Actual symptom -->', ['Test: <!-- path -->'], ['The new test fails on the current code with the Actual symptom.', verify]),
        taskCard(2, 'Fix the root cause', '<!-- the change at the root cause, in one sentence -->', ['Modify: <!-- root-cause path -->'], ['The Task 1 test and the tests named under Unchanged pass.', 'No `BURACLE-DEBUG` line remains in the repository.', verify]),
        taskCard(3, 'Quality gate', 'The whole project is green and the original reproduction now shows the Expected behavior.', ['Test: <!-- path -->'], ['Full suite, type check, lint and build pass.', 'The reproduction from `## Root Cause` shows the Expected behavior.', verify]),
        '## Risks',
        '<!-- or "None." -->',
        '',
        '## Assumptions',
        '<!-- or "None." -->',
      ].join('\n')
      break
    case 'Build':
      body = [
        '## Goal',
        '<!-- The end state in one to three sentences. -->',
        '',
        '## Reference',
        '<!-- A named, obtainable thing to compare the result with, or "None." -->',
        '',
        '## Acceptance Criteria',
        '| # | Criterion | Evidence | Status |',
        '|---|---|---|---|',
        '| C1 | <!-- one pass/fail sentence --> | <!-- what you will run or look at --> | open |',
        '| C2 | <!-- one pass/fail sentence --> | <!-- what you will run or look at --> | open |',
        '| C3 (oracle) | <!-- the one observable signal that proves the goal --> | <!-- how you will observe it --> | open |',
        '',
        '**False pass:** <!-- a believable way the result could look finished while wrong, and the criterion that catches it -->',
        '',
        '## Out of Scope',
        '<!-- what the user named that this build deliberately leaves out, or "None." -->',
        '',
        '## Tasks',
        '',
        taskCard(1, '<!-- short title -->', '<!-- a step toward the criteria it serves (name them) -->', ['Create: <!-- path -->'], ['<!-- a checkable fact -->', verify]),
        '## Assumptions',
        '<!-- or "None." -->',
      ].join('\n')
      break
    case 'Plan':
      body = [
        '## Summary',
        '<!-- The approved plan text. -->',
      ].join('\n')
      break
  }
  return `${head}\n${body.replace(/\n+$/, '')}\n`
}
