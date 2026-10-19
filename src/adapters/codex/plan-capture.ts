import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../../engine/fsx'
import { shownPath } from '../../workflow/plan-capture'
import { captureSessionPlan } from '../../workflow/plan-native'
import type { AdapterContext } from '../registry'
import { readTail } from './rollout'

export const CODEX_IMPLEMENT_PROMPT = 'Implement the plan.'
export const CODEX_FRESH_PLAN_PREFIX = "A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification."

const ROLLOUT_TAIL_BYTES = 4 * 1024 * 1024
const PROPOSED_PLAN = /^[ \t]*<proposed_plan>[ \t]*\n([\s\S]*?)\n[ \t]*<\/proposed_plan>[ \t]*$/gm

export function proposedPlanOf(text: string): string | undefined {
  let last: string | undefined
  for (const m of text.replace(/\r\n?/g, '\n').matchAll(PROPOSED_PLAN)) last = m[1]
  const plan = last?.trim()
  return plan !== undefined && plan !== '' ? plan : undefined
}

export type CodexPlanApproval = { kind: 'implement' } | { kind: 'fresh', plan: string }

export function codexPlanApproval(prompt: string): CodexPlanApproval | undefined {
  const text = prompt.replace(/\r\n?/g, '\n')
  if (text.trim() === CODEX_IMPLEMENT_PROMPT) return { kind: 'implement' }
  if (!text.startsWith(CODEX_FRESH_PLAN_PREFIX)) return undefined
  const plan = text.slice(CODEX_FRESH_PLAN_PREFIX.length).trim()
  return plan !== '' ? { kind: 'fresh', plan } : undefined
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export function lastAssistantText(rollout: string): string | undefined {
  let end = rollout.length
  while (end > 0) {
    const start = rollout.lastIndexOf('\n', end - 1) + 1
    const line = rollout.slice(start, end)
    end = start > 0 ? start - 1 : 0
    if (!line.includes('"assistant"')) continue
    try {
      const o = JSON.parse(line) as unknown
      const p = isRecord(o) && o['type'] === 'response_item' ? o['payload'] : undefined
      if (!isRecord(p) || p['type'] !== 'message' || p['role'] !== 'assistant' || !Array.isArray(p['content'])) continue
      return p['content'].map(c => (isRecord(c) && c['type'] === 'output_text' && typeof c['text'] === 'string' ? c['text'] : '')).join('')
    } catch {  }
  }
  return undefined
}

function rolloutPlan(transcript: string | undefined): string | undefined {
  if (transcript === undefined) return undefined
  const text = readTail(transcript, ROLLOUT_TAIL_BYTES)
  const last = text === undefined ? undefined : lastAssistantText(text)
  return last === undefined ? undefined : proposedPlanOf(last)
}

interface PendingPlan { plan: string, at: number }

function pendingPath(ctx: AdapterContext, sid: string): string {
  return join(ctx.paths.sessionDir('codex', sid), 'proposed-plan.json')
}

function readPending(ctx: AdapterContext, sid: string): PendingPlan | undefined {
  const r = readJsonSafeSync<PendingPlan>(pendingPath(ctx, sid))
  return r.ok && isRecord(r.value) && typeof r.value.plan === 'string' && r.value.plan.trim() !== '' ? r.value : undefined
}

function clearPending(ctx: AdapterContext, sid: string): void {
  rmSync(pendingPath(ctx, sid), { force: true })
}

export function noteProposedPlan(ctx: AdapterContext, sid: string, lastMessage: string | undefined, now: number, continued = false): boolean {
  const plan = lastMessage !== undefined ? proposedPlanOf(lastMessage) : undefined
  if (plan === undefined) {
    if (!continued) clearPending(ctx, sid)
    return false
  }
  ensureDirSync(ctx.paths.sessionDir('codex', sid))
  atomicWriteSync(pendingPath(ctx, sid), JSON.stringify({ plan, at: now } satisfies PendingPlan) + '\n')
  return true
}

export async function captureApprovedPlan(ctx: AdapterContext, sid: string, prompt: string, cwd: string, transcript: string | undefined, now: number): Promise<string | undefined> {
  const approval = codexPlanApproval(prompt)
  const pending = readPending(ctx, sid)
  if (pending !== undefined) clearPending(ctx, sid)
  if (approval === undefined) return undefined
  const plan = approval.kind === 'fresh' ? approval.plan : pending?.plan ?? rolloutPlan(transcript)
  if (plan === undefined) return undefined
  const saved = await captureSessionPlan({ plan, cwd, now, harness: 'codex', sid })
  return saved !== undefined ? saved.note ?? `Buracle: the approved plan was saved to ${shownPath(saved.path, cwd)} (H12).` : undefined
}
