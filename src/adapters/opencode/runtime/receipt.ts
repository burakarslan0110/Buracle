import type { BuracleConfig } from '../../../core/config'
import type { ToolKind } from '../../../core/events'
import type { ReceiptState } from '../../../core/receipt'
import { emptyReceipt, longTurnText, noteChanges, noteCommand, receiptLine } from '../../../core/receipt'
import { opencodeReceiptChanges } from '../../shared/turn-receipt'
import type { ToolExecuteAfter, TuiToastVariant } from './types'
import { asRecord, num } from './util'

const MAX_TURNS = 64

export interface TurnReceiptHost {
  now(): number
  post(sid: string, text: string, variant: TuiToastVariant): void
  notify(title: string, message: string): void
  run(sid: string): string
  log(msg: string, data?: unknown): void
}

interface Turn { receipt: ReceiptState; startedAt?: number }

export interface ToolFacts { kind: ToolKind; paths: readonly string[]; command?: string; cwd: string; home?: string }

export function shellRunFailed(e: ToolExecuteAfter): boolean {
  if (e.status !== 'completed') return true
  const exit = num(asRecord(e.result.output)['exit'])
  return exit !== undefined && exit !== 0
}

export class TurnReceipts {
  private readonly turns = new Map<string, Turn>()

  constructor(private readonly host: TurnReceiptHost) {}

  private turn(sid: string): Turn {
    let t = this.turns.get(sid)
    if (t === undefined) {
      if (this.turns.size >= MAX_TURNS) this.turns.delete(this.turns.keys().next().value as string)
      t = { receipt: emptyReceipt() }
      this.turns.set(sid, t)
    }
    return t
  }

  prompt(sid: string): void {
    this.turns.delete(sid)
    this.turn(sid).startedAt = this.host.now()
  }

  tool(sid: string, e: ToolExecuteAfter, facts: ToolFacts): void {
    const t = this.turn(sid)
    let alarm: string | undefined
    if (facts.kind === 'bash' && facts.command !== undefined && facts.command.trim() !== '') {
      const r = noteCommand(t.receipt, facts.command, shellRunFailed(e))
      t.receipt = r.state
      alarm = r.alarm
    } else if ((facts.kind === 'edit' || facts.kind === 'write' || facts.kind === 'patch') && e.status === 'completed') {
      const r = noteChanges(t.receipt, opencodeReceiptChanges(e.tool, asRecord(e.input), facts.paths, facts.cwd, facts.home))
      t.receipt = r.state
      alarm = r.alarm
    }
    if (alarm !== undefined) this.host.post(sid, `Buracle: ${alarm}`, 'warning')
  }

  end(sid: string, answer: string, cfg: Pick<BuracleConfig, 'workflow'>, notify = true): void {
    const t = this.turns.get(sid)
    if (t === undefined) return
    this.turns.set(sid, { receipt: emptyReceipt() })
    const summary = receiptLine(t.receipt, answer)
    if (summary?.warn === true) this.host.post(sid, summary.line, 'warning')
    else if (summary !== undefined) this.host.log('turn receipt', { sid, line: summary.line })
    if (t.startedAt === undefined || !notify) return
    const text = longTurnText(this.host.now() - t.startedAt, cfg.workflow.notifyAfterSec, this.host.run(sid))
    if (text !== undefined) this.host.notify('Buracle', text)
  }

  forget(sid: string): void {
    this.turns.delete(sid)
  }
}
