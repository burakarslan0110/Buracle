import type { PlanOutline } from './authoring'
import type { PlanType } from './format'
import { planOutline } from './format'

export interface PlanObjective { goal?: string; label: string; items: string[] }

export const OBJECTIVE_GOAL_MAX = 500
export const OBJECTIVE_ITEMS_MAX = 5
const ITEM_MAX = 200

function plain(line: string): string {
  return line.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim()
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 3).trimEnd()}...`
}

function sectionLines(o: PlanOutline, name: RegExp): string[] | undefined {
  const sec = o.sections.find(s => name.test(s.text.trim()))
  if (sec === undefined) return undefined
  const out: string[] = []
  let inComment = false
  for (let i = sec.line + 1; i < sec.end; i++) {
    if (o.code[i] === true) continue
    let line = o.lines[i] ?? ''
    if (inComment) {
      const close = line.indexOf('-->')
      if (close < 0) continue
      line = line.slice(close + 3)
      inComment = false
    }
    const open = line.lastIndexOf('<!--')
    if (open >= 0 && line.indexOf('-->', open) < 0) { line = line.slice(0, open); inComment = true }
    out.push(line)
  }
  return out
}

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/

function bullets(lines: readonly string[]): string[] {
  return lines.flatMap(l => { const m = BULLET.exec(l); const t = m ? plain(m[1] as string) : ''; return t !== '' ? [clip(t, ITEM_MAX)] : [] })
}

function prose(lines: readonly string[]): string | undefined {
  const t = plain(lines.filter(l => !BULLET.test(l)).join(' '))
  return t === '' ? undefined : clip(t, OBJECTIVE_GOAL_MAX)
}

function featureObjective(o: PlanOutline): PlanObjective | undefined {
  const lines = sectionLines(o, /^goal$/i)
  if (lines === undefined) return undefined
  const at = lines.findIndex(l => /^\s*(?:\*\*)?done when(?:\*\*)?\s*:?/i.test(l))
  const head = at < 0 ? lines : lines.slice(0, at)
  const tail = at < 0 ? [] : [plain(lines[at] as string).replace(/^done when\s*:?\s*/i, ''), ...lines.slice(at + 1)]
  const items = bullets(at < 0 ? [] : tail.slice(1))
  const inline = at < 0 ? '' : (tail[0] ?? '')
  if (inline !== '') items.unshift(clip(inline, ITEM_MAX))
  const goal = prose(head)
  return goal === undefined && items.length === 0 ? undefined : { ...(goal !== undefined ? { goal } : {}), label: 'Done when', items: items.slice(0, OBJECTIVE_ITEMS_MAX) }
}

function bugfixObjective(o: PlanOutline): PlanObjective | undefined {
  const lines = sectionLines(o, /^behavior contract$/i)
  if (lines === undefined) return undefined
  const all = bullets(lines)
  const rank = (s: string): number => (/^expected\b/i.test(s) ? 0 : /^unchanged\b/i.test(s) ? 1 : /^actual\b/i.test(s) ? 2 : 3)
  const items = all.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map(x => x.s).filter(s => !/^[a-z ]+:\s*$/i.test(s))
  return items.length === 0 ? undefined : { label: 'Behavior contract', items: items.slice(0, OBJECTIVE_ITEMS_MAX) }
}

function buildObjective(o: PlanOutline): PlanObjective | undefined {
  const goal = prose(sectionLines(o, /^goal$/i) ?? [])
  const rows: Array<{ text: string, open: boolean }> = []
  for (const line of sectionLines(o, /^(?:acceptance )?criteria$/i) ?? []) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t.replace(/^\||\|$/g, '').split('|').map(c => plain(c))
    const id = /^C\d{1,3}\b/i.exec(cells[0] ?? '')?.[0]
    const text = cells[1] ?? ''
    if (id === undefined || text === '') continue
    const status = (cells[cells.length - 1] ?? '').toLowerCase()
    const open = !/^(?:pass|passed|ok|✓)/u.test(status)
    rows.push({ text: clip(`${id.toUpperCase()} ${text} (${open ? status || 'open' : 'pass'})`, ITEM_MAX), open })
  }
  const items = [...rows.filter(r => r.open), ...rows.filter(r => !r.open)].map(r => r.text)
  return goal === undefined && items.length === 0 ? undefined : { ...(goal !== undefined ? { goal } : {}), label: 'Acceptance criteria', items: items.slice(0, OBJECTIVE_ITEMS_MAX) }
}

export function planObjectiveOf(o: PlanOutline, type: PlanType): PlanObjective | undefined {
  if (type === 'Bugfix') return bugfixObjective(o)
  if (type === 'Build') return buildObjective(o)
  if (type === 'Feature') return featureObjective(o)
  return undefined
}

export function planObjective(markdown: string, type: PlanType): PlanObjective | undefined {
  return planObjectiveOf(planOutline(typeof markdown === 'string' ? markdown : ''), type)
}

export function objectiveLine(obj: PlanObjective | undefined, budget: number): string | undefined {
  if (obj === undefined || budget < 60) return undefined
  const goal = obj.goal !== undefined ? `Objective: ${obj.goal}` : ''
  let items = [...obj.items]
  const render = (): string => [goal, items.length > 0 ? `${obj.label}: ${items.join('; ')}` : ''].filter(s => s !== '').join(' ').replace(/([^.!?])$/, '$1.')
  let text = render()
  while (text.length > budget && items.length > 1) { items = items.slice(0, -1); text = render() }
  if (text.length > budget) text = clip(text, budget)
  return text === '.' || text === '' ? undefined : text
}

export function tickedTasks(o: PlanOutline): number[] {
  return o.cards.filter(c => c.done).map(c => c.n).sort((a, b) => a - b)
}
