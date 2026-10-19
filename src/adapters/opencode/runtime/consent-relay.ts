import { closeSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../../../engine/fsx'
import * as paths from '../../../engine/paths'

export const RELAY_DIR = 'consent-relay'
export const TUI_FRESH_MS = 6_000
export const ASK_ID = /^[a-z0-9-]{8,64}$/

export type RelayAnswer = 'once' | 'session' | 'refuse' | 'dismiss'
export const RELAY_ANSWERS: readonly RelayAnswer[] = ['once', 'session', 'refuse', 'dismiss']

export interface ConsentAsk { id: string; question: string; command: string; at: number }

function relayDir(sid: string): string {
  return join(paths.sessionDir('opencode', sid), RELAY_DIR)
}

function askFile(sid: string, id: string): string {
  return join(relayDir(sid), `ask-${id}.json`)
}

function answerFile(sid: string, id: string): string {
  return join(relayDir(sid), `answer-${id}.json`)
}

function valid(sid: string, id?: string): boolean {
  return paths.isValidSessionId(sid) && (id === undefined || ASK_ID.test(id))
}

function anyTuiFile(): string {
  return join(paths.stateDir(), 'opencode-tui.json')
}

function fresh(file: string, now: number): boolean {
  const r = readJsonSafeSync<{ at?: unknown }>(file)
  const at = r.ok ? r.value?.at : undefined
  return typeof at === 'number' && now - at <= TUI_FRESH_MS && at - now <= TUI_FRESH_MS
}

export function writeTuiBeat(sid: string | undefined, now: number, pid: number): void {
  const beat = JSON.stringify({ at: now, pid }) + '\n'
  ensureDirSync(paths.stateDir())
  atomicWriteSync(anyTuiFile(), beat)
  if (sid === undefined || !valid(sid)) return
  ensureDirSync(relayDir(sid))
  atomicWriteSync(join(relayDir(sid), 'tui.json'), beat)
}

export function tuiPresent(sid: string, now: number): boolean {
  return valid(sid) && fresh(join(relayDir(sid), 'tui.json'), now)
}

export function anyTuiPresent(now: number): boolean {
  return fresh(anyTuiFile(), now)
}

export function postAsk(sid: string, ask: ConsentAsk): boolean {
  if (!valid(sid, ask.id)) return false
  ensureDirSync(relayDir(sid))
  atomicWriteSync(askFile(sid, ask.id), JSON.stringify(ask) + '\n')
  return true
}

function parseAsk(raw: unknown, id: string): ConsentAsk | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  if (o['id'] !== id || typeof o['question'] !== 'string' || typeof o['command'] !== 'string' || typeof o['at'] !== 'number') return undefined
  return { id, question: o['question'], command: o['command'], at: o['at'] }
}

export function askOpen(sid: string, id: string): boolean {
  if (!valid(sid, id)) return false
  return readJsonSafeSync<unknown>(askFile(sid, id)).ok && readAnswer(sid, id) === undefined
}

export function openAsks(sid: string): ConsentAsk[] {
  if (!valid(sid)) return []
  let names: string[]
  try { names = readdirSync(relayDir(sid)) } catch { return [] }
  const out: ConsentAsk[] = []
  for (const name of names.sort()) {
    const m = /^ask-([a-z0-9-]+)\.json$/.exec(name)
    const id = m?.[1]
    if (id === undefined || !ASK_ID.test(id) || readAnswer(sid, id) !== undefined) continue
    const r = readJsonSafeSync<unknown>(askFile(sid, id))
    const ask = r.ok ? parseAsk(r.value, id) : undefined
    if (ask !== undefined) out.push(ask)
  }
  return out.sort((a, b) => a.at - b.at)
}

export function answerAsk(sid: string, id: string, answer: RelayAnswer, now: number): boolean {
  if (!valid(sid, id) || !RELAY_ANSWERS.includes(answer) || !readJsonSafeSync<unknown>(askFile(sid, id)).ok) return false
  let fd: number | undefined
  try {
    fd = openSync(answerFile(sid, id), 'wx', 0o600)
    writeSync(fd, JSON.stringify({ answer, at: now }) + '\n')
    return true
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function readAnswer(sid: string, id: string): RelayAnswer | undefined {
  if (!valid(sid, id)) return undefined
  const r = readJsonSafeSync<{ answer?: unknown }>(answerFile(sid, id))
  const a = r.ok ? r.value?.answer : undefined
  return RELAY_ANSWERS.includes(a as RelayAnswer) ? a as RelayAnswer : undefined
}

export function clearAsk(sid: string, id: string): void {
  if (!valid(sid, id)) return
  for (const f of [askFile(sid, id), answerFile(sid, id)]) rmSync(f, { force: true })
}
