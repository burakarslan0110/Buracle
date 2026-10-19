import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness } from '../../core/events'
import { bandNotice, bandSummary } from '../../core/flow/band'
import type { ReceiptChange, ReceiptState } from '../../core/receipt'
import { emptyReceipt, longTurnText, noteChanges, noteCommand, parseReceipt, receiptLine } from '../../core/receipt'
import type { HookHealth } from '../../core/status/model'
import { hooksSegmentTexts } from '../../core/status/hooks'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../../engine/fsx'
import { log } from '../../engine/log'
import { flowViewFor } from '../../workflow/flow'
import { withFileLock } from '../../workflow/session-store'
import type { AdapterContext } from '../registry'
import { json, loadAdapterState, NOTHING, saveAdapterState, type HookOutcome } from './hook-io'

const H: Harness = 'codex'
const NOTICE_FOLD_SEC = 3_600

export interface TurnRecord { v: 1; startedAt?: number; receipt: ReceiptState }

export function turnFile(ctx: AdapterContext, sid: string): string {
  return join(ctx.paths.sessionDir(H, sid), 'receipt.json')
}

export function loadTurn(ctx: AdapterContext, sid: string): TurnRecord {
  const r = readJsonSafeSync<Record<string, unknown>>(turnFile(ctx, sid))
  const v = r.ok && r.value !== null && typeof r.value === 'object' ? r.value : {}
  const out: TurnRecord = { v: 1, receipt: parseReceipt(v['receipt']) }
  if (typeof v['startedAt'] === 'number' && Number.isFinite(v['startedAt'])) out.startedAt = v['startedAt']
  return out
}

function updateTurn<T>(ctx: AdapterContext, sid: string, fn: (t: TurnRecord) => { next: TurnRecord, out: T }): T {
  const file = turnFile(ctx, sid)
  ensureDirSync(ctx.paths.sessionDir(H, sid))
  return withFileLock(file, () => {
    const r = fn(loadTurn(ctx, sid))
    atomicWriteSync(file, JSON.stringify(r.next) + '\n')
    return r.out
  })
}

export function turnStarted(ctx: AdapterContext, sid: string, now: number): void {
  updateTurn(ctx, sid, () => ({ next: { v: 1, startedAt: now, receipt: emptyReceipt() }, out: undefined }))
}

export function commandRan(ctx: AdapterContext, sid: string, command: string, failed: boolean): string | undefined {
  return updateTurn(ctx, sid, t => {
    const r = noteCommand(t.receipt, command, failed)
    return { next: { ...t, receipt: r.state }, out: r.alarm }
  })
}

export function filesChanged(ctx: AdapterContext, sid: string, changes: readonly ReceiptChange[]): string | undefined {
  if (changes.length === 0) return undefined
  return updateTurn(ctx, sid, t => {
    const r = noteChanges(t.receipt, changes)
    return { next: { ...t, receipt: r.state }, out: r.alarm }
  })
}

export interface TurnEndOptions { answer: string; now: number; notify?: (title: string, message: string) => void }

export function turnEnded(ctx: AdapterContext, sid: string, o: TurnEndOptions): string | undefined {
  if (!existsSync(turnFile(ctx, sid))) return undefined
  const t = updateTurn(ctx, sid, cur => ({ next: { v: 1, receipt: emptyReceipt() }, out: cur }))
  const summary = receiptLine(t.receipt, o.answer)
  if (summary !== undefined && !summary.warn) log('debug', 'codex: turn receipt', { sid, line: summary.line })
  if (t.startedAt !== undefined && o.notify !== undefined) {
    const run = bandSummary(flowViewFor(H, sid, o.now, ctx.config.workflow.foldAfterSec))
    const text = longTurnText(o.now - t.startedAt, ctx.config.workflow.notifyAfterSec, run)
    if (text !== undefined) o.notify('Buracle', text)
  }
  return summary?.warn === true ? summary.line : undefined
}

export function flowNotice(ctx: AdapterContext, sid: string, now: number, silent = false): string | undefined {
  if (!ctx.config.workflow.codexNotices) return undefined
  const n = bandNotice(flowViewFor(H, sid, now, NOTICE_FOLD_SEC))
  if (n === undefined) return undefined
  const s = loadAdapterState(ctx, sid)
  if (s.flowNotified === n.key) return undefined
  saveAdapterState(ctx, sid, { ...s, flowNotified: n.key })
  return silent ? undefined : n.text
}

export function hooksNotice(ctx: AdapterContext, health: HookHealth | undefined): string | undefined {
  if (!ctx.config.workflow.codexNotices) return undefined
  if (health === undefined || hooksSegmentTexts(health) === undefined) return undefined
  const n = Math.max(0, Math.round(health.failures))
  const closed = Math.max(0, Math.round(health.failClosed))
  const parts: string[] = []
  if (n > 0) parts.push(`${n} Buracle hook ${n === 1 ? 'run' : 'runs'} failed in the last 24 h${closed > 0 ? ` (${closed} denied a call)` : ''}; run \`buracle doctor codex\``)
  if (health.runtimeBehind === true) parts.push('the installed Buracle runtime is behind the checkout; run `buracle install`')
  return `Buracle: ${parts.join('; ')}. The tmux status line (\`buracle statusline codex\`) shows this too.`
}

export function joinNotices(...parts: ReadonlyArray<string | undefined>): string | undefined {
  const text = parts.filter((p): p is string => p !== undefined && p.trim() !== '').map(p => p.trim()).join('\n')
  return text !== '' ? text : undefined
}

export function withSystemMessage(outcome: HookOutcome, message: string | undefined): HookOutcome {
  if (message === undefined || message.trim() === '') return outcome
  let out: Record<string, unknown> = {}
  if (outcome.stdout.trim() !== '') {
    try {
      const v: unknown = JSON.parse(outcome.stdout)
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) out = v as Record<string, unknown>
      else return outcome
    } catch { return outcome }
  }
  const prev = typeof out['systemMessage'] === 'string' ? out['systemMessage'] : undefined
  out['systemMessage'] = joinNotices(prev, message)
  return Object.keys(out).length > 0 ? json(out) : NOTHING
}
