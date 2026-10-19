import { join } from 'node:path'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../../../engine/fsx'
import * as paths from '../../../engine/paths'
import type { TuiToastVariant } from './types'

const HARNESS = 'opencode' as const
const KEEP = 20
export const FIRST_SIGHT_MS = 30_000

export interface BoardNotice { seq: number; at: number; text: string; variant: TuiToastVariant }
interface Board { v: 1; items: BoardNotice[] }

export function boardFile(sid: string): string {
  return join(paths.sessionDir(HARNESS, sid), 'notices.json')
}

function readBoard(sid: string): Board {
  const r = readJsonSafeSync<Board>(boardFile(sid))
  if (!r.ok || r.value === null || typeof r.value !== 'object' || !Array.isArray(r.value.items)) return { v: 1, items: [] }
  const items = r.value.items.filter(i => i !== null && typeof i === 'object' && typeof i.seq === 'number' && typeof i.at === 'number' && typeof i.text === 'string')
  return { v: 1, items }
}

export function postNotice(sid: string, text: string, variant: TuiToastVariant, now: number): void {
  if (!paths.isValidSessionId(sid) || text.trim() === '') return
  const board = readBoard(sid)
  const seq = (board.items.at(-1)?.seq ?? 0) + 1
  board.items = [...board.items, { seq, at: now, text: text.trim(), variant }].slice(-KEEP)
  ensureDirSync(paths.sessionDir(HARNESS, sid))
  atomicWriteSync(boardFile(sid), JSON.stringify(board) + '\n')
}

export class NoticeReader {
  private readonly seen = new Map<string, number>()

  take(sid: string | undefined, now: number): BoardNotice[] {
    if (sid === undefined || !paths.isValidSessionId(sid)) return []
    const items = readBoard(sid).items
    const last = this.seen.get(sid)
    const fresh = last === undefined ? items.filter(i => now - i.at <= FIRST_SIGHT_MS) : items.filter(i => i.seq > last)
    const top = items.at(-1)?.seq
    if (top !== undefined) {
      if (this.seen.size >= 64 && !this.seen.has(sid)) this.seen.clear()
      this.seen.set(sid, top)
    } else if (last === undefined) this.seen.set(sid, 0)
    return fresh
  }
}
