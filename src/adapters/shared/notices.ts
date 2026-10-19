import { closeSync, mkdirSync, openSync, readdirSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness } from '../../core/events'
import { noticeTexts, pendingNotices, type Notice, type NoticeTexts } from '../../core/notices'
import { readJsonSafeSync } from '../../engine/fsx'
import { log } from '../../engine/log'
import * as paths from '../../engine/paths'

export function noticesOff(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env['BURACLE_NO_NOTICES'] === '1' || env['BURACLE_MEMORY_RUNNER'] === '1'
}

export function runtimeVersion(repoRoot: string): string | undefined {
  const r = readJsonSafeSync<{ version?: unknown }>(join(repoRoot, 'package.json'))
  const v = r.ok ? r.value?.version : undefined
  return typeof v === 'string' && v !== '' ? v : undefined
}

function ackedIds(dir: string): Set<string> {
  try { return new Set(readdirSync(dir).filter(n => n.endsWith('.ack')).map(n => n.slice(0, -4))) } catch { return new Set() }
}

export function claimNotices(list: readonly Notice[] | undefined, o: { version: string | undefined, nowMs: number, harness: Harness }): Notice[] {
  if (noticesOff() || o.version === undefined || list === undefined || list.length === 0) return []
  const dir = paths.noticesDir()
  const pending = pendingNotices(list, { version: o.version, nowMs: o.nowMs, acked: ackedIds(dir) })
  if (pending.length === 0) return []
  try { mkdirSync(dir, { recursive: true }) } catch (e) {
    log('warn', 'notices: cannot create the acknowledgement folder; nothing is shown', { error: e })
    return []
  }
  const claimed: Notice[] = []
  for (const n of pending) {
    try {
      const fd = openSync(join(dir, `${n.id}.ack`), 'wx', 0o600)
      try { writeSync(fd, `${JSON.stringify({ at: o.nowMs, version: o.version, harness: o.harness })}\n`) } finally { closeSync(fd) }
      claimed.push(n)
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') log('warn', 'notices: cannot record a notice as shown; it is skipped', { id: n.id, error: e })
    }
  }
  return claimed
}

export function startupNotices(list: readonly Notice[] | undefined, o: { version: string | undefined, nowMs: number, harness: Harness }): NoticeTexts | undefined {
  return noticeTexts(claimNotices(list, o))
}
