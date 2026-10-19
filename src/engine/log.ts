import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { logFile, logsDir } from './paths'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
export const LOG_MAX_BYTES = 5 * 1024 * 1024

function threshold(): number {
  const v = process.env['BURACLE_LOG_LEVEL']
  return v !== undefined && v in RANK ? RANK[v as LogLevel] : RANK.info
}

function serializable(data: unknown): unknown {
  if (data instanceof Error) return { name: data.name, message: data.message, stack: data.stack }
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(data)) out[k] = v instanceof Error ? serializable(v) : v
    return out
  }
  return data
}

export function rotate(file: string, maxBytes = LOG_MAX_BYTES, measured?: { size: number, ino: number }): void {
  let st: { size: number, ino: number }
  try { st = measured ?? statSync(file) } catch { return }
  if (st.size <= maxBytes) return
  const mine = `${file}.${process.pid}.rotating`
  try { renameSync(file, mine) } catch { return }
  try {
    if (statSync(mine).ino === st.ino) renameSync(mine, `${file}.1`)
    else renameSync(mine, file)
  } catch {  }
}

export function log(level: LogLevel, msg: string, data?: unknown): void {
  if (RANK[level] < threshold()) return
  try {
    const file = logFile()
    mkdirSync(logsDir(), { recursive: true })
    rotate(file)
    const line: Record<string, unknown> = { ts: new Date().toISOString(), level, pid: process.pid, msg }
    if (data !== undefined) line['data'] = serializable(data)
    let text: string
    try { text = JSON.stringify(line) } catch { text = JSON.stringify({ ts: line['ts'], level, pid: process.pid, msg, data: '[unserializable]' }) }
    appendFileSync(file, text + '\n', { mode: 0o600 })
  } catch {
  }
}
