import type { SessionState } from '../plan/state'
import type { Segment } from '../status/model'
import type { BandView } from './band'
import { bandText } from './band'

export interface FlowPaneLine { text: string; color?: string; dim?: boolean; bold?: boolean }

const THEME_OF: Readonly<Record<NonNullable<Segment['color']>, string>> = {
  green: 'success', red: 'error', yellow: 'warning', magenta: 'claude', cyan: 'planMode', blue: 'suggestion', gray: 'inactive', white: 'text',
}

export function themeOf(color: Segment['color']): string | undefined {
  return color !== undefined ? THEME_OF[color] : undefined
}

export function planPaneLines(v: BandView, state: SessionState): FlowPaneLine[] {
  const lines: FlowPaneLine[] = v.visible ? bandText(v).map((text, i) => (i === 0 ? { text, bold: true } : { text })) : []
  const plan = state.plan
  if (plan === undefined) {
    lines.push({ text: 'No plan is bound to this session.', bold: lines.length === 0 })
    lines.push({ text: 'A new plan: /plan-build <task> · an existing one: buracle plan register <path>', dim: true })
    return lines
  }
  lines.push({ text: `plan: ${plan.slug} (${plan.type})`, bold: true })
  lines.push({ text: `status ${plan.status} · phase ${plan.phase}` })
  lines.push({ text: `file: ${plan.path}`, dim: true })
  if (state.interaction?.state === 'paused') lines.push({ text: 'paused: the stop guard lets the turn end; say "continue" to resume', color: 'warning' })
  lines.push({ text: `stop guard blocks: plan ${state.guard.blocksForPlan} · chain ${state.guard.blocksInChain}`, dim: true })
  return lines
}

export interface ModStatusInfo {
  version: string; testedWith: string; minClaude: string
  sid: string; interactive: boolean
  bypass: boolean; strictness: string; redact: boolean; band: boolean
  commands: readonly string[]
  uiUrl?: string
}

export function modStatusLines(i: ModStatusInfo): string[] {
  const lines = [
    `Buracle ${i.version} · Claude Code (tested ${i.testedWith}, minimum ${i.minClaude})`,
    `session: ${i.sid !== '' ? i.sid : '-'} · ${i.interactive ? 'interactive' : 'non-interactive'}`,
    `permissions: ${i.bypass ? "bypass (no approval prompts; Buracle's guards and consent gate protect)" : 'the harness setting'}`,
    `routing: ${i.strictness} · secret masking: ${i.redact ? 'on' : 'off'} · workflow band: ${i.band ? 'on' : 'off'}`,
    `commands: ${i.commands.map(c => `/${c}`).join(' ')}`,
  ]
  if (i.uiUrl !== undefined) lines.push(`memory UI: ${i.uiUrl}`)
  return lines
}

function count(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0
}

export function memoryPaneLines(status: unknown, url: string | undefined, brain: string): FlowPaneLine[] {
  const lines: FlowPaneLine[] = []
  const s = status !== null && typeof status === 'object' && !Array.isArray(status) && (status as Record<string, unknown>)['v'] === 2 ? status as Record<string, unknown> : undefined
  if (s === undefined) {
    lines.push({ text: 'No memory status yet.', bold: true })
    lines.push({ text: '`buracle mem status` and memory writes create the status file.', dim: true })
  } else {
    const health = typeof s['health'] === 'string' && s['health'] !== '' ? s['health'] : '?'
    const counts = s['counts'] !== null && typeof s['counts'] === 'object' ? s['counts'] as Record<string, unknown> : {}
    const project = typeof s['project'] === 'string' ? s['project'] : undefined
    lines.push({ text: `memory: ${health}`, color: health === 'ok' ? 'success' : health === 'warn' ? 'warning' : 'error', bold: true })
    lines.push({ text: `${project !== undefined ? `project ${project} ${count(counts['project'])} · ` : ''}person ${count(counts['person'])}` })
    lines.push({ text: `upkeep ${count(s['upkeep'])} · captures ${count(s['captures'])}` })
  }
  if (url !== undefined) lines.push({ text: `web UI: ${url}  (w)`, dim: true })
  lines.push({ text: `brain: ${brain}`, dim: true })
  return lines
}
