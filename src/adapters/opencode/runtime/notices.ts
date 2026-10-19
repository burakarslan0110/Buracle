import { noticesOff, startupNotices } from '../../shared/notices'
import type { BakedData } from './baked'
import { errText } from './util'

type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void

export function openingNotice(baked: Pick<BakedData, 'notices' | 'version'>, nowMs: number, notify: (title: string, message: string) => void, logFn: LogFn): string | undefined {
  if (noticesOff()) return undefined
  try {
    const n = startupNotices(baked.notices, { version: baked.version, nowMs, harness: 'opencode' })
    if (n === undefined) return undefined
    notify('Buracle', n.user)
    return n.model
  } catch (e) {
    logFn('warn', 'startup notices failed', { error: errText(e) })
    return undefined
  }
}
