import type { BuracleConfig } from '../../../core/config'
import type { ToolKind } from '../../../core/events'
import type { BandView } from '../../../core/flow/band'
import { bandSummary, resumeSuggestion } from '../../../core/flow/band'
import type { ReceiptChange, ReceiptState } from '../../../core/receipt'
import { emptyReceipt, longTurnText, noteChanges, noteCommand, receiptLine } from '../../../core/receipt'
import type { EditTargets } from './edits'
import type { OmpContext, OmpToolResultEvent } from './types'
import { hasTui, numAt } from './util'

const MAX_TURNS = 32
const OLD_KEYS = ['old_string', 'old_str', 'old_text', 'oldString', 'oldText'] as const
const NEW_KEYS = ['new_string', 'new_str', 'new_text', 'newString', 'newText'] as const

export interface OmpReceiptHost {
  now(): number
  view(sid: string): BandView | undefined
  desktop(title: string, message: string): void
  log(msg: string, data?: unknown): void
}

export interface OmpToolFacts { kind: ToolKind; command?: string; files: readonly string[]; targets?: EditTargets | undefined }

function first(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const k of keys) if (typeof input[k] === 'string') return input[k] as string
  return ''
}

export function ompReceiptChanges(tool: string, input: Record<string, unknown>, facts: OmpToolFacts): ReceiptChange[] {
  if (facts.targets !== undefined && facts.targets.changes.length > 0) return facts.targets.changes.map(c => ({ path: c.file, removed: c.removed, added: c.added }))
  const path = facts.files[0]
  if (path === undefined) return []
  if (tool === 'write') return [{ path, removed: '', added: typeof input['content'] === 'string' ? input['content'] : '' }]
  if (tool === 'edit') return [{ path, removed: first(input, OLD_KEYS), added: first(input, NEW_KEYS) }]
  return facts.files.map(p => ({ path: p, removed: '', added: '' }))
}

export function bashFailed(event: OmpToolResultEvent): boolean {
  const exit = numAt(event.details, 'exitCode')
  return event.isError === true || (exit !== undefined && exit !== 0)
}

interface Turn { receipt: ReceiptState; startedAt?: number }

export interface TurnReceipts {
  prompt(sid: string): void
  tool(sid: string, ctx: OmpContext, event: OmpToolResultEvent, facts: OmpToolFacts): void
  end(sid: string, ctx: OmpContext, answer: string, cfg: Pick<BuracleConfig, 'workflow'>): void
  resumed(sid: string, ctx: OmpContext, cfg: Pick<BuracleConfig, 'workflow'>): void
}

export function createTurnReceipts(host: OmpReceiptHost): TurnReceipts {
  const turns = new Map<string, Turn>()
  const turn = (sid: string): Turn => {
    let t = turns.get(sid)
    if (t === undefined) {
      if (turns.size >= MAX_TURNS) turns.delete(turns.keys().next().value as string)
      t = { receipt: emptyReceipt() }
      turns.set(sid, t)
    }
    return t
  }
  const show = (ctx: OmpContext, text: string, type: 'info' | 'warning'): void => {
    if (hasTui(ctx)) ctx.ui.notify(text, type)
  }
  return {
    prompt(sid) {
      turns.delete(sid)
      turn(sid).startedAt = host.now()
    },
    tool(sid, ctx, event, facts) {
      const t = turn(sid)
      let alarm: string | undefined
      if (facts.kind === 'bash' && facts.command !== undefined && facts.command.trim() !== '') {
        const r = noteCommand(t.receipt, facts.command, bashFailed(event))
        t.receipt = r.state
        alarm = r.alarm
      } else if ((facts.kind === 'edit' || facts.kind === 'write' || facts.kind === 'patch') && event.isError !== true) {
        const input = event.input !== null && typeof event.input === 'object' ? event.input : {}
        const r = noteChanges(t.receipt, ompReceiptChanges(event.toolName, input, facts))
        t.receipt = r.state
        alarm = r.alarm
      }
      if (alarm !== undefined) show(ctx, `Buracle: ${alarm}`, 'warning')
    },
    end(sid, ctx, answer, cfg) {
      const t = turns.get(sid)
      if (t === undefined) return
      turns.set(sid, { receipt: emptyReceipt() })
      const summary = receiptLine(t.receipt, answer)
      if (summary?.warn === true) show(ctx, summary.line, 'warning')
      else if (summary !== undefined) host.log('turn receipt', { sid, line: summary.line })
      if (t.startedAt === undefined || !hasTui(ctx)) return
      const view = host.view(sid)
      const text = longTurnText(host.now() - t.startedAt, cfg.workflow.notifyAfterSec, view !== undefined ? bandSummary(view) : '')
      if (text !== undefined) host.desktop('Buracle', text)
    },
    resumed(sid, ctx, cfg) {
      if (!cfg.workflow.band) return
      const view = host.view(sid)
      const suggestion = view !== undefined ? resumeSuggestion(view) : undefined
      if (view === undefined || suggestion === undefined) return
      show(ctx, `This session has an unfinished workflow run (${bandSummary(view)}). To go on, say: ${suggestion}`, 'info')
    },
  }
}
