import { backgroundWait } from '../../../core/plan/background'
import type { ToolResultShape } from './types'

export interface BackgroundJob { type: 'shell' | 'subagent', status: 'running', at: number, command?: string }

export const BACKGROUND_MAX_AGE_MS = 6 * 60 * 60 * 1000

function rec(x: unknown): Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {}
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' && x !== '' ? x : undefined
}

export function backgroundStart(tool: string, input: Record<string, unknown>, result: ToolResultShape, at: number): [string, BackgroundJob] | undefined {
  const out = rec(result.output)
  const meta = rec(result.metadata)
  if ((out['status'] ?? meta['status']) !== 'running') return undefined
  if (tool === 'shell') {
    const id = str(out['shellID']) ?? str(meta['shellID'])
    if (id === undefined) return undefined
    const command = str(input['command'])
    return [`shell:${id}`, { type: 'shell', status: 'running', at, ...(command !== undefined ? { command } : {}) }]
  }
  if (tool === 'subagent') {
    const id = str(out['sessionID'])
    return id === undefined ? undefined : [`subagent:${id}`, { type: 'subagent', status: 'running', at }]
  }
  return undefined
}

export function backgroundEnd(metadata: unknown): string | undefined {
  const m = rec(metadata)
  if (m['state'] === 'running') return undefined
  if (m['source'] === 'shell') {
    const id = str(m['shellID'])
    return id === undefined ? undefined : `shell:${id}`
  }
  if (m['source'] === 'subagent') {
    const id = str(m['childID'])
    return id === undefined ? undefined : `subagent:${id}`
  }
  return undefined
}

export function waitsInBackground(jobs: ReadonlyMap<string, BackgroundJob> | undefined, lastMessage: string | undefined, now: number): boolean {
  if (jobs === undefined || jobs.size === 0) return false
  const live = [...jobs.values()].filter(j => now - j.at >= 0 && now - j.at < BACKGROUND_MAX_AGE_MS)
  return backgroundWait(lastMessage, live)
}
