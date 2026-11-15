import { statSync } from 'node:fs'
import type { BandInput, BandView } from '../../../core/flow/band'
import { bandRows, bandView } from '../../../core/flow/band'
import type { Segment } from '../../../core/status/model'
import * as paths from '../../../engine/paths'
import { bandInputFor, flowPath } from '../../../workflow/flow'
import { statePath } from '../../../workflow/session-store'

const HARNESS = 'opencode' as const

const SIDEBAR_FROM_COLUMNS = 120
const SIDEBAR_COLUMNS = 42
const MAIN_PADDING = 4

export function estimatedWidth(terminalColumns: number): number {
  const w = Math.floor(Number.isFinite(terminalColumns) ? terminalColumns : 0)
  return Math.max(0, w - MAIN_PADDING - (w > SIDEBAR_FROM_COLUMNS ? SIDEBAR_COLUMNS : 0))
}

export function bandLines(view: BandView, columns: number, emoji = true): Segment[][] {
  return bandRows(view, columns, 3, emoji)
}

function mtime(file: string | undefined): string {
  if (file === undefined) return '-'
  try { const st = statSync(file); return `${st.mtimeMs}:${st.size}` } catch { return '-' }
}

interface Cached { key: string; input: BandInput }

export class BandFeeder {
  private readonly cache = new Map<string, Cached>()

  constructor(private readonly now: () => number = Date.now) {}

  private key(sid: string, planPath: string | undefined): string {
    return [mtime(flowPath(HARNESS, sid)), mtime(statePath(HARNESS, sid)), planPath ?? '', mtime(planPath)].join('|')
  }

  view(sid: string | undefined, foldAfterSec: number): BandView {
    const hidden: BandView = { visible: false, breadcrumb: [], status: 'running', phases: [], agents: [] }
    if (sid === undefined || !paths.isValidSessionId(sid)) return hidden
    const now = this.now()
    try {
      const prev = this.cache.get(sid)
      const key = this.key(sid, prev?.input.plan?.path)
      let input: BandInput
      if (prev !== undefined && prev.key === key) input = prev.input
      else {
        input = bandInputFor(HARNESS, sid, now, foldAfterSec)
        if (this.cache.size >= 32) this.cache.clear()
        this.cache.set(sid, { key: this.key(sid, input.plan?.path), input })
      }
      return bandView({ ...input, nowMs: now, foldAfterSec })
    } catch {
      return hidden
    }
  }
}
